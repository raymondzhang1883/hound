import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { ControlApi, ControlError, controlEnvironment, leaseHeaders, type ControlLease } from '../src/control-api.js';
import { controlEventSummary } from '../src/control-events.js';
import { createDemoPolicy } from '../src/demo-policy.js';
import { executeLocalHunt } from '../src/local-runner.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));

function command(args: string[]) {
  const result = spawnSync('./hound', args, { cwd: root, stdio: 'inherit', env: process.env });
  if (result.error || result.status !== 0) throw new Error(`demo_command_failed_${args[0]}`);
}

function expectSeededRegressionFailure() {
  const result = spawnSync('./hound', ['test-generated'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HOUND_FIXTURE_MODE: 'stale-write' },
  });
  if (result.error || result.status === 0) throw new Error('seeded_candidate_was_not_rejected');
  console.log('Generated regression rejected the seeded candidate as expected.');
}

async function upload(api: ControlApi, lease: ControlLease, path: string, value: unknown) {
  const body = JSON.stringify(value);
  const sha256 = createHash('sha256').update(body).digest('hex');
  await api.request(path, { method: 'PUT', headers: { ...leaseHeaders(lease), 'X-Hound-Content-SHA256': sha256 }, body });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: ./hound demo\n\nRuns the complete local workflow with authored simulated model responses and zero provider calls.');
    return;
  }
  if (args.length) throw new Error('invalid_arguments');
  if (!existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? chromium.executablePath())) {
    throw new Error('chromium_missing_run_npm_run_setup_browser');
  }

  console.log('Hound credential-free demo');
  console.log('Provider responses: authored local simulation; external model requests: 0.');
  console.log('Starting the durable loopback control plane...');
  command(['control', 'up']);

  const environment = await controlEnvironment(root);
  if (environment.workerKey.length < 32) throw new ControlError('missing_worker_key');
  const api = new ControlApi(environment.baseURL);
  await api.health();
  const run = (await api.createRun({ case: 'positive', maxCostUsd: 2, maxTrials: 1 }))!;
  const lease = await api.request<ControlLease>('/v1/jobs/lease', {
    method: 'POST',
    expected: [200],
    headers: { 'X-Hound-Worker-Key': environment.workerKey },
    body: JSON.stringify({ workerId: `local-demo-${process.pid}`, runId: run.id }),
  });
  if (!lease || lease.runId !== run.id) throw new Error('demo_targeted_lease_failed');
  const headers = leaseHeaders(lease);
  await api.request(`/v1/jobs/${lease.jobId}/start`, { method: 'POST', headers });
  console.log(`Running owned-fixture experiment ${run.id}...`);

  let active = true;
  let expiresAt = Date.parse(lease.leaseExpiresAt);
  const stopHeartbeat = new AbortController();
  const heartbeat = (async () => {
    while (active && !stopHeartbeat.signal.aborted) {
      const delay = Math.max(250, Math.min(10_000, Math.floor((expiresAt - Date.now()) / 3)));
      try { await wait(delay, undefined, { signal: stopHeartbeat.signal }); } catch { break; }
      if (!active || stopHeartbeat.signal.aborted) break;
      const response = await api.request<{ leaseExpiresAt: string }>(`/v1/jobs/${lease.jobId}/heartbeat`, { method: 'POST', headers });
      expiresAt = Date.parse(response!.leaseExpiresAt);
    }
  })();

  let completed = false;
  try {
    let sequence = 0;
    const demo = createDemoPolicy();
    const execution = await executeLocalHunt({
      root,
      policy: demo.policy,
      policySecrets: demo.secrets,
      caseName: 'positive',
      maxCostUsd: 2,
      maxTrials: 1,
      runId: lease.runId,
      attempt: lease.attempt,
      emit: async event => {
        const summary = controlEventSummary(event);
        if (!summary) return;
        await api.request(`/v1/jobs/${lease.jobId}/events`, {
          method: 'POST', headers,
          body: JSON.stringify({ workerEventId: `demo-${lease.attempt}-${sequence++}`, type: event.type, summary, occurredAt: event.at }),
        });
      },
    });
    if (!execution.result || !execution.plan || !execution.projection || execution.failure || execution.result.outcome !== 'candidate_only_violation') {
      throw new Error(execution.failure ?? 'demo_finding_not_confirmed');
    }
    await upload(api, lease, `/v1/jobs/${lease.jobId}/artifacts/replay_plan`, execution.plan);
    await upload(api, lease, `/v1/jobs/${lease.jobId}/result`, execution.projection);
    await api.request(`/v1/jobs/${lease.jobId}/complete`, {
      method: 'POST', headers,
      body: JSON.stringify({ state: 'completed', outcome: execution.result.outcome, reason: '' }),
    });
    completed = true;
    const accounting = demo.policy.accounting();
    console.log(`Confirmed paired result; policy decisions: ${accounting.calls}; external model requests: ${accounting.actualModelRequests}.`);
  } catch (error) {
    if (!completed) {
      const reason = error instanceof Error && /^[a-z0-9_]{1,120}$/.test(error.message) ? error.message : 'demo_execution_failed';
      await api.request(`/v1/jobs/${lease.jobId}/complete`, {
        method: 'POST', headers,
        body: JSON.stringify({ state: 'failed', outcome: '', reason }),
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    active = false;
    stopHeartbeat.abort();
    await heartbeat;
  }

  console.log('Minimizing with fresh paired replay; model calls: 0.');
  command(['minimize', '--run-id', run.id, '--confirmations', '1']);
  command(['report', '--run-id', run.id]);
  command(['show', '--run-id', run.id]);
  command(['test-generated']);
  expectSeededRegressionFailure();
  const report = `${root}/.hound/reports/${run.id}.html`;
  console.log(`Demo complete. HTML report: ${relative(root, report)}`);
  console.log(`Run ID: ${run.id}`);
  console.log('The demo proves orchestration, replay, minimization, persistence, export, and regression execution. Autonomous policy discovery is demonstrated separately with a real API key.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'demo_failed';
  console.error(`Hound demo stopped: ${message}.`);
  process.exitCode = 1;
});
