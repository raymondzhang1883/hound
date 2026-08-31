import { comparePair, type ReplayConclusion } from './oracle.js';
import type { Actor, TextTemplate } from './contracts.js';
import type { BrowserExperiment, RecordedAction, ReplayPlan, RecordResult } from './experiment.js';

type ReductionExperiment = Pick<BrowserExperiment, 'record' | 'replay' | 'close'>;
export interface MinimizerFactory {
  open(target: 'baseline' | 'candidate', options: { maxDecisions: number; deadlineMs: number; signal: AbortSignal }): Promise<ReductionExperiment>;
}
export interface MinimizerConfig {
  plan: ReplayPlan; factory: MinimizerFactory; signal?: AbortSignal;
  maxAttempts?: number; deadlineMs?: number; confirmations?: number;
  emit?: (event: { type: string; at: string; [key: string]: unknown }) => Promise<void>;
}
export interface ReductionAttempt {
  index: number; beforeLength: number; candidateLength: number; removed: number[]; dependencySafe: boolean;
  accepted: boolean; elapsedMs: number; reason: string;
  candidate?: { status: 'recorded'; conclusion: ReplayConclusion } | { status: 'inconclusive'; reason: string; failedStep?: number };
  baseline?: ReplayConclusion;
}
export interface ConfirmationAttempt { index: number; elapsedMs: number; outcome: ReturnType<typeof comparePair>; baseline: ReplayConclusion; candidate: ReplayConclusion }
export interface MinimizationResult {
  version: 1; outcome: 'minimized' | 'unchanged' | 'inconclusive' | 'cancelled'; reason?: string;
  originalPlanId: string; originalLength: number; minimizedLength: number; deletionMinimal: boolean;
  initialVerification?: ConfirmationAttempt; attempts: ReductionAttempt[]; confirmations: ConfirmationAttempt[]; elapsedMs: number; plan: ReplayPlan;
}
class MinimizerError extends Error { constructor(readonly code: string) { super(code); } }
const resourceRef = /^(?:workspace|document|invitation)_[1-9]\d*$/;

function templateReferences(template: TextTemplate) {
  return template.flatMap(part => 'ref' in part && resourceRef.test(part.ref) ? [part.ref] : []);
}
export function actionReferences(action: RecordedAction) {
  const refs: string[] = [];
  if ('recipe' in action) {
    refs.push(...templateReferences(action.recipe.name));
    if (action.recipe.scope) refs.push(...templateReferences(action.recipe.scope.name));
  }
  if (action.kind === 'navigate') {
    const ref = action.routeRef.endsWith('.page') ? action.routeRef.slice(0, -5) : action.routeRef;
    if (resourceRef.test(ref)) refs.push(ref);
  }
  if (action.kind === 'fill' && 'ref' in action.value && resourceRef.test(action.value.ref)) refs.push(action.value.ref);
  return [...new Set(refs)];
}
function origins(plan: ReplayPlan) {
  const result = new Map<string, number>();
  for (let index = 0; index < plan.steps.length; index++) {
    for (const ref of [...templateReferences(plan.steps[index]!.after), ...templateReferences(plan.steps[index]!.http)]) {
      if (!result.has(ref)) result.set(ref, index);
    }
  }
  return result;
}
export function dependencySafeDeletion(plan: ReplayPlan, removed: number[]) {
  const omitted = new Set(removed);
  if (omitted.has(plan.steps.length - 1)) return false;
  const origin = origins(plan);
  const required = new Set([plan.probeResource]);
  for (let index = 0; index < plan.steps.length; index++) if (!omitted.has(index)) {
    for (const ref of actionReferences(plan.steps[index]!.action)) required.add(ref);
  }
  return [...required].every(ref => origin.get(ref) === undefined || !omitted.has(origin.get(ref)!));
}
const chunks = (items: number[], count: number) => {
  const result: number[][] = [];
  for (let start = 0; start < items.length; start += Math.ceil(items.length / count)) result.push(items.slice(start, start + Math.ceil(items.length / count)));
  return result;
};

