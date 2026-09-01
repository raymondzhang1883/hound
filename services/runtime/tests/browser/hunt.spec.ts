import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startFixture } from '../../../../apps/fixture/src/server.js';
import { FixtureHarness } from '../../../../apps/fixture/src/harness-client.js';
import { BrowserExperiment } from '../../src/experiment.js';
import { runHunt } from '../../src/hunt.js';
import { RunJournal } from '../../src/journal.js';
import { createDemoPolicy } from '../../src/demo-policy.js';

for (const scenario of ['positive', 'negative'] as const) {
  test(`offline ${scenario}: simulated provider wire format drives the real controller and fixture browsers`, async ({ browser }) => {
    test.setTimeout(60_000);
    const credentials = { alice: 'pilot-test-alice', bob: 'pilot-test-bob' };
    const harnessKey = randomBytes(32).toString('hex');
    const baseline = await startFixture({ mode: 'baseline', credentials, harnessKey });
    const candidate = await startFixture({ mode: scenario === 'positive' ? 'stale-write' : 'baseline', credentials, harnessKey });
    const demo = createDemoPolicy();
    const journal = await RunJournal.create(test.info().outputPath('pilot'), [harnessKey, ...Object.values(credentials), ...demo.secrets]);
    const opens: string[] = [];
    try {
      const result = await runHunt({ policy: demo.policy, maxTrials: 1,
        factory: { open: (target, options) => {
          opens.push(target);
          return BrowserExperiment.open(browser, { ...(target === 'baseline' ? baseline : candidate), credentials, harnessKey, ...options });
        } }, emit: event => journal.append(event), savePlan: plan => journal.write('plan', plan),
      });
      await journal.write('result', result);
      await test.info().attach(`offline-${scenario}-result`, { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
      expect(result.outcome).toBe(scenario === 'positive' ? 'candidate_only_violation' : 'no_suspicion');
      expect(result.suspicion).toBe(scenario === 'positive');
      expect(demo.telemetry.calls()).toBe(scenario === 'positive' ? 14 : 15);
      expect(opens).toEqual(scenario === 'positive' ? ['candidate', 'baseline', 'candidate'] : ['candidate']);
      expect(result.trials[0]!.denials).toBe(scenario === 'negative' ? 1 : 0);
      if (scenario === 'positive') {
        expect(result.replays?.baseline.result).toBe('denied');
        expect(result.replays?.candidate.result).toBe('violation');
      }
      const serializedInputs = JSON.stringify(demo.telemetry.inputs);
      const events = await readFile(join(journal.directory, 'events.jsonl'), 'utf8');
      for (const forbidden of [harnessKey, credentials.alice, credentials.bob, baseline.appUrl, candidate.appUrl, 'stale-write', 'expectedRevision', 'executionId']) {
        expect(serializedInputs).not.toContain(forbidden);
      }
      for (const secret of [harnessKey, ...Object.values(credentials), ...demo.secrets]) expect(events).not.toContain(secret);
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
