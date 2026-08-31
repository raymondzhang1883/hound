import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FixtureStore, FixtureError, type Mode } from '../src/store.js';

const credentials = { alice: 'test-alice', bob: 'test-bob' };
function setup(mode: Mode) {
  const store = new FixtureStore(mode, credentials);
  const execution = store.begin();
  const alice = store.login('alice', credentials.alice).token;
  const bob = store.login('bob', credentials.bob).token;
  const { workspace, document } = store.createWorkspace(alice, 'Studio');
  return { store, execution, alice, bob, workspace, document };
}
const denied = (action: () => unknown, status = 403) => assert.throws(action, (error: unknown) => error instanceof FixtureError && error.status === status);

for (const mode of ['baseline', 'stale-write'] as const) {
  describe(mode, () => {
    it('checks real membership before warming a session and editing a document', () => {
      const { store, alice, bob, workspace, document } = setup(mode);
      denied(() => store.readDocument(bob, document.id));
      denied(() => store.editDocument(bob, document.id, 'not a member', 1));
      const invitation = store.invite(alice, workspace.id, 'bob');
      store.accept(bob, invitation.id);
      assert.equal(store.readDocument(bob, document.id).revision, 1);
      assert.equal(store.editDocument(bob, document.id, 'legitimate edit', 1).revision, 2);
    });

    it('keeps the seeded difference confined to a warmed post-removal write', () => {
      const { store, execution, alice, bob, workspace, document } = setup(mode);
      store.accept(bob, store.invite(alice, workspace.id, 'bob').id);
      store.readDocument(bob, document.id);
      store.remove(alice, workspace.id, 'bob');
      assert.equal(store.whoami(bob).actorKey, 'bob');
      denied(() => store.readDocument(bob, document.id));
      const before = store.inspect(execution.id, execution.token);
      assert.equal(before.memberships.some(m => m.actorKey === 'bob'), false);
      if (mode === 'stale-write') {
        assert.equal(store.editDocument(bob, document.id, 'unauthorized marker', 1).revision, 2);
        const after = store.inspect(execution.id, execution.token).documents[0]!;
        assert.equal(after.body, 'unauthorized marker'); assert.equal(after.revision, 2);
      } else {
        denied(() => store.editDocument(bob, document.id, 'unauthorized marker', 1));
        assert.deepEqual(store.inspect(execution.id, execution.token), before);
      }
    });

    it('does not warm permissions through login, metadata, membership, or writes', () => {
      const { store, alice, bob, workspace, document } = setup(mode);
      store.accept(bob, store.invite(alice, workspace.id, 'bob').id);
      store.whoami(bob); store.getWorkspace(bob, workspace.id); store.listWorkspaces(bob);
      store.editDocument(bob, document.id, 'legitimate without a read', 1);
      store.remove(alice, workspace.id, 'bob');
      denied(() => store.editDocument(bob, document.id, 'must fail', 2));
    });

    it('isolates cached permissions across sessions and workspaces', () => {
      const { store, alice, bob, workspace, document } = setup(mode);
      store.accept(bob, store.invite(alice, workspace.id, 'bob').id);
      store.readDocument(bob, document.id);
      const otherSession = store.login('bob', credentials.bob).token;
      const otherWorkspace = store.createWorkspace(alice, 'Private');
      denied(() => store.editDocument(bob, otherWorkspace.document.id, 'wrong workspace', 1));
      store.remove(alice, workspace.id, 'bob');
      denied(() => store.editDocument(otherSession, document.id, 'wrong session', 1));
      store.logout(bob);
      denied(() => store.editDocument(bob, document.id, 'logged out', 1), 401);
      const fresh = store.login('bob', credentials.bob).token;
      denied(() => store.editDocument(fresh, document.id, 'fresh login', 1));
    });

    it('does not let a member administer membership or recycle accepted invitations', () => {
      const { store, alice, bob, workspace } = setup(mode);
      const invitation = store.invite(alice, workspace.id, 'bob');
      denied(() => store.accept(alice, invitation.id));
      denied(() => store.invite(alice, workspace.id, 'bob'), 409);
      store.accept(bob, invitation.id);
      denied(() => store.invite(bob, workspace.id, 'alice'));
      denied(() => store.remove(bob, workspace.id, 'alice'));
      denied(() => store.remove(alice, workspace.id, 'alice'), 409);
      store.remove(alice, workspace.id, 'bob');
      denied(() => store.accept(bob, invitation.id), 409);
      store.accept(bob, store.invite(alice, workspace.id, 'bob').id);
      assert.equal(store.getWorkspace(bob, workspace.id).role, 'member');
      // Administrator status belongs to the membership, not a hardcoded actor name.
      const personal = store.createWorkspace(bob, 'Bob owns this');
      store.accept(alice, store.invite(bob, personal.workspace.id, 'alice').id);
      denied(() => store.remove(alice, personal.workspace.id, 'bob'));
      store.remove(bob, personal.workspace.id, 'alice');
    });

    it('rejects conflicting revisions without modifying the document', () => {
      const { store, alice, bob, document } = setup(mode);
      store.editDocument(alice, document.id, 'new revision', 1);
      denied(() => store.editDocument(alice, document.id, 'lost update', 1), 409);
      // Authorization takes precedence over revision conflict information.
      denied(() => store.editDocument(bob, document.id, 'not a member', 1), 403);
      assert.equal(store.readDocument(alice, document.id).body, 'new revision');
    });

    it('fences executions and keeps inspection read-only and free of session secrets', () => {
      const { store, execution, alice, bob, workspace, document } = setup(mode);
      store.accept(bob, store.invite(alice, workspace.id, 'bob').id);
      const snapshot = store.inspect(execution.id, execution.token);
      const serialized = JSON.stringify(snapshot);
      for (const secret of [alice, bob, execution.token, credentials.alice, credentials.bob]) assert.equal(serialized.includes(secret), false);
      snapshot.documents[0]!.body = 'tampered copy';
      assert.notEqual(store.inspect(execution.id, execution.token).documents[0]!.body, 'tampered copy');
      store.remove(alice, workspace.id, 'bob');
      denied(() => store.editDocument(bob, document.id, 'inspection cannot warm', 1));
      denied(() => store.begin(), 409);
      denied(() => store.end(execution.id, 'wrong token'));
      store.end(execution.id, execution.token);
      denied(() => store.whoami(alice), 503);
      const next = store.begin();
      denied(() => store.whoami(alice), 401);
      denied(() => store.end(execution.id, execution.token));
      denied(() => store.inspect(next.id, execution.token));
      denied(() => store.assertGeneration(execution.id), 409);
      assert.equal(store.inspect(next.id, next.token).workspaces.length, 0);
    });
  });
}
