import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from '@playwright/test';
import { startFixture } from '../../../apps/fixture/src/server.js';
import { BrowserExperiment, type ReplayPlan } from '../src/experiment.js';
import { minimize, type MinimizationResult } from '../src/minimizer.js';
import { exportPlaywrightRegression } from '../src/exporter.js';
import { RunJournal } from '../src/journal.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const help = `Hound local paired minimizer (owned loopback fixtures only; zero model calls)

  ./hound minimize --run-id <positive-run-id>

Options: --run-id <id>, --confirmations <1..5>, --headed, --help
Reads one owner-private verified plan under .hound/runs, starts fresh local fixture pairs,
writes a private minimization journal, and exports generated-tests/removed-member-write.spec.ts.
`;
const runPattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function atomicSource(path: string, source: string) {
  await mkdir(join(root, 'generated-tests'), { recursive: true, mode: 0o755 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(source); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
}

async function main() {
  let args;
  try { args = parseArgs({ options: { 'run-id': { type: 'string' }, confirmations: { type: 'string' }, headed: { type: 'boolean' }, help: { type: 'boolean' } }, strict: true }); }
  catch { console.error('Invalid arguments. Run ./hound minimize --help.'); process.exitCode = 2; return; }
  if (args.values.help) { console.log(help); return; }
  const runId = args.values['run-id'] ?? '';
  const confirmations = args.values.confirmations === undefined ? 3 : Number(args.values.confirmations);
  if (!runPattern.test(runId) || !Number.isInteger(confirmations) || confirmations < 1 || confirmations > 5) {
    console.error('A valid local run ID and confirmations from 1 to 5 are required.'); process.exitCode = 2; return;
  }
  if (!existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? chromium.executablePath())) {
    console.error('Chromium is missing. Run npm run setup:browser.'); process.exitCode = 2; return;
  }
  const directory = join(root, '.hound/runs', runId);
  const paths = { config: join(directory, 'config.json'), result: join(directory, 'result.json'), plan: join(directory, 'plan.json') };
  try {
    for (const path of Object.values(paths)) {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 2 * 1024 * 1024) throw new Error('invalid_source_record');
    }
  } catch { console.error('The run is missing small regular config, result, or plan records.'); process.exitCode = 2; return; }
  let sourceConfig: any; let sourceResult: any; let plan: ReplayPlan;
  try {
    sourceConfig = JSON.parse(await readFile(paths.config, 'utf8'));
    sourceResult = JSON.parse(await readFile(paths.result, 'utf8'));
    plan = JSON.parse(await readFile(paths.plan, 'utf8'));
  } catch { console.error('The source run records are not valid JSON.'); process.exitCode = 2; return; }
  if (sourceConfig.case !== 'positive' || sourceResult.outcome !== 'candidate_only_violation' || sourceResult.planId !== plan.id) {
    console.error('Minimization requires a verified candidate-only positive run and its exact saved plan.'); process.exitCode = 2; return;
  }
  const credentials = { alice: `alice-${randomBytes(24).toString('hex')}`, bob: `bob-${randomBytes(24).toString('hex')}` };
  const keys = { baseline: randomBytes(32).toString('hex'), candidate: randomBytes(32).toString('hex') };
  const journal = await RunJournal.create(join(root, '.hound/minimizations'), [...Object.values(credentials), ...Object.values(keys)]);
  let revision = 'unknown';
  try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Source archives need not have Git metadata. */ }
  await journal.write('config', { version: 1, revision, sourceRunId: runId, sourcePlanId: plan.id, originalLength: plan.steps.length,
    maxAttempts: 80, deadlineMs: 600_000, confirmations, modelCalls: 0, createdAt: new Date().toISOString() });
  console.log(`Minimizing verified ${plan.steps.length}-step plan with fresh local pairs; model calls: 0.`);
  console.log(`Private minimization records: ${journal.directory}`);
  const controller = new AbortController(); const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  let baseline: Awaited<ReturnType<typeof startFixture>> | undefined; let candidate: typeof baseline; let browser: Browser | undefined;
  let result: MinimizationResult | undefined; let failure: string | undefined;
  try {
    baseline = await startFixture({ mode: 'baseline', credentials, harnessKey: keys.baseline });
    candidate = await startFixture({ mode: 'stale-write', credentials, harnessKey: keys.candidate });
    browser = await chromium.launch({ headless: !args.values.headed, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    result = await minimize({ plan, signal: controller.signal, confirmations,
      factory: { open: (target, options) => BrowserExperiment.open(browser!, { ...(target === 'baseline' ? baseline! : candidate!),
        harnessKey: keys[target], credentials, ...options }) },
      emit: async event => {
        await journal.append(event);
        if (event.type === 'reduction_attempt') {
          const attempt = event.attempt as { index: number; beforeLength: number; candidateLength: number; accepted: boolean; reason: string };
          console.log(`Attempt ${attempt.index + 1}: ${attempt.beforeLength} -> ${attempt.candidateLength} ${attempt.accepted ? 'accepted' : `kept (${attempt.reason})`}.`);
        }
        if (event.type === 'minimization_confirmation' && Number((event.confirmation as any).index) >= 0) {
          console.log(`Confirmation ${Number((event.confirmation as any).index) + 1}: ${(event.confirmation as any).outcome}.`);
        }
      } });
  } catch { failure = 'minimizer_setup_failed'; }
  finally {
    const cleanup = await Promise.allSettled([browser?.close(), baseline?.close(), candidate?.close()]);
    if (cleanup.some(item => item.status === 'rejected')) failure = 'cleanup_failed';
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
  if (!result) {
    await journal.write('result', { version: 1, outcome: 'inconclusive', reason: failure ?? 'minimizer_setup_failed', modelCalls: 0 });
    console.log(`Outcome: inconclusive (${failure ?? 'minimizer_setup_failed'}).`); process.exitCode = 1; return;
  }
  if (failure) { result.outcome = 'inconclusive'; result.reason = failure; result.deletionMinimal = false; }
  let verified = ['minimized', 'unchanged'].includes(result.outcome) && result.deletionMinimal && result.confirmations.length === confirmations &&
    result.confirmations.every(item => item.outcome === 'candidate_only_violation');
  let generated: { path: string; sha256: string } | undefined;
  if (verified) {
    try {
      const source = exportPlaywrightRegression(result.plan);
      for (const secret of [...Object.values(credentials), ...Object.values(keys), directory, journal.directory]) if (source.includes(secret)) throw new Error('secret_in_generated_test');
      await journal.write('plan', result.plan);
      const output = join(root, 'generated-tests/removed-member-write.spec.ts');
      await atomicSource(output, source);
      generated = { path: 'generated-tests/removed-member-write.spec.ts', sha256: createHash('sha256').update(source).digest('hex') };
    } catch {
      result.outcome = 'inconclusive'; result.reason = 'export_failed'; result.deletionMinimal = false; verified = false;
    }
  }
  const { plan: _plan, ...summary } = result;
  await journal.write('result', { ...summary, modelCalls: 0, generated });
  console.log(`Outcome: ${result.outcome}; ${result.originalLength} -> ${result.minimizedLength} steps; deletion-minimal: ${result.deletionMinimal}.`);
  if (generated) console.log(`Generated regression: ${generated.path} (${generated.sha256.slice(0, 12)}…).`);
  process.exitCode = verified ? 0 : result.outcome === 'cancelled' ? 130 : 1;
}

main().catch(() => { console.error('Minimization stopped because local validation, record writing, or export failed. No reduced result is implied.'); process.exitCode = 1; });
