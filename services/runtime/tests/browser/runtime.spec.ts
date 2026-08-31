import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { startFixture } from '../../../../apps/fixture/src/server.js';
import { FixtureHarness } from '../../../../apps/fixture/src/harness-client.js';
import { BrowserExperiment } from '../../src/experiment.js';
import { ActorTransport } from '../../src/transport.js';
import { ActorView } from '../../src/observation.js';
import { Bindings } from '../../src/bindings.js';
import { comparePair } from '../../src/oracle.js';
import type { Actor, Control, TextValue } from '../../src/contracts.js';

const credentials = { alice: 'runtime-test-alice', bob: 'runtime-test-bob' };

async function act(run: BrowserExperiment, actor: Actor, kind: 'click' | 'fill' | 'select', name: RegExp, value?: TextValue | string) {
  const observation = run.observations()[actor];
  const role = kind === 'fill' ? 'textbox' : kind === 'select' ? 'combobox' : undefined;
  const controls = observation.controls.filter(control => (!role || control.role === role) && name.test(control.name));
  expect(controls, `Expected one control matching ${name}; observed ${observation.controls.map(c => c.name).join(', ')}`).toHaveLength(1);
  const control = controls[0]!;
  const result = await run.step({ version: 1, kind, actor, observationId: observation.observationId, targetId: control.id,
    ...(kind === 'fill' ? { value } : kind === 'select' ? { option: value } : {}) });
  expect(result).toMatchObject({ status: 'executed' });
  return result;
}

// An authored acceptance trajectory, not a model policy and never provided to exploration.
async function referenceProbe(run: BrowserExperiment) {
  await act(run, 'alice', 'fill', /^Workspace name$/, { ref: 'trial_text' });
  await act(run, 'alice', 'click', /^Create workspace$/);
  await act(run, 'alice', 'select', /^Invite a teammate$/, 'bob');
  await act(run, 'alice', 'click', /^Send invitation$/);
  await act(run, 'bob', 'click', /^Refresh$/);
  await act(run, 'bob', 'click', /^Accept invitation$/);
  await act(run, 'bob', 'click', /Open workspace/);
  await act(run, 'bob', 'click', /Shared document/);
  await act(run, 'bob', 'fill', /^Document body$/, { literal: 'Legitimate pre-removal edit' });
  await act(run, 'bob', 'click', /^Save document$/);
  await act(run, 'alice', 'click', /^Refresh members$/);
  await act(run, 'alice', 'click', /^Remove Bob$/);
  await act(run, 'bob', 'fill', /^Document body$/, { ref: 'trial_text' });
  return act(run, 'bob', 'click', /^Save document$/);
}

test('replays one recorded browser plan on fresh correct and buggy deployments', async ({ browser }) => {
  test.setTimeout(90_000);
  const harnessKey = randomBytes(32).toString('hex');
  const baseline = await startFixture({ mode: 'baseline', credentials, harnessKey });
  const candidate = await startFixture({ mode: 'stale-write', credentials, harnessKey });
  const runs: BrowserExperiment[] = [];
  async function open(fixture: typeof baseline) {
    const run = await BrowserExperiment.open(browser, { ...fixture, harnessKey, credentials });
    runs.push(run); return run;
  }
  async function close(run: BrowserExperiment) { await run.close(); runs.splice(runs.indexOf(run), 1); }
  try {
    const discovery = await open(candidate);
    expect(await referenceProbe(discovery)).toMatchObject({ status: 'executed', verdict: { kind: 'violation' } });
    const plan = discovery.plan();
    expect(plan.steps).toHaveLength(14);
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain(harnessKey);
    expect(serialized).not.toContain(credentials.alice);
    expect(serialized).not.toContain(candidate.appUrl);
    await close(discovery);

    const baselineRun = await open(baseline);
    const baselineResult = await baselineRun.replay(plan);
    expect(baselineResult).toMatchObject({ setupEquivalent: true, result: 'denied' });
    await close(baselineRun);
    const candidateRun = await open(candidate);
    const candidateResult = await candidateRun.replay(plan);
    expect(candidateResult).toMatchObject({ setupEquivalent: true, result: 'violation' });
    expect(comparePair(baselineResult, candidateResult)).toBe('candidate_only_violation');
    await close(candidateRun);

    const correctCandidate = await open(baseline);
    const correctResult = await correctCandidate.replay(plan);
    expect(comparePair(baselineResult, correctResult)).toBe('no_reproduced_candidate_violation');
    await close(correctCandidate);
    const buggyBaseline = await open(candidate);
    const buggyResult = await buggyBaseline.replay(plan);
    expect(comparePair(buggyResult, candidateResult)).toBe('shared_violation');
    await close(buggyBaseline);
  } finally {
    await Promise.allSettled(runs.map(run => run.close()));
    await Promise.all([baseline.close(), candidate.close()]);
  }
});

