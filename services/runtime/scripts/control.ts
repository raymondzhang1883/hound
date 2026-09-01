import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { ControlApi, ControlError, controlEnvironment, type ControlRun } from '../src/control-api.js';
import { MODEL } from '../src/openai-policy.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const runPattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f-]{36}$/;
const help = `Hound durable control client

  ./hound hunt --case positive|negative --max-cost-usd <amount> [--trials 1..3] [--detach [--json]]
  ./hound hunt --preflight
  ./hound status <run-id> [--json]
  ./hound logs <run-id> [--follow] [--after <sequence>]
  ./hound cancel <run-id>

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
  throw new ControlError('unknown_command');
}

main().catch((error) => {
  const code = error instanceof ControlError ? error.code : 'control_client_failed';
  console.error(`Hound stopped: ${code}.`); process.exitCode = 2;
});
