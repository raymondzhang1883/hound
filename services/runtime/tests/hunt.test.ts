import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runHunt, type ExperimentFactory } from '../src/hunt.js';
import { RunJournal } from '../src/journal.js';
import { PolicyError, type Policy } from '../src/policy.js';

const metadata = { provider: 'test', model: 'authored-test-policy', reasoning: 'none', promptVersion: 'test', simulated: true };
function fixtureFactory(options: { cleanupFails?: boolean } = {}) {
  let opens = 0; let closes = 0; let steps = 0;
  const observation = (actor: 'alice' | 'bob') => ({ version: 1 as const, actor, session: 'primary' as const, observationId: actor, routeRef: 'home', text: '', controls: [], knownRoutes: ['home'], truncated: false });
  const factory: ExperimentFactory = { open: async () => {
    opens++;
    return { observations: () => ({ alice: observation('alice'), bob: observation('bob') }), get usage() { return { proposed: steps, executed: 0 }; },
      step: async () => { steps++; return { status: 'rejected', code: 'unknown_control' }; },
      plan: () => { throw new Error('No finding'); }, replay: async () => { throw new Error('Not a replay test'); },
      close: async () => { closes++; if (options.cleanupFails) throw new Error('private cleanup error'); },
    };
  } };
  return { factory, counts: () => ({ opens, closes, steps }) };
}

it('counts rejected decisions, keeps proposals out of oracle input, and closes every trial', async () => {
  const fake = fixtureFactory(); let calls = 0;
  const events: unknown[] = [];
  const policy: Policy = { metadata, decide: async input => { calls++; assert.ok(!('factory' in input)); assert.ok(!('verdict' in input)); return { version: 1, kind: 'observe', actor: 'alice' }; }, accounting: () => ({ calls }) };
  const result = await runHunt({ policy, factory: fake.factory, maxTrials: 2, maxDecisions: 2, emit: async event => { events.push(event); } });
  assert.equal(result.outcome, 'no_suspicion'); assert.equal(result.suspicion, false);
  assert.equal(calls, 4); assert.deepEqual(fake.counts(), { opens: 2, closes: 2, steps: 4 });
  assert.equal(result.trials[0]!.proposed, 2); assert.equal(result.trials[0]!.executed, 0);
  assert.ok(JSON.stringify(events).includes('hunt_finished'));
});

it('provider refusal closes state and stops without another trial or action', async () => {
  const fake = fixtureFactory(); let calls = 0;
  const policy: Policy = { metadata, decide: async () => { calls++; throw new PolicyError('provider_refused'); }, accounting: () => ({ calls }) };
  const result = await runHunt({ policy, factory: fake.factory });
  assert.equal(result.outcome, 'provider_stopped'); assert.equal(result.reason, 'provider_refused');
  assert.deepEqual(fake.counts(), { opens: 1, closes: 1, steps: 0 }); assert.equal(calls, 1);
});

it('cleanup failure prevents fresh trials and cannot become a nondetection success', async () => {
  const fake = fixtureFactory({ cleanupFails: true });
  const policy: Policy = { metadata, decide: async () => ({}), accounting: () => ({}) };
  const result = await runHunt({ policy, factory: fake.factory, maxDecisions: 1 });
  assert.equal(result.outcome, 'inconclusive'); assert.equal(result.reason, 'cleanup_failed');
  assert.deepEqual(fake.counts(), { opens: 1, closes: 1, steps: 1 });
});

it('an already cancelled hunt never acquires a fixture or calls a policy', async () => {
  const fake = fixtureFactory(); const controller = new AbortController(); controller.abort();
  const result = await runHunt({ factory: fake.factory, signal: controller.signal,
    policy: { metadata, decide: async () => { throw new Error('must not call'); }, accounting: () => ({}) } });
  assert.equal(result.outcome, 'cancelled'); assert.equal(fake.counts().opens, 0);
});

it('writes private versioned records and redacts known secrets without breaking JSON', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'hound-journal-'));
  try {
    const secret = 'test-"secret'; const journal = await RunJournal.create(parent, [secret]);
    await journal.append({ type: 'sample', nested: { text: `before ${secret} after` } });
    await journal.write('result', { outcome: 'no_suspicion' });
    const data = JSON.parse(await readFile(join(journal.directory, 'events.jsonl'), 'utf8'));
    assert.equal(data.nested.text, 'before [redacted] after'); assert.equal(data.sequence, 0);
    assert.equal((await stat(journal.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(journal.directory, 'result.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(journal.directory, 'events.jsonl'))).mode & 0o777, 0o600);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

it('missing-key CLI preflight completes without launching a browser or making model requests', async () => {
  const script = fileURLToPath(new URL('../scripts/hunt.ts', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', script, '--preflight'], {
    env: { ...process.env, OPENAI_API_KEY: '' }, timeout: 10_000,
  });
  const report = JSON.parse(stdout);
  assert.equal(report.apiKey, 'missing'); assert.equal(report.ready, false); assert.equal(report.networkRequestsMade, 0);
});