test('rejects crossed/stale controls and unknown capabilities without mutating the fixture', async ({ browser }) => {
  const harnessKey = randomBytes(32).toString('hex');
  const fixture = await startFixture({ mode: 'baseline', credentials, harnessKey });
  const run = await BrowserExperiment.open(browser, { ...fixture, harnessKey, credentials, maxDecisions: 10 });
  try {
    const observation = run.observations().alice;
    const textbox = observation.controls.find(c => c.name === 'Workspace name')!;
    const input = { version: 1, kind: 'fill', actor: 'alice', observationId: observation.observationId, targetId: textbox.id, value: { literal: 'Only local input' } };
    expect(await run.step({ ...input, actor: 'bob' })).toMatchObject({ status: 'rejected' });
    expect(await run.step({ ...input, script: 'unsupported capability' })).toMatchObject({ status: 'rejected' });
    expect(await run.step({ version: 1, kind: 'navigate', actor: 'bob', routeRef: 'document_99.page' })).toMatchObject({ status: 'rejected' });
    expect(await run.step(input)).toMatchObject({ status: 'executed' });
    expect(await run.step(input)).toMatchObject({ status: 'rejected', code: 'stale_observation' });
    expect(run.usage).toEqual({ proposed: 5, executed: 1 });
    expect(JSON.stringify(run.observations())).not.toContain(credentials.alice);
    expect(JSON.stringify(run.observations())).not.toContain(harnessKey);
  } finally { await run.close(); await fixture.close(); }
});

test('does not acquire or reset an occupied fixture', async ({ browser }) => {
  const harnessKey = randomBytes(32).toString('hex');
  const fixture = await startFixture({ mode: 'baseline', credentials, harnessKey });
  const harness = new FixtureHarness(fixture.harnessUrl, harnessKey);
  const execution = await harness.begin();
  try {
    await expect(BrowserExperiment.open(browser, { ...fixture, harnessKey, credentials })).rejects.toThrow('409');
    expect((await harness.inspect(execution)).executionId).toBe(execution.id);
  } finally { await harness.end(execution); await fixture.close(); }
});

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local test address');
  return `http://127.0.0.1:${address.port}`;
}
async function closeServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

test('local transport blocks other origins and redirects before contacting them', async ({ browser }) => {
  let otherRequests = 0;
  const other = createServer((_, response) => { otherRequests++; response.end('not an allowed target'); });
  const otherUrl = await listen(other);
  const app = createServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { Location: otherUrl }); response.end(); }
    else { response.setHeader('Content-Type', 'text/html'); response.end(`<main>Local boundary test</main><script>fetch('${otherUrl}').catch(() => {});</script>`); }
  });
  const appUrl = await listen(app);
  try {
    for (const path of ['/', '/redirect']) {
      const transport = await ActorTransport.create(browser, appUrl);
      try {
        await transport.page.goto(appUrl + path).catch(() => {});
        await expect.poll(() => { try { transport.check(); return false; } catch { return true; } }).toBe(true);
        expect(otherRequests).toBe(0);
      } finally { await transport.close(); }
    }
  } finally { await closeServer(app); await closeServer(other); }
});

test('observation extraction excludes passwords and refuses ambiguous controls', async ({ browser }) => {
  const server = createServer((_, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<main><p>Visible local-test-secret</p><label>Password<input type="password" value="local-test-secret"></label><button>Save</button><button>Save</button><label>Note<textarea>Plain text</textarea></label></main>');
  });
  const origin = await listen(server);
  const transport = await ActorTransport.create(browser, origin);
  try {
    await transport.page.goto(origin);
    const view = new ActorView('alice', transport.page, origin, new Bindings(), ['local-test-secret']);
    const observation = await view.snapshot();
    expect(JSON.stringify(observation)).not.toContain('local-test-secret');
    expect(observation.controls.some((control: Control) => control.name === 'Save' || control.name === 'Password')).toBe(false);
    expect(observation.controls.some(control => control.name === 'Note')).toBe(true);
    expect(observation.truncated).toBe(true);
  } finally { await transport.close(); await closeServer(server); }
});
