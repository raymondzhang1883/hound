import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';

export type Mode = 'baseline' | 'stale-write';
export type ActorKey = 'alice' | 'bob';
export type Role = 'admin' | 'member';
export type Credentials = Record<ActorKey, string>;
export interface User { actorKey: ActorKey; displayName: string }
export interface Workspace { id: string; name: string }
export interface Membership { workspaceId: string; actorKey: ActorKey; role: Role }
export interface Invitation { id: string; workspaceId: string; recipient: ActorKey; status: 'pending' | 'accepted' }
export interface Document { id: string; workspaceId: string; body: string; revision: number }
interface Session { actorKey: ActorKey; generation: string; grants: Set<string> }

export class FixtureError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
export function fail(status: number, code: string, message: string): never {
  throw new FixtureError(status, code, message);
}
export function sameSecret(actual: string, expected: string): boolean {
  const hash = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(actual), hash(expected));
}
const users: User[] = [{ actorKey: 'alice', displayName: 'Alice' }, { actorKey: 'bob', displayName: 'Bob' }];
const key = (workspaceId: string, actorKey: ActorKey) => `${workspaceId}:${actorKey}`;

/** Disposable fixture state. All transitions are synchronous; no state escapes by reference. */
export class FixtureStore {
  private execution?: { id: string; token: string };
  private sessions = new Map<string, Session>();
  private workspaces = new Map<string, Workspace>();
  private memberships = new Map<string, Membership>();
  private invitations = new Map<string, Invitation>();
  private documents = new Map<string, Document>();

  constructor(private readonly mode: Mode, private readonly credentials: Credentials) {}

  private clear() {
    this.sessions.clear(); this.workspaces.clear(); this.memberships.clear();
    this.invitations.clear(); this.documents.clear();
  }

  begin() {
    if (this.execution) fail(409, 'execution_active', 'An execution is already active.');
    this.clear();
    this.execution = { id: randomUUID(), token: randomBytes(32).toString('hex') };
    return { ...this.execution };
  }

  requireActive(): string {
    return this.execution?.id ?? fail(503, 'fixture_inactive', 'Start an execution through the fixture harness.');
  }

  assertGeneration(generation: string) {
    if (this.requireActive() !== generation) fail(409, 'execution_changed', 'The execution changed during this request.');
  }

  private checkExecution(id: string, token: string) {
    if (!this.execution || this.execution.id !== id || !sameSecret(token, this.execution.token)) {
      fail(403, 'invalid_execution', 'Execution credentials are invalid.');
    }
  }

  end(id: string, token: string) {
    this.checkExecution(id, token);
    this.clear(); this.execution = undefined;
  }

  inspect(id: string, token: string) {
    this.checkExecution(id, token);
    return structuredClone({ executionId: id, users, workspaces: [...this.workspaces.values()],
      memberships: [...this.memberships.values()], invitations: [...this.invitations.values()],
      documents: [...this.documents.values()] });
  }