/** Dependency-aware, fresh-state delta debugging. It establishes deletion-minimality only under this tested strategy. */
export async function minimize(config: MinimizerConfig): Promise<MinimizationResult> {
  const limits = { attempts: config.maxAttempts ?? 80, deadline: config.deadlineMs ?? 600_000, confirmations: config.confirmations ?? 3 };
  if (!Number.isInteger(limits.attempts) || limits.attempts < 1 || limits.attempts > 200 || !Number.isInteger(limits.deadline) || limits.deadline < 1 || limits.deadline > 600_000 ||
      !Number.isInteger(limits.confirmations) || limits.confirmations < 1 || limits.confirmations > 5) throw new MinimizerError('invalid_minimizer_limits');
  if (config.plan.version !== 1 || !config.plan.steps.length || config.plan.steps.length > 120) throw new MinimizerError('invalid_minimizer_plan');
  const started = Date.now(); const deadline = started + limits.deadline;
  const external = config.signal ?? new AbortController().signal;
  const timer = AbortSignal.timeout(limits.deadline); const signal = AbortSignal.any([external, timer]);
  const attempts: ReductionAttempt[] = []; const confirmations: ConfirmationAttempt[] = [];
  let current = structuredClone(config.plan); let deletionMinimal = false; let reason: string | undefined;
  const emit = async (type: string, data: Record<string, unknown> = {}) => {
    try { await config.emit?.({ ...data, type, at: new Date().toISOString() }); } catch { throw new MinimizerError('journal_failed'); }
  };
  const check = () => { if (signal.aborted) throw new MinimizerError(external.aborted ? 'cancelled' : 'minimization_deadline'); };
  const open = async (target: 'baseline' | 'candidate', decisions: number) => {
    check();
    try { return await config.factory.open(target, { maxDecisions: decisions, deadlineMs: Math.max(1, deadline - Date.now()), signal }); }
    catch { throw new MinimizerError('minimizer_open_failed'); }
  };
  const close = async (run: ReductionExperiment) => { try { await run.close(); } catch { throw new MinimizerError('cleanup_failed'); } };
  const evaluate = async (plan: ReplayPlan, removed: number[]) => {
    check(); const index = attempts.length; const began = Date.now();
    const candidateLength = plan.steps.length - removed.length;
    const attempt: ReductionAttempt = { index, beforeLength: plan.steps.length, candidateLength, removed: [...removed],
      dependencySafe: dependencySafeDeletion(plan, removed), accepted: false, elapsedMs: 0, reason: 'dependency_required' };
    attempts.push(attempt);
    if (!attempt.dependencySafe) { attempt.elapsedMs = Date.now() - began; await emit('reduction_attempt', { attempt }); return undefined; }
    const actions = plan.steps.filter((_, position) => !removed.includes(position)).map(step => structuredClone(step.action));
    let candidate: ReductionExperiment | undefined; let recorded: RecordResult;
    try {
      candidate = await open('candidate', actions.length);
      recorded = await candidate.record(actions, { actor: plan.probeActor, resourceRef: plan.probeResource });
    } finally { if (candidate) await close(candidate); }
    attempt.candidate = recorded!.status === 'recorded' ? { status: 'recorded', conclusion: recorded!.conclusion } : recorded!;
    if (recorded!.status !== 'recorded') {
      attempt.reason = `candidate_${recorded!.reason}`; attempt.elapsedMs = Date.now() - began;
      await emit('reduction_attempt', { attempt }); return undefined;
    }
    let baseline: ReductionExperiment | undefined;
    try { baseline = await open('baseline', recorded!.plan.steps.length); attempt.baseline = await baseline.replay(recorded!.plan); }
    finally { if (baseline) await close(baseline); }
    const outcome = comparePair(attempt.baseline, recorded!.conclusion);
    attempt.accepted = outcome === 'candidate_only_violation'; attempt.reason = outcome; attempt.elapsedMs = Date.now() - began;
    await emit('reduction_attempt', { attempt });
    return attempt.accepted ? recorded!.plan : undefined;
  };
  const verify = async (plan: ReplayPlan, index: number) => {
    check(); const began = Date.now(); let baselineRun: ReductionExperiment | undefined; let candidateRun: ReductionExperiment | undefined;
    let baseline: ReplayConclusion; let candidate: ReplayConclusion;
    try { baselineRun = await open('baseline', plan.steps.length); baseline = await baselineRun.replay(plan); }
    finally { if (baselineRun) await close(baselineRun); }
    try { candidateRun = await open('candidate', plan.steps.length); candidate = await candidateRun.replay(plan); }
    finally { if (candidateRun) await close(candidateRun); }
    const confirmation = { index, elapsedMs: Date.now() - began, outcome: comparePair(baseline!, candidate!), baseline: baseline!, candidate: candidate! };
    confirmations.push(confirmation); await emit('minimization_confirmation', { confirmation }); return confirmation;
  };
  let initialVerification: ConfirmationAttempt | undefined;
  try {
    await emit('minimization_started', { planId: current.id, originalLength: current.steps.length, limits });
    initialVerification = await verify(current, -1);
    if (initialVerification.outcome !== 'candidate_only_violation') throw new MinimizerError('initial_pair_not_reproduced');
    confirmations.length = 0;
    let granularity = 2;
    while (current.steps.length > 1 && attempts.length < limits.attempts) {
      check(); const removable = Array.from({ length: current.steps.length - 1 }, (_, index) => index);
      if (!removable.length) break;
      let reduced = false;
      for (const removed of chunks(removable, Math.min(granularity, removable.length))) {
        if (attempts.length >= limits.attempts) break;
        const next = await evaluate(current, removed);
        if (next) { current = next; granularity = 2; reduced = true; break; }
      }
      if (reduced) continue;
      if (granularity >= removable.length) break;
      granularity = Math.min(removable.length, granularity * 2);
    }
    // Explicit single-deletion fixed point establishes the reported local property.
    let changed = true;
    while (changed && attempts.length < limits.attempts) {
      changed = false;
      for (let index = 0; index < current.steps.length - 1 && attempts.length < limits.attempts; index++) {
        const next = await evaluate(current, [index]);
        if (next) { current = next; changed = true; break; }
      }
    }
    deletionMinimal = !changed && attempts.length < limits.attempts;
    if (!deletionMinimal) reason = 'attempt_budget';
    for (let index = 0; index < limits.confirmations; index++) {
      const confirmation = await verify(current, index);
      if (confirmation.outcome !== 'candidate_only_violation') throw new MinimizerError('confirmation_failed');
    }
  } catch (error) {
    reason = error instanceof MinimizerError ? error.code : 'minimization_failed';
  }
  const outcome = reason === 'cancelled' ? 'cancelled' : reason && reason !== 'attempt_budget' ? 'inconclusive' :
    current.steps.length < config.plan.steps.length ? 'minimized' : 'unchanged';
  const result: MinimizationResult = { version: 1, outcome, ...(reason ? { reason } : {}), originalPlanId: config.plan.id,
    originalLength: config.plan.steps.length, minimizedLength: current.steps.length, deletionMinimal, ...(initialVerification ? { initialVerification } : {}), attempts, confirmations,
    elapsedMs: Date.now() - started, plan: current };
  try { await emit('minimization_finished', { result }); }
  catch { result.outcome = 'inconclusive'; result.reason = 'journal_failed'; result.deletionMinimal = false; }
  return result;
}
