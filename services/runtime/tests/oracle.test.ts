import { it } from 'node:test';
import assert from 'node:assert/strict';
import { FixtureStore, FixtureError, type Mode } from '../../../apps/fixture/src/store.js';
import { RemovedMemberWriteOracle, comparePair, type ReplayConclusion, type EvidenceFrame } from '../src/oracle.js';
import type { Actor } from '../src/contracts.js';

function setup(mode: Mode, access: 'read' | 'write' = 'read') {
  const store = new FixtureStore(mode, { alice: 'unit-alice', bob: 'unit-bob' });
  const execution = store.begin();
  const tokens = { alice: store.login('alice', 'unit-alice').token, bob: store.login('bob', 'unit-bob').token };
  const { workspace, document } = store.createWorkspace(tokens.alice, 'Oracle test');
  store.accept(tokens.bob, store.invite(tokens.alice, workspace.id, 'bob').id);
  const oracle = new RemovedMemberWriteOracle(execution.id);
  let step = 0;
  function frame(actor: Actor, method: string, path: string, action: () => unknown, requestBody?: unknown): EvidenceFrame {
    const before = store.inspect(execution.id, execution.token);
    let status = method === 'DELETE' ? 204 : 200; let responseBody: unknown;
    try { responseBody = action(); } catch (error) { if (!(error instanceof FixtureError)) throw error; status = error.status; }
    return { step: step++, actor, session: `${actor}/primary`, verifiedActor: actor, complete: true,
      before, after: store.inspect(execution.id, execution.token), exchanges: [{ method, path, status, requestBody, responseBody }] };
  }
  const path = `/api/documents/${document.id}`;
  const accessFrame = access === 'read'
    ? frame('bob', 'GET', path, () => store.readDocument(tokens.bob, document.id))
    : frame('bob', 'PATCH', path, () => store.editDocument(tokens.bob, document.id, 'legitimate write', 1), { body: 'legitimate write', expectedRevision: 1 });
  assert.equal(oracle.observe(accessFrame).kind, 'not_applicable');
  const removalFrame = frame('alice', 'DELETE', `/api/workspaces/${workspace.id}/members/bob`, () => store.remove(tokens.alice, workspace.id, 'bob'));
  assert.equal(oracle.observe(removalFrame).kind, 'not_applicable');
  function probe() {
    const revision = access === 'read' ? 1 : 2;
    return frame('bob', 'PATCH', path, () => store.editDocument(tokens.bob, document.id, 'unique probe', revision), { body: 'unique probe', expectedRevision: revision });
  }
  return { store, tokens, workspace, document, execution, oracle, frame, probe };
}

it('distinguishes actual persistence from the HTTP status, including lying error responses', () => {
  const baseline = setup('baseline'); assert.equal(baseline.oracle.observe(baseline.probe()).kind, 'denied');
  for (const status of [200, 403, 500]) {
    const candidate = setup('stale-write'); const probe = candidate.probe(); probe.exchanges[0]!.status = status;
    assert.equal(candidate.oracle.observe(probe).kind, 'violation');
  }
  const lyingSuccess = setup('baseline'); const probe = lyingSuccess.probe(); probe.exchanges[0]!.status = 200;
  assert.equal(lyingSuccess.oracle.observe(probe).kind, 'inconclusive');
});

it('accepts legitimate writes as access evidence without requiring the seeded warm-up read', () => {
  const run = setup('baseline', 'write');
  assert.equal(run.oracle.observe(run.probe()).kind, 'denied');
});

it('rejects missing, crossed, duplicate, and unrelated evidence', () => {
  const corruptions: ((frame: EvidenceFrame) => void)[] = [
    f => { f.complete = false; }, f => { f.verifiedActor = 'alice'; }, f => { f.after.executionId = 'other'; },
    f => { f.session = 'bob/another'; }, f => { f.exchanges.push({ ...f.exchanges[0]! }); },
    f => { f.after.documents[0]!.revision += 1; }, f => { f.after.workspaces[0]!.name = 'other edit'; },
    f => { f.before.documents[0]!.body = 'unattributed mutation'; },
  ];
  for (const corrupt of corruptions) {
    const run = setup('stale-write'); const probe = run.probe(); corrupt(probe);
    assert.equal(run.oracle.observe(probe).kind, 'inconclusive');
  }
  const run = setup('stale-write'); const probe = run.probe();
  assert.equal(new RemovedMemberWriteOracle(run.execution.id).observe(probe).kind, 'inconclusive');
  assert.equal(run.oracle.observe(probe).kind, 'violation');
  assert.equal(run.oracle.observe(probe).kind, 'inconclusive');
});

it('does not report a violation after the member is restored', () => {
  const run = setup('stale-write');
  run.oracle.observe(run.frame('alice', 'POST', `/api/workspaces/${run.workspace.id}/invitations`, () => run.store.invite(run.tokens.alice, run.workspace.id, 'bob')));
  const invitation = run.store.listInvitations(run.tokens.bob)[0]!;
  run.oracle.observe(run.frame('bob', 'POST', `/api/invitations/${invitation.id}/accept`, () => run.store.accept(run.tokens.bob, invitation.id)));
  assert.equal(run.oracle.observe(run.probe()).kind, 'not_applicable');
});

it('pairs only equivalent plans, resources, actors, probes, and successful setup', () => {
  const baseline: ReplayConclusion = { planId: 'plan', probeStep: 12, actor: 'bob', resourceRef: 'document_1', setupEquivalent: true, result: 'denied' };
  const candidate = { ...baseline, result: 'violation' as const };
  assert.equal(comparePair(baseline, candidate), 'candidate_only_violation');
  assert.equal(comparePair(candidate, candidate), 'shared_violation');
  assert.equal(comparePair(baseline, baseline), 'no_reproduced_candidate_violation');
  for (const patch of [{ planId: 'other' }, { probeStep: 13 }, { actor: 'alice' as const }, { resourceRef: 'document_2' }, { setupEquivalent: false }, { result: 'inconclusive' as const }]) {
    assert.equal(comparePair({ ...baseline, ...patch }, candidate), 'inconclusive');
  }
});
