import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ControlApi, ControlError, controlEnvironment, leaseHeaders, type ControlLease } from '../src/control-api.js';
import { controlEventSummary } from '../src/control-events.js';
import { executeLocalHunt } from '../src/local-runner.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const help = `Hound local worker (owned fixture jobs only)

  ./hound worker
  ./hound worker --once
  ./hound worker --headed

The worker leases durable jobs, runs fresh loopback fixture pairs, and heartbeats its lease.
It requires OPENAI_API_KEY plus the ignored .hound/control-plane.env worker credential.
`;

async function processLease(api: ControlApi, lease: ControlLease, apiKey: string, headed: boolean, globalSignal: AbortSignal) {
  const headers = leaseHeaders(lease);
  await api.request(`/v1/jobs/${lease.jobId}/start`, { method: 'POST', headers });
  console.log(`Started run ${lease.runId} (attempt ${lease.attempt}).`);
  const lost = new AbortController(); let active = true; let expiresAt = Date.parse(lease.leaseExpiresAt);
  const signal = AbortSignal.any([globalSignal, lost.signal]);
  const heartbeatStop = new AbortController();
  const heartbeatSignal = AbortSignal.any([signal, heartbeatStop.signal]);
  const heartbeat = (async () => {
    while (active && !heartbeatSignal.aborted) {
      const delay = Math.max(250, Math.min(10_000, Math.floor((expiresAt - Date.now()) / 3)));
      try { await wait(delay, undefined, { signal: heartbeatSignal }); } catch { break; }
      if (!active || heartbeatSignal.aborted) break;
      try {
        const response = await api.request<{ leaseExpiresAt: string }>(`/v1/jobs/${lease.jobId}/heartbeat`, { method: 'POST', headers });
        expiresAt = Date.parse(response!.leaseExpiresAt);
      } catch { lost.abort(); break; }
    }
  })();
  let sequence = 0;
  const sendEvent = async (event: { type: string; at: string; [key: string]: unknown }) => {
    const text = controlEventSummary(event); if (!text) return;
    const workerEventId = `event-${lease.attempt}-${sequence++}`;
    try {
      await api.request(`/v1/jobs/${lease.jobId}/events`, { method: 'POST', headers,
        body: JSON.stringify({ workerEventId, type: event.type, summary: text, occurredAt: event.at }) });
    } catch (error) { lost.abort(); throw error; }
  };
  let execution;
  try {
    execution = await executeLocalHunt({ root, apiKey, caseName: lease.case, maxCostUsd: lease.maxCostUsd, maxTrials: lease.maxTrials,
      headed, signal, runId: lease.runId, attempt: lease.attempt, emit: sendEvent });
    if (signal.aborted) {
      console.error(`Stopped run ${lease.runId} after its lease or worker process was cancelled.`); return;
    }
    if (!execution.result || execution.failure) {
      await api.request(`/v1/jobs/${lease.jobId}/complete`, { method: 'POST', headers,
        body: JSON.stringify({ state: 'failed', outcome: '', reason: (execution.failure ?? 'worker_execution_failed').slice(0, 120) }) });
      console.error(`Run ${lease.runId} failed: ${execution.failure ?? 'worker_execution_failed'}.`); return;
    }
    if (execution.result.outcome === 'cancelled') return;
    const upload = async (path: string, value: unknown) => {
      const body = JSON.stringify(value);
      const sha256 = createHash('sha256').update(body).digest('hex');
      await api.request(path, { method: 'PUT', headers: { ...headers, 'X-Hound-Content-SHA256': sha256 }, body });
    };
    if (execution.plan) await upload(`/v1/jobs/${lease.jobId}/artifacts/replay_plan`, execution.plan);
    if (!execution.projection) throw new ControlError('missing_result_projection');
    await upload(`/v1/jobs/${lease.jobId}/result`, execution.projection);
    await api.request(`/v1/jobs/${lease.jobId}/complete`, { method: 'POST', headers,
      body: JSON.stringify({ state: 'completed', outcome: execution.result.outcome, reason: '' }) });
    console.log(`Completed run ${lease.runId}: ${execution.result.outcome}.`);
  } finally { active = false; heartbeatStop.abort(); await heartbeat; }
}

async function main() {
  let args;
  try { args = parseArgs({ options: { once: { type: 'boolean' }, headed: { type: 'boolean' }, 'poll-ms': { type: 'string' }, help: { type: 'boolean' } }, strict: true }); }
  catch { throw new ControlError('invalid_arguments'); }
  if (args.values.help) { console.log(help); return; }
  const pollMs = args.values['poll-ms'] === undefined ? 1_000 : Number(args.values['poll-ms']);
  if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 30_000) throw new ControlError('invalid_poll_interval');
  const apiKey = process.env.OPENAI_API_KEY?.trim() ?? '';
  if (!apiKey) throw new ControlError('missing_provider_key');
  const environment = await controlEnvironment(root);
  if (environment.workerKey.length < 32) throw new ControlError('missing_worker_key');
  const api = new ControlApi(environment.baseURL);
  await api.health();
  const controller = new AbortController(); const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const workerId = `${hostname().replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 70)}-${process.pid}`;
  console.log(`Worker ${workerId} connected to ${environment.baseURL}.`);
  try {
    while (!controller.signal.aborted) {
      const lease = await api.request<ControlLease>('/v1/jobs/lease', { method: 'POST', expected: [200, 204],
        headers: { 'X-Hound-Worker-Key': environment.workerKey }, body: JSON.stringify({ workerId }) });
      if (lease) await processLease(api, lease, apiKey, !!args.values.headed, controller.signal);
      else if (args.values.once) { console.log('No queued work.'); return; }
      if (!lease) { try { await wait(pollMs, undefined, { signal: controller.signal }); } catch { /* Worker was asked to stop. */ } }
      if (args.values.once) return;
    }
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

main().catch((error) => {
  const code = error instanceof ControlError ? error.code : 'worker_failed';
  console.error(`Hound worker stopped: ${code}.`); process.exitCode = 1;
});
