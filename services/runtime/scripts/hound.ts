import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { lstat, mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { buildReportProjection, renderHtmlReport, reportOutputAncestors, reportRunIdPattern, terminalSummary, type ReportInput, type ReportProjection } from '../src/report.js';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const runRoot = join(root, '.hound/runs');
const minimizationRoot = join(root, '.hound/minimizations');
const help = `Hound CLI (terminal-first local interface)

  ./hound runs [--json] [--limit <1..100>]
  ./hound show --run-id <id> [--json]
  ./hound report --run-id <id> [--output <workspace-relative.html>]

runs and show print sanitized terminal results. report explicitly creates a static,
self-contained HTML artifact. These read-only commands launch no browser, fixture, or model.
Existing execution commands remain npm run hunt and npm run minimize.
`;

async function jsonFile(path: string, optional = false) {
  let metadata;
  try { metadata = await lstat(path); } catch (error: any) { if (optional && error?.code === 'ENOENT') return undefined; throw error; }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 2 * 1024 * 1024) throw new Error('invalid_record_file');
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function source(runId: string): Promise<Omit<ReportInput, 'minimization'>> {
  if (!reportRunIdPattern.test(runId)) throw new Error('invalid_run_id');
  const directory = join(runRoot, runId);
  const [config, result, plan] = await Promise.all([
    jsonFile(join(directory, 'config.json')), jsonFile(join(directory, 'result.json')), jsonFile(join(directory, 'plan.json'), true),
  ]);
  return { runId, config, result, ...(plan === undefined ? {} : { plan }) };
}

async function minimization(runId: string) {
  let entries;
  try { entries = await readdir(minimizationRoot, { withFileTypes: true }); } catch (error: any) { if (error?.code === 'ENOENT') return undefined; throw error; }
  for (const entry of entries.filter(item => item.isDirectory() && reportRunIdPattern.test(item.name)).sort((a, b) => b.name.localeCompare(a.name))) {
    const directory = join(minimizationRoot, entry.name);
    try {
      const [config, result, plan] = await Promise.all([jsonFile(join(directory, 'config.json')), jsonFile(join(directory, 'result.json')), jsonFile(join(directory, 'plan.json'))]);
      if ((config as any)?.sourceRunId === runId && ['minimized', 'unchanged'].includes((result as any)?.outcome)) return { config, result, plan };
    } catch { /* Ignore incomplete or malformed unrelated private minimizations. */ }
  }
  return undefined;
}

async function projection(runId: string, withMinimization: boolean) {
  const input = await source(runId);
  return buildReportProjection({ ...input, ...(withMinimization ? { minimization: await minimization(runId) } : {}) });
}

async function list(limit: number) {
  let entries;
  try { entries = await readdir(runRoot, { withFileTypes: true }); } catch (error: any) { if (error?.code === 'ENOENT') return []; throw error; }
  const reports: ReportProjection[] = [];
  for (const entry of entries.filter(item => item.isDirectory() && reportRunIdPattern.test(item.name)).sort((a, b) => b.name.localeCompare(a.name))) {
    if (reports.length >= limit) break;
    try { reports.push(await projection(entry.name, false)); } catch { /* Listing skips incomplete or malformed run directories. */ }
  }
  return reports;
}

function relativeOutput(value: string | undefined, runId: string) {
  const requested = value ?? `.hound/reports/${runId}.html`;
  if (isAbsolute(requested) || !requested.endsWith('.html') || requested.split(/[\\/]/).some(part => part === '..' || part === '.')) throw new Error('invalid_output_path');
  const output = resolve(root, requested); const within = relative(root, output);
  if (!within || within.startsWith(`..${sep}`) || within === '..') throw new Error('invalid_output_path');
  return output;
}

async function atomicHtml(path: string, html: string) {
  const parent = dirname(path); await mkdir(parent, { recursive: true, mode: 0o700 });
  for (const directory of reportOutputAncestors(root, path)) {
    const metadata = await lstat(directory); if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('unsafe_output_directory');
  }
  try { const existing = await lstat(path); if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('unsafe_output_file'); }
  catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  const temporary = `${path}.${randomUUID()}.tmp`; const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(html); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help' || command === '-h') { console.log(help); return; }
  if (command === 'runs') {
    let args;
    try { args = parseArgs({ args: rest, options: { json: { type: 'boolean' }, limit: { type: 'string' } }, strict: true }); }
    catch { throw new Error('invalid_arguments'); }
    const limit = args.values.limit === undefined ? 20 : Number(args.values.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_limit');
    const reports = await list(limit);
    if (args.values.json) {
      console.log(JSON.stringify(reports.map(report => ({ runId: report.runId, createdAt: report.source.createdAt, case: report.source.case,
        outcome: report.finding.outcome, confirmed: report.finding.confirmed, trials: report.exploration.trials.length,
        modelCalls: report.exploration.accounting.calls, estimatedCostUsd: report.exploration.accounting.estimatedCostUsd })), null, 2));
      return;
    }
    if (!reports.length) { console.log('No completed local runs.'); return; }
    console.log('RUN ID'.padEnd(75) + 'OUTCOME'.padEnd(30) + 'TRIALS  COST');
    for (const report of reports) console.log(report.runId.padEnd(75) + report.finding.outcome.padEnd(30) +
      String(report.exploration.trials.length).padEnd(8) + `$${report.exploration.accounting.estimatedCostUsd.toFixed(4)}`);
    return;
  }
  if (command === 'show' || command === 'report') {
    let args;
    try { args = parseArgs({ args: rest, options: { 'run-id': { type: 'string' }, json: { type: 'boolean' }, output: { type: 'string' } }, strict: true }); }
    catch { throw new Error('invalid_arguments'); }
    const runId = args.values['run-id'] ?? '';
    if (!reportRunIdPattern.test(runId) || (command === 'show' && args.values.output) || (command === 'report' && args.values.json)) throw new Error('invalid_arguments');
    const report = await projection(runId, true);
    if (command === 'show') { console.log(args.values.json ? JSON.stringify(report, null, 2) : terminalSummary(report)); return; }
    if (!report.finding.confirmed) throw new Error('report_requires_confirmed_finding');
    const output = relativeOutput(args.values.output, runId); await atomicHtml(output, renderHtmlReport(report));
    console.log(`HTML report: ${relative(root, output)}`);
    console.log('The CLI summary and private journals remain the source of truth.');
    return;
  }
  throw new Error('unknown_command');
}

main().catch((error: any) => {
  const code = typeof error?.message === 'string' && /^[a-z_]+$/.test(error.message) ? error.message : 'invalid_or_incomplete_record';
  console.error(`Hound CLI stopped: ${code}. Run ./hound --help.`); process.exitCode = 2;
});
