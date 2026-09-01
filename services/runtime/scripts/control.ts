import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { relative } from 'node:path';
import { chromium } from '@playwright/test';
import { ControlApi, ControlError, controlEnvironment, type ControlRun } from '../src/control-api.js';
import { MODEL } from '../src/openai-policy.js';
import { reportOutput, writeHtml } from '../src/report-files.js';
import { renderHtmlReport, terminalSummary } from '../src/report.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const runPattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f-]{36}$/;
const help = `Hound durable control client

  ./hound hunt --case positive|negative --max-cost-usd <amount> [--trials 1..3] [--detach [--json]]
  ./hound hunt --preflight
  ./hound runs [--limit 20] [--json]
  ./hound status <run-id> [--json]
  ./hound logs <run-id> [--follow] [--after <sequence>]
  ./hound cancel <run-id>
  ./hound show --run-id <run-id> [--json]
  ./hound report --run-id <run-id> [--output <workspace-relative.html>]

hunt submits to the loopback control plane and streams by default. --detach prints the run ID
and returns. A separate ./hound worker process executes queued owned-fixture jobs.
`;

function renderRun(run: ControlRun) {
  const lines = [`Run: ${run.id}`, `State: ${run.status}`, `Job: ${run.job.status} (attempt ${run.job.attempt}/${run.job.maxAttempts})`];
  if (run.outcome) lines.push(`Outcome: ${run.outcome}`);
  if (run.reason) lines.push(`Reason: ${run.reason}`);
  return lines.join('\n');
}

async function stream(api: ControlApi, runId: string, after: number, signal?: AbortSignal) {
  let response: Response;
  try { response = await fetch(`${api.baseURL}/v1/runs/${encodeURIComponent(runId)}/events?follow=true&after=${after}`, { headers: { Accept: 'text/event-stream' }, signal, redirect: 'error' }); }
  catch (error) { if (signal?.aborted) return; throw new ControlError('control_unavailable'); }
  if (!response.ok || !response.body) throw new ControlError('event_stream_failed', response.status);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    pending += chunk.value.replaceAll('\r\n', '\n');
    let boundary;
    while ((boundary = pending.indexOf('\n\n')) >= 0) {
      const block = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
      if (block.startsWith(':')) continue;
      const data = block.split('\n').find(line => line.startsWith('data: '))?.slice(6);
      if (!data) continue;
      const event = JSON.parse(data) as { sequence: number; summary: string };
      after = event.sequence;
      console.log(`[${String(event.sequence).padStart(4, '0')}] ${event.summary}`);
    }
  }
  return after;
}

