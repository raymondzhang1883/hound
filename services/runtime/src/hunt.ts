import { parseDecision, ContractError } from './contracts.js';
import type { BrowserExperiment, ReplayPlan } from './experiment.js';
import { comparePair, type ReplayConclusion } from './oracle.js';
import { INVARIANT, PolicyError, policyInput, historyItem, type HistoryItem, type Policy } from './policy.js';

type Experiment = Pick<BrowserExperiment, 'observations' | 'usage' | 'step' | 'plan' | 'replay' | 'close'>;
export interface ExperimentFactory {
  open(target: 'baseline' | 'candidate', options: { maxDecisions: number; deadlineMs: number; signal: AbortSignal }): Promise<Experiment>;
}
export interface HuntConfig {
  policy: Policy; factory: ExperimentFactory; signal?: AbortSignal;
  maxTrials?: number; maxDecisions?: number; discoveryMs?: number; verificationMs?: number;
  emit?: (event: { type: string; at: string; [key: string]: unknown }) => Promise<void>;
  savePlan?: (plan: ReplayPlan) => Promise<void>;
}
interface Trial { index: number; proposed: number; executed: number; denials: number; elapsedMs: number; reason: string }
export interface HuntResult {
  version: 1; invariantId: typeof INVARIANT.id; policy: Policy['metadata']; startedAt: string; finishedAt: string; elapsedMs: number;
  outcome: ReturnType<typeof comparePair> | 'no_suspicion' | 'provider_stopped' | 'cancelled'; reason?: string;
  suspicion: boolean; planId?: string; trials: Trial[]; replays?: { baseline: ReplayConclusion; candidate: ReplayConclusion };
  accounting: unknown;
}
class HuntError extends Error { constructor(readonly code: string) { super(code); } }
const codeOf = (error: unknown) => error instanceof HuntError || error instanceof PolicyError || error instanceof ContractError ? error.code : 'runtime_failed';

