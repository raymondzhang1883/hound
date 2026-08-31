import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startFixture } from '../../../../apps/fixture/src/server.js';
import { FixtureHarness } from '../../../../apps/fixture/src/harness-client.js';
import { BrowserExperiment } from '../../src/experiment.js';
import { runHunt } from '../../src/hunt.js';
import { RunJournal } from '../../src/journal.js';
import { OpenAIPolicy, MODEL } from '../../src/openai-policy.js';
import type { Policy, PolicyInput } from '../../src/policy.js';
import type { Actor } from '../../src/contracts.js';

// Authored only for integration testing. This sequence is never imported by the live policy.
const sequence: { actor: Actor; kind: 'fill' | 'click' | 'select'; name: RegExp; value?: unknown }[] = [
  { actor: 'alice', kind: 'fill', name: /^Workspace name$/, value: { ref: 'trial_text' } },
  { actor: 'alice', kind: 'click', name: /^Create workspace$/ },
  { actor: 'alice', kind: 'select', name: /^Invite a teammate$/, value: 'bob' },
  { actor: 'alice', kind: 'click', name: /^Send invitation$/ },
  { actor: 'bob', kind: 'click', name: /^Refresh$/ },
  { actor: 'bob', kind: 'click', name: /^Accept invitation$/ },
  { actor: 'bob', kind: 'click', name: /Open workspace/ },
  { actor: 'bob', kind: 'click', name: /Shared document/ },
  { actor: 'bob', kind: 'fill', name: /^Document body$/, value: { literal: 'Legitimate integration test edit' } },
  { actor: 'bob', kind: 'click', name: /^Save document$/ },
  { actor: 'alice', kind: 'click', name: /^Refresh members$/ },
  { actor: 'alice', kind: 'click', name: /^Remove Bob$/ },
  { actor: 'bob', kind: 'fill', name: /^Document body$/, value: { ref: 'trial_text' } },
  { actor: 'bob', kind: 'click', name: /^Save document$/ },
];

for (const scenario of ['positive', 'negative'] as const) {
  test(`offline ${scenario}: simulated provider wire format drives the real controller and fixture browsers`, async ({ browser }) => {
    test.setTimeout(60_000);
    const credentials = { alice: 'pilot-test-alice', bob: 'pilot-test-bob' };
    const harnessKey = randomBytes(32).toString('hex');
    const baseline = await startFixture({ mode: 'baseline', credentials, harnessKey });
    const candidate = await startFixture({ mode: scenario === 'positive' ? 'stale-write' : 'baseline', credentials, harnessKey });
    const inputs: PolicyInput[] = []; let calls = 0;
    const adapter = new OpenAIPolicy({ apiKey: 'simulated-provider-key', maxCostUsd: 2, transport: async (url, init) => {
      expect(url).toBe('https://api.openai.com/v1/responses');
      const request = JSON.parse(init!.body as string);
      const input = JSON.parse(request.input[0].content) as PolicyInput;
      inputs.push(input);
      const action = sequence[calls++];
      let decision: unknown = { version: 1, kind: 'stop', reason: 'Authored test sequence finished' };
      if (action) {
        const observation = input.observations[action.actor];
        const targets = observation.controls.filter(control => action.name.test(control.name));
        expect(targets).toHaveLength(1);
        decision = { version: 1, actor: action.actor, kind: action.kind, observationId: observation.observationId, targetId: targets[0]!.id,
          ...(action.kind === 'fill' ? { value: action.value } : action.kind === 'select' ? { option: action.value } : {}) };
      }
      return Response.json({ model: MODEL, status: 'completed', service_tier: 'default', usage: { input_tokens: 1000, output_tokens: 200 },
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ decision }) }] }] });
    } });
    const policy: Policy = { metadata: { ...adapter.metadata, provider: 'simulated-openai', simulated: true },
      decide: (input, signal) => adapter.decide(input, signal), accounting: () => ({ ...adapter.accounting(), simulated: true, actualModelRequests: 0 }) };
    const journal = await RunJournal.create(test.info().outputPath('pilot'), [harnessKey, ...Object.values(credentials), 'simulated-provider-key']);
    const opens: string[] = [];
    try {
      const result = await runHunt({ policy, maxTrials: 1,
        factory: { open: (target, options) => {
          opens.push(target);
          return BrowserExperiment.open(browser, { ...(target === 'baseline' ? baseline : candidate), credentials, harnessKey, ...options });
        } }, emit: event => journal.append(event), savePlan: plan => journal.write('plan', plan),
      });
      await journal.write('result', result);
      await test.info().attach(`offline-${scenario}-result`, { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
      expect(result.outcome).toBe(scenario === 'positive' ? 'candidate_only_violation' : 'no_suspicion');
      expect(result.suspicion).toBe(scenario === 'positive');
      expect(calls).toBe(scenario === 'positive' ? 14 : 15);
      expect(opens).toEqual(scenario === 'positive' ? ['candidate', 'baseline', 'candidate'] : ['candidate']);
      expect(result.trials[0]!.denials).toBe(scenario === 'negative' ? 1 : 0);
      if (scenario === 'positive') {
        expect(result.replays?.baseline.result).toBe('denied');
        expect(result.replays?.candidate.result).toBe('violation');
      }
      const serializedInputs = JSON.stringify(inputs);
      const events = await readFile(join(journal.directory, 'events.jsonl'), 'utf8');
      for (const forbidden of [harnessKey, credentials.alice, credentials.bob, baseline.appUrl, candidate.appUrl, 'stale-write', 'expectedRevision', 'executionId']) {
        expect(serializedInputs).not.toContain(forbidden);
      }
      for (const secret of [harnessKey, ...Object.values(credentials), 'simulated-provider-key']) expect(events).not.toContain(secret);
      expect(events).toContain('hunt_finished'); expect(result.policy.simulated).toBe(true);
      expect(browser.contexts()).toHaveLength(0);
      for (const target of [baseline, candidate]) {
        const harness = new FixtureHarness(target.harnessUrl, harnessKey);
        const execution = await harness.begin(); await harness.end(execution);
      }
    } finally { await Promise.all([baseline.close(), candidate.close()]); }
  });
}

test('cancelling during policy selection closes live actor browsers and releases the fixture', async ({ browser }) => {
  const credentials = { alice: 'cancel-test-alice', bob: 'cancel-test-bob' };
  const harnessKey = randomBytes(32).toString('hex');
  const fixture = await startFixture({ mode: 'baseline', credentials, harnessKey });
  const controller = new AbortController();
  let called = false;
  try {
    const result = await runHunt({ signal: controller.signal,
      factory: { open: (_, options) => BrowserExperiment.open(browser, { ...fixture, credentials, harnessKey, ...options }) },
      policy: { metadata: { provider: 'test', model: 'cancel-test', promptVersion: 'test', reasoning: 'none', simulated: true }, accounting: () => ({ actualModelRequests: 0 }),
        decide: async () => { called = true; controller.abort(); return { version: 1, kind: 'observe', actor: 'alice' }; } },
    });
    expect(called).toBe(true); expect(result.outcome).toBe('cancelled');
    expect(result.trials[0]!.proposed).toBe(0); expect(browser.contexts()).toHaveLength(0);
    const harness = new FixtureHarness(fixture.harnessUrl, harnessKey);
    const execution = await harness.begin(); await harness.end(execution);
  } finally { await fixture.close(); }
});