  login(actorKey: string, password: string) {
    const generation = this.requireActive();
    const user = users.find(user => user.actorKey === actorKey);
    // Always compare a digest, including unknown actors; never return credential details.
    const valid = sameSecret(password, user ? this.credentials[user.actorKey] : randomBytes(32).toString('hex'));
    if (!user || !valid) fail(401, 'invalid_credentials', 'Invalid actor or password.');
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, { actorKey: user.actorKey, generation, grants: new Set() });
    return { token, user: { ...user } };
  }

  private session(token: string): Session {
    const generation = this.requireActive();
    const session = this.sessions.get(token);
    if (!session || session.generation !== generation) fail(401, 'unauthenticated', 'Sign in to continue.');
    return session;
  }

  whoami(token: string): User {
    const session = this.session(token);
    return { ...users.find(user => user.actorKey === session.actorKey)! };
  }

  logout(token: string) { this.session(token); this.sessions.delete(token); }

  private workspace(id: string) {
    return this.workspaces.get(id) ?? fail(404, 'not_found', 'Workspace not found.');
  }

  private member(workspaceId: string, actorKey: ActorKey, admin = false) {
    this.workspace(workspaceId);
    const membership = this.memberships.get(key(workspaceId, actorKey));
    if (!membership || (admin && membership.role !== 'admin')) fail(403, 'forbidden', 'Current workspace permission is required.');
    return membership;
  }

  listWorkspaces(token: string) {
    const { actorKey } = this.session(token);
    return [...this.workspaces.values()].filter(ws => this.memberships.has(key(ws.id, actorKey))).map(ws => ({ ...ws }));
  }

  createWorkspace(token: string, name: string) {
    const { actorKey } = this.session(token);
    const workspace = { id: randomUUID(), name };
    const document = { id: randomUUID(), workspaceId: workspace.id, body: 'A shared place for the next big idea.', revision: 1 };
    this.workspaces.set(workspace.id, workspace);
    this.memberships.set(key(workspace.id, actorKey), { workspaceId: workspace.id, actorKey, role: 'admin' });
    this.documents.set(document.id, document);
    return { workspace: { ...workspace }, document: { id: document.id, workspaceId: workspace.id } };
  }

  getWorkspace(token: string, id: string) {
    const { actorKey } = this.session(token);
    const membership = this.member(id, actorKey);
    return { ...this.workspace(id), role: membership.role,
      members: [...this.memberships.values()].filter(m => m.workspaceId === id).map(m => ({ ...m })),
      documents: [...this.documents.values()].filter(d => d.workspaceId === id).map(d => ({ id: d.id, workspaceId: id })) };
  }

  invite(token: string, workspaceId: string, recipient: string) {
    this.member(workspaceId, this.session(token).actorKey, true);
    if (recipient !== 'alice' && recipient !== 'bob') fail(400, 'invalid_recipient', 'Choose a fixture actor.');
    if (this.memberships.has(key(workspaceId, recipient))) fail(409, 'already_member', 'This actor is already a member.');
    if ([...this.invitations.values()].some(i => i.workspaceId === workspaceId && i.recipient === recipient && i.status === 'pending')) {
      fail(409, 'invitation_pending', 'This actor already has a pending invitation.');
    }
    const invitation: Invitation = { id: randomUUID(), workspaceId, recipient, status: 'pending' };
    this.invitations.set(invitation.id, invitation);
    return { ...invitation };
  }

  listInvitations(token: string) {
    const { actorKey } = this.session(token);
    return [...this.invitations.values()].filter(i => i.recipient === actorKey && i.status === 'pending')
      .map(i => ({ ...i, workspaceName: this.workspace(i.workspaceId).name }));
  }

  accept(token: string, id: string) {
    const { actorKey } = this.session(token);
    const invitation = this.invitations.get(id) ?? fail(404, 'not_found', 'Invitation not found.');
    if (invitation.recipient !== actorKey) fail(403, 'forbidden', 'This invitation belongs to another actor.');
    if (invitation.status !== 'pending' || this.memberships.has(key(invitation.workspaceId, actorKey))) {
      fail(409, 'invitation_consumed', 'This invitation is no longer pending.');
    }
    this.memberships.set(key(invitation.workspaceId, actorKey), { workspaceId: invitation.workspaceId, actorKey, role: 'member' });
    invitation.status = 'accepted';
    return { ...invitation };
  }

  remove(token: string, workspaceId: string, actorKey: string) {
    const administrator = this.session(token).actorKey;
    this.member(workspaceId, administrator, true);
    if (actorKey === administrator) fail(409, 'self_removal', 'Administrator self-removal is not supported.');
    if (actorKey !== 'alice' && actorKey !== 'bob') fail(404, 'not_found', 'Member not found.');
    if (!this.memberships.delete(key(workspaceId, actorKey))) fail(404, 'not_found', 'Member not found.');
    // Keep authentication and warmed grants alive: the write path must recheck membership.
  }

  private document(id: string) {
    return this.documents.get(id) ?? fail(404, 'not_found', 'Document not found.');
  }

  readDocument(token: string, id: string) {
    const session = this.session(token);
    const document = this.document(id);
    this.member(document.workspaceId, session.actorKey);
    session.grants.add(document.workspaceId);
    return { ...document };
  }

  editDocument(token: string, id: string, body: string, expectedRevision: number) {
    const session = this.session(token);
    const document = this.document(id);
    // The only seeded behavioral difference. Baseline never trusts an old grant.
    const staleGrant = this.mode === 'stale-write' && session.grants.has(document.workspaceId);
    if (!staleGrant) this.member(document.workspaceId, session.actorKey);
    if (document.revision !== expectedRevision) fail(409, 'revision_conflict', 'The document changed. Reopen it before saving.');
    document.body = body; document.revision++;
    return { ...document };
  }
}