/** One naive loop. The policy proposes actions; only the deterministic runtime can establish a finding. */
export async function runHunt(config: HuntConfig): Promise<HuntResult> {
  const limits = { trials: config.maxTrials ?? 3, decisions: config.maxDecisions ?? 40,
    discovery: config.discoveryMs ?? 600_000, verification: config.verificationMs ?? 180_000 };
  if (!Number.isInteger(limits.trials) || limits.trials < 1 || limits.trials > 3 || !Number.isInteger(limits.decisions) || limits.decisions < 1 || limits.decisions > 40 ||
      !Number.isInteger(limits.discovery) || limits.discovery < 1 || limits.discovery > 600_000 || !Number.isInteger(limits.verification) || limits.verification < 1 || limits.verification > 600_000) throw new HuntError('invalid_hunt_budget');
  const started = Date.now();
  const deadline = started + limits.discovery;
  const discoveryTimer = AbortSignal.timeout(limits.discovery);
  const external = config.signal ?? new AbortController().signal;
  const discoverySignal = AbortSignal.any([external, discoveryTimer]);
  let activeSignal = discoverySignal;
  let stage: 'discovery' | 'verification' = 'discovery';
  const result: HuntResult = { version: 1, invariantId: INVARIANT.id, policy: config.policy.metadata, startedAt: new Date(started).toISOString(),
    finishedAt: '', elapsedMs: 0, outcome: 'no_suspicion', suspicion: false, trials: [], accounting: null };
  const emit = async (type: string, data: Record<string, unknown> = {}) => {
    try { await config.emit?.({ ...data, type, at: new Date().toISOString() }); }
    catch { throw new HuntError('journal_failed'); }
  };
  const check = (signal: AbortSignal) => { if (signal.aborted) throw new HuntError(external.aborted ? 'cancelled' : `${stage}_deadline`); };
  const close = async (run: Experiment) => { try { await run.close(); } catch { throw new HuntError('cleanup_failed'); } };
  let plan: ReplayPlan | undefined;
  try {
    await emit('hunt_started', { policy: result.policy, invariantId: INVARIANT.id, limits });
    for (let index = 0; index < limits.trials && !plan; index++) {
      check(discoverySignal);
      const start = Date.now();
      const trial: Trial = { index, proposed: 0, executed: 0, denials: 0, elapsedMs: 0, reason: 'decision_budget' };
      result.trials.push(trial);
      await emit('trial_started', { trial: index });
      let run: Experiment | undefined;
      const history: HistoryItem[] = [];
      try {
        run = await config.factory.open('candidate', { maxDecisions: limits.decisions, deadlineMs: Math.max(1, deadline - Date.now()), signal: discoverySignal });
        check(discoverySignal);
        for (let step = 0; step < limits.decisions; step++) {
          check(discoverySignal);
          const observations = run.observations();
          const input = policyInput(observations, history, limits.decisions - step);
          await emit('observation', { trial: index, step, observations });
          const callStarted = Date.now();
          let proposal: unknown;
          try { proposal = await config.policy.decide(input, discoverySignal); }
          catch (error) {
            trial.reason = codeOf(error);
            await emit('provider_stopped', { trial: index, step, code: trial.reason, elapsedMs: Date.now() - callStarted, accounting: config.policy.accounting() });
            throw error;
          }
          await emit('provider_completed', { trial: index, step, elapsedMs: Date.now() - callStarted, accounting: config.policy.accounting() });
          check(discoverySignal);
          trial.proposed++;
          const executed = await run.step(proposal);
          const item = historyItem(proposal, observations, executed.status, 'code' in executed ? executed.code : undefined);
          history.push(item);
          let record: unknown = { invalid: true };
          try { record = parseDecision(proposal); } catch { /* Never retain arbitrary invalid provider text. */ }
          await emit('decision', { trial: index, step, proposal: record, status: executed.status,
            ...('code' in executed ? { code: executed.code } : { verdict: executed.verdict.kind }) });
          if (executed.status === 'executed') {
            if (executed.verdict.kind === 'denied') trial.denials++;
            if (executed.verdict.kind === 'violation') {
              plan = run.plan(); result.suspicion = true; result.planId = plan.id; trial.reason = 'suspected_violation';
              try { await config.savePlan?.(plan); } catch { throw new HuntError('journal_failed'); }
              await emit('suspicion', { trial: index, planId: plan.id, probeActor: plan.probeActor, probeResource: plan.probeResource });
              break;
            }
          } else if (executed.status !== 'rejected') { trial.reason = executed.code; break; }
        }
      } catch (error) { trial.reason = codeOf(error); throw error; }
      finally {
        trial.elapsedMs = Date.now() - start;
        trial.executed = run?.usage.executed ?? 0;
        if (run) await close(run);
      }
      await emit('trial_finished', { ...trial });
    }
    if (plan) {
      stage = 'verification';
      const verificationDeadline = Date.now() + limits.verification;
      activeSignal = AbortSignal.any([external, AbortSignal.timeout(limits.verification)]);
      const conclusions: ReplayConclusion[] = [];
      for (const target of ['baseline', 'candidate'] as const) {
        check(activeSignal);
        await emit('replay_started', { target, planId: plan.id });
        let run: Experiment | undefined;
        try {
          run = await config.factory.open(target, { maxDecisions: plan.steps.length, deadlineMs: Math.max(1, verificationDeadline - Date.now()), signal: activeSignal });
          check(activeSignal);
          const replay = await run.replay(plan);
          check(activeSignal);
          conclusions.push(replay);
          await emit('replay_finished', { target, conclusion: replay });
        } finally { if (run) await close(run); }
      }
      result.replays = { baseline: conclusions[0]!, candidate: conclusions[1]! };
      result.outcome = comparePair(result.replays.baseline, result.replays.candidate);
    } else if (result.trials.some(trial => !['decision_budget', 'policy_stopped'].includes(trial.reason))) {
      result.outcome = 'inconclusive'; result.reason = 'discovery_incomplete';
    }
    check(activeSignal);
  } catch (error) {
    result.reason = codeOf(error);
    if (result.reason !== 'cleanup_failed' && activeSignal.aborted) result.reason = external.aborted ? 'cancelled' : `${stage}_deadline`;
    result.outcome = result.reason === 'cancelled' ? 'cancelled' : error instanceof PolicyError && !activeSignal.aborted ? 'provider_stopped' : 'inconclusive';
  }
  result.finishedAt = new Date().toISOString(); result.elapsedMs = Date.now() - started;
  result.accounting = config.policy.accounting();
  try { await emit('hunt_finished', { result }); }
  catch { result.outcome = 'inconclusive'; result.reason = 'journal_failed'; }
  return result;
}
