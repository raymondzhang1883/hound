import type { FixtureSnapshot } from '../../../apps/fixture/src/harness-client.js';
import type { Actor, HttpExchange } from './contracts.js';

export interface EvidenceFrame {
  step: number; actor: Actor; session: string; verifiedActor: Actor | null; complete: boolean;
  before: FixtureSnapshot; after: FixtureSnapshot; exchanges: HttpExchange[];
}
export type Verdict =
  | { kind: 'not_applicable' }
  | { kind: 'inconclusive'; reason: string }
  | { kind: 'violation' | 'denied'; actor: Actor; documentId: string; workspaceId: string; step: number; status: number };

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const inconclusive = (reason: string): Verdict => ({ kind: 'inconclusive', reason });
const unchanged = (before: FixtureSnapshot, after: FixtureSnapshot) => canonical(before) === canonical(after);
const member = (snapshot: FixtureSnapshot, actor: string, workspace: string) => snapshot.memberships.find(m => m.actorKey === actor && m.workspaceId === workspace);
const isMutation = (exchange: HttpExchange) => !['GET', 'HEAD'].includes(exchange.method);

/** A fixture-specific deterministic oracle. This object and its inputs never enter model context. */
export class RemovedMemberWriteOracle {
  private legitimateAccess = new Set<string>();
  private removals = new Set<string>();
  private previous?: FixtureSnapshot;
  private lastStep = -1;
  constructor(private readonly executionId: string) {}

  observe(frame: EvidenceFrame): Verdict {
    const { before, after, actor, session, exchanges, step } = frame;
    if (!frame.complete || frame.verifiedActor !== actor || !session) return inconclusive('incomplete_actor_evidence');
    if (before.executionId !== this.executionId || after.executionId !== this.executionId || step <= this.lastStep) return inconclusive('execution_or_step_mismatch');
    if (this.previous && !unchanged(this.previous, before)) return inconclusive('unattributed_state_change');
    this.previous = structuredClone(after); this.lastStep = step;
    const mutations = exchanges.filter(isMutation);
    if (mutations.length > 1) return inconclusive('multiple_mutations');
    if (!mutations.length && !unchanged(before, after)) return inconclusive('read_changed_state');
    for (const removal of this.removals) {
      const [removedActor, workspace] = removal.split(':');
      if (member(before, removedActor!, workspace!) || member(after, removedActor!, workspace!)) this.removals.delete(removal);
    }
    for (const exchange of exchanges) {
      const read = /^\/api\/documents\/([^/]+)$/.exec(exchange.path);
      if (read && exchange.method === 'GET' && exchange.status === 200) {
        const doc = before.documents.find(d => d.id === read[1]);
        const response = exchange.responseBody as { id?: string; body?: string; revision?: number } | undefined;
        if (doc && member(before, actor, doc.workspaceId) && response?.id === doc.id && response.body === doc.body && response.revision === doc.revision) {
          this.legitimateAccess.add(`${actor}:${session}:${doc.id}`);
        }
      }
    }
    const mutation = mutations[0];
    if (!mutation) return { kind: 'not_applicable' };
    const removal = /^\/api\/workspaces\/([^/]+)\/members\/(alice|bob)$/.exec(mutation.path);
    if (mutation.method === 'DELETE' && removal) {
      const [, workspace, removedActor] = removal;
      if (mutation.status === 204 && member(before, actor, workspace!)?.role === 'admin' && member(before, removedActor!, workspace!) && !member(after, removedActor!, workspace!)) {
        const expected = structuredClone(before);
        expected.memberships = expected.memberships.filter(m => !(m.actorKey === removedActor && m.workspaceId === workspace));
        if (!unchanged(expected, after)) return inconclusive('removal_changed_other_state');
        this.removals.add(`${removedActor}:${workspace}`);
      } else if (!unchanged(before, after)) return inconclusive('unverified_removal');
      return { kind: 'not_applicable' };
    }
    const match = /^\/api\/documents\/([^/]+)$/.exec(mutation.path);
    if (mutation.method !== 'PATCH' || !match) return { kind: 'not_applicable' };
    const doc = before.documents.find(d => d.id === match[1]);
    const updated = after.documents.find(d => d.id === match[1]);
    const input = mutation.requestBody as { body?: unknown; expectedRevision?: unknown } | undefined;
    if (!doc || !updated || updated.workspaceId !== doc.workspaceId || typeof input?.body !== 'string') return inconclusive('missing_document_evidence');
    const otherStateBefore = { ...before, documents: before.documents.filter(d => d.id !== doc.id) };
    const otherStateAfter = { ...after, documents: after.documents.filter(d => d.id !== doc.id) };
    if (!unchanged(otherStateBefore, otherStateAfter)) return inconclusive('probe_changed_other_state');
    const persisted = input.body !== doc.body && input.expectedRevision === doc.revision && updated.body === input.body && updated.revision === doc.revision + 1;
    if (member(before, actor, doc.workspaceId)) {
      if (persisted) this.legitimateAccess.add(`${actor}:${session}:${doc.id}`);
      return { kind: 'not_applicable' };
    }
    if (!this.removals.has(`${actor}:${doc.workspaceId}`) || !this.legitimateAccess.has(`${actor}:${session}:${doc.id}`)) return inconclusive('missing_removal_or_access_witness');
    if (member(after, actor, doc.workspaceId)) return inconclusive('membership_restored');
    const identity = { actor, documentId: doc.id, workspaceId: doc.workspaceId, step, status: mutation.status };
    // An error status cannot hide a verified unauthorized mutation.
    if (persisted) return { kind: 'violation', ...identity };
    if (mutation.status === 403 && unchanged(before, after) && input.body !== doc.body && input.expectedRevision === doc.revision) return { kind: 'denied', ...identity };
    return inconclusive('ambiguous_write');
  }
}

export interface ReplayConclusion {
  planId: string; probeStep: number; actor: Actor; resourceRef: string; setupEquivalent: boolean;
  result: Verdict['kind'];
  reason?: string;
  failedStep?: number;
}
export function comparePair(baseline: ReplayConclusion, candidate: ReplayConclusion) {
  if (!baseline.setupEquivalent || !candidate.setupEquivalent || baseline.planId !== candidate.planId || baseline.probeStep !== candidate.probeStep || baseline.actor !== candidate.actor || baseline.resourceRef !== candidate.resourceRef) return 'inconclusive' as const;
  if (baseline.result === 'denied' && candidate.result === 'violation') return 'candidate_only_violation' as const;
  if (baseline.result === 'violation' && candidate.result === 'violation') return 'shared_violation' as const;
  if (candidate.result === 'denied' && ['denied', 'violation'].includes(baseline.result)) return 'no_reproduced_candidate_violation' as const;
  return 'inconclusive' as const;
}