function runIdFrom(positionals: string[]) {
  const value = positionals[0] ?? '';
  if (!runPattern.test(value) || positionals.length !== 1) throw new ControlError('invalid_run_id');
  return value;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help' || command === '-h') { console.log(help); return; }
  if (command === 'hunt') {
    let args;
    try { args = parseArgs({ args: rest, options: { case: { type: 'string' }, 'max-cost-usd': { type: 'string' }, trials: { type: 'string' }, detach: { type: 'boolean' }, preflight: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean' } }, strict: true }); }
    catch { throw new ControlError('invalid_arguments'); }
    if (args.values.help) { console.log(help); return; }
    const environment = await controlEnvironment(root);
    const api = new ControlApi(environment.baseURL);
    const caseName = args.values.case ?? 'positive';
    const costText = args.values['max-cost-usd']; const maxCostUsd = costText === undefined ? undefined : Number(costText);
    const maxTrials = args.values.trials === undefined ? 3 : Number(args.values.trials);
    const browserInstalled = existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? chromium.executablePath());
    if (args.values.preflight) {
      let controlReady = false; try { controlReady = (await api.health())?.status === 'ready'; } catch { /* Report false below. */ }
      console.log(JSON.stringify({ controlReady, controlUrl: api.baseURL, workerCredentialsConfigured: environment.workerKey.length >= 32,
        providerKeyConfigured: !!process.env.OPENAI_API_KEY?.trim(), browserInstalled, model: MODEL, providerRequestsMade: 0 }, null, 2));
      process.exitCode = controlReady ? 0 : 1; return;
    }
    if (args.values.json && !args.values.detach) throw new ControlError('json_requires_detach');
    if (!['positive', 'negative'].includes(caseName) || !Number.isInteger(maxTrials) || maxTrials < 1 || maxTrials > 3 || costText === undefined ||
      !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(costText) || !Number.isFinite(maxCostUsd) || maxCostUsd! <= 0 || maxCostUsd! > 10) throw new ControlError('invalid_run');
    const run = (await api.createRun({ case: caseName, maxCostUsd: maxCostUsd!, maxTrials }))!;
    if (args.values.detach) {
      console.log(args.values.json ? JSON.stringify(run, null, 2) : `Queued run ${run.id}.`);
      return;
    }
    console.log(`Queued run ${run.id}; waiting for a worker.`);
    const controller = new AbortController(); let interrupted = false; let cancellation: Promise<void> | undefined;
    const stop = () => {
      if (interrupted) return; interrupted = true;
      cancellation = api.cancel(run.id).then(() => undefined).finally(() => controller.abort());
    };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try { await stream(api, run.id, 0, controller.signal); }
    finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    if (cancellation) {
      try { await cancellation; } catch { throw new ControlError('cancellation_uncertain'); }
    }
    const terminal = await api.run(run.id);
    if (!terminal) throw new ControlError('missing_run');
    console.log(renderRun(terminal));
    process.exitCode = terminal.status === 'cancelled' ? 130 : terminal.status !== 'completed' || ['inconclusive', 'provider_stopped'].includes(terminal.outcome ?? '') ? 1 : 0;
    return;
  }
  const environment = await controlEnvironment(root);
  const api = new ControlApi(environment.baseURL);
  if (command === 'runs') {
    const args = parseArgs({ args: rest, options: { json: { type: 'boolean' }, limit: { type: 'string' } }, strict: true });
    const limit = args.values.limit === undefined ? 20 : Number(args.values.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ControlError('invalid_limit');
    const runs = (await api.runs(limit))?.runs ?? [];
    if (args.values.json) { console.log(JSON.stringify(runs, null, 2)); return; }
    if (!runs.length) { console.log('No durable runs.'); return; }
    console.log('RUN ID'.padEnd(64) + 'STATE'.padEnd(12) + 'OUTCOME');
    for (const run of runs) console.log(run.id.padEnd(64) + run.status.padEnd(12) + (run.outcome ?? run.reason ?? '—'));
    return;
  }
  if (command === 'status') {
    const args = parseArgs({ args: rest, options: { json: { type: 'boolean' } }, allowPositionals: true, strict: true });
    const run = await api.run(runIdFrom(args.positionals));
    console.log(args.values.json ? JSON.stringify(run, null, 2) : renderRun(run!)); return;
  }
  if (command === 'logs') {
    const args = parseArgs({ args: rest, options: { follow: { type: 'boolean' }, after: { type: 'string' } }, allowPositionals: true, strict: true });
    const runId = runIdFrom(args.positionals); const after = args.values.after === undefined ? 0 : Number(args.values.after);
    if (!Number.isSafeInteger(after) || after < 0) throw new ControlError('invalid_event_cursor');
    if (args.values.follow) await stream(api, runId, after);
    else {
      const body = await api.request<{ events: { sequence: number; summary: string }[] }>(`/v1/runs/${encodeURIComponent(runId)}/events?after=${after}`);
      for (const event of body?.events ?? []) console.log(`[${String(event.sequence).padStart(4, '0')}] ${event.summary}`);
    }
    return;
  }
  if (command === 'cancel') {
    const args = parseArgs({ args: rest, options: {}, allowPositionals: true, strict: true }); const runId = runIdFrom(args.positionals);
    await api.cancel(runId); console.log(`Cancelled run ${runId}.`); return;
  }
  if (command === 'show' || command === 'report') {
    let args;
    try { args = parseArgs({ args: rest, options: { 'run-id': { type: 'string' }, json: { type: 'boolean' }, output: { type: 'string' } }, strict: true }); }
    catch { throw new ControlError('invalid_arguments'); }
    const runId = args.values['run-id'] ?? '';
    if (!runPattern.test(runId) || (command === 'show' && args.values.output) || (command === 'report' && args.values.json)) throw new ControlError('invalid_arguments');
    const report = await api.result(runId);
    if (!report) throw new ControlError('missing_result');
    if (command === 'show') { console.log(args.values.json ? JSON.stringify(report, null, 2) : terminalSummary(report)); return; }
    if (!report.finding.confirmed) throw new ControlError('report_requires_confirmed_finding');
    let output;
    try {
      output = reportOutput(root, args.values.output, runId);
      await writeHtml(root, output, renderHtmlReport(report));
    } catch (error: any) {
      const code = typeof error?.message === 'string' && /^[a-z_]+$/.test(error.message) ? error.message : 'report_export_failed';
      throw new ControlError(code);
    }
    console.log(`HTML report: ${relative(root, output)}`);
    console.log('The CLI summary and durable result remain the source of truth.');
    return;
  }
  throw new ControlError('unknown_command');
}

main().catch((error) => {
  const code = error instanceof ControlError ? error.code : 'control_client_failed';
  console.error(`Hound stopped: ${code}.`); process.exitCode = 2;
});
