import { INVARIANT } from './policy.js';
import { dirname, relative, resolve, sep } from 'node:path';

const RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const REVISION = /^(?:[0-9a-f]{7,40}|unknown)$/;
const outcomes = ['candidate_only_violation', 'no_suspicion', 'provider_stopped', 'cancelled', 'inconclusive', 'shared_violation', 'no_reproduced_candidate_violation'] as const;
type Outcome = typeof outcomes[number];

export interface ReportAction { index: number; actor: 'alice' | 'bob'; kind: string; description: string; probe: boolean }
export interface ReportTrial { index: number; proposed: number; executed: number; denials: number; elapsedMs: number; reason: string }
export interface ReportProjection {
  version: 1;
  kind: 'hound-finding-report';
  generatedAt: string;
  runId: string;
  invariant: typeof INVARIANT;
  source: { revision: string; createdAt: string; case: 'positive' | 'negative' };
  finding: { outcome: Outcome; confirmed: boolean; title: string; summary: string; actor?: 'alice' | 'bob'; resource?: string };
  comparison?: {
    baseline: { result: string; setupEquivalent: boolean };
    candidate: { result: string; setupEquivalent: boolean };
  };
  exploration: {
    startedAt: string; finishedAt: string; elapsedMs: number; trials: ReportTrial[];
    planId?: string; originalActions: ReportAction[];
    policy: { provider: string; model: string; reasoning: string; promptVersion: string; simulated: boolean };
    accounting: { calls: number; unknownUsageCalls: number; estimatedCostUsd: number };
  };
  minimization?: {
    outcome: 'minimized' | 'unchanged'; originalLength: number; minimizedLength: number; deletionMinimal: boolean;
    attempts: number; acceptedDeletions: number; dependencySkips: number; confirmations: number; elapsedMs: number; modelCalls: number;
    planId: string; actions: ReportAction[];
  };
  regression?: { path: string; sha256: string; command: string; seededCommand: string };
}

export interface ReportInput {
  runId: string; config: unknown; result: unknown; plan?: unknown;
  minimization?: { config: unknown; result: unknown; plan: unknown };
  generatedAt?: string;
}

export interface ReportMinimizationInput { config: unknown; result: unknown; plan: unknown }

export class ReportError extends Error { constructor(readonly code: string) { super(code); } }
function fail(code: string): never { throw new ReportError(code); }
function object(value: unknown, code = 'invalid_report_record'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value as Record<string, unknown>;
}
function string(value: unknown, limit = 240, code = 'invalid_report_record'): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) fail(code);
  return value;
}
function number(value: unknown, max = Number.MAX_SAFE_INTEGER, code = 'invalid_report_record'): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) fail(code);
  return value;
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER, code = 'invalid_report_record'): number {
  const result = number(value, max, code); if (!Number.isInteger(result)) fail(code); return result;
}
function iso(value: unknown): string {
  const result = string(value, 40); if (!Number.isFinite(Date.parse(result))) fail('invalid_report_record'); return result;
}
function enumValue<T extends readonly string[]>(value: unknown, allowed: T): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) fail('invalid_report_record'); return value as T[number];
}
function safeLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._@/+:-]{1,100}$/.test(value)) return fallback;
  return value;
}

const knownControl = (raw: string, role: string) => {
  if (raw === 'Workspace name') return 'enters a workspace name';
  if (raw === 'Create workspace') return 'creates a workspace';
  if (raw === 'Send invitation') return 'sends Bob an invitation';
  if (raw === 'Workspaces') return 'opens the workspace list';
  if (raw === 'Accept invitation') return 'accepts the invitation';
  if (raw.includes('Open workspace')) return 'opens the shared workspace';
  if (raw.includes('Open document')) return 'opens the shared document';
  if (raw === '← Back to workspace') return 'returns to workspace membership';
  if (raw === 'Remove Bob') return 'removes Bob from the workspace';
  if (raw === 'Document body') return 'edits the document body';
  if (raw === 'Save document') return 'submits the document write';
  return `uses a ${['button', 'link', 'textbox', 'combobox'].includes(role) ? role : 'supported'} control`;
};

function actions(value: unknown, expectedId?: string): { id: string; probeActor: 'alice' | 'bob'; probeResource: string; actions: ReportAction[] } {
  const plan = object(value, 'invalid_report_plan');
  if (plan.version !== 1 || typeof plan.id !== 'string' || !HASH.test(plan.id) || (expectedId && plan.id !== expectedId) ||
      (plan.probeActor !== 'alice' && plan.probeActor !== 'bob') || typeof plan.probeResource !== 'string' || !/^[a-z]+_[1-9]\d*$/.test(plan.probeResource) ||
      !Array.isArray(plan.steps) || !plan.steps.length || plan.steps.length > 120) fail('invalid_report_plan');
  const id = plan.id as string; const probeActor = plan.probeActor as 'alice' | 'bob'; const probeResource = plan.probeResource as string;
  const steps = plan.steps as unknown[];
  const safe = steps.map((raw, index): ReportAction => {
    const step = object(raw, 'invalid_report_plan'); const action = object(step.action, 'invalid_report_plan');
    if ((action.actor !== 'alice' && action.actor !== 'bob') || !['click', 'fill', 'select', 'observe', 'navigate'].includes(String(action.kind))) fail('invalid_report_plan');
    let description: string;
    if (action.kind === 'observe') description = 'checks the current page';
    else if (action.kind === 'navigate') description = 'revisits an observed application page';
    else {
      const recipe = object(action.recipe, 'invalid_report_plan');
      const role = typeof recipe.role === 'string' ? recipe.role : recipe.by === 'label' ? 'textbox' : 'supported';
      const parts = Array.isArray(recipe.name) ? recipe.name : [];
      const rawName = parts.every(part => object(part, 'invalid_report_plan').literal !== undefined)
        ? parts.map(part => String(object(part, 'invalid_report_plan').literal)).join('') : '';
      description = knownControl(rawName, role);
    }
    return { index, actor: action.actor as 'alice' | 'bob', kind: String(action.kind), description, probe: index === steps.length - 1 };
  });
  return { id, probeActor, probeResource, actions: safe };
}

export function validateReportPlan(value: unknown, expectedId?: string) { return actions(value, expectedId); }

function replay(value: unknown, expectedPlanId: string) {
  const data = object(value); const planId = string(data.planId, 64);
  if (planId !== expectedPlanId || typeof data.setupEquivalent !== 'boolean') fail('inconsistent_report_record');
  const setupEquivalent = data.setupEquivalent as boolean;
  return {
    result: enumValue(data.result, ['denied', 'violation', 'not_applicable', 'inconclusive'] as const),
    setupEquivalent,
    actor: enumValue(data.actor, ['alice', 'bob'] as const),
    resource: string(data.resourceRef, 80),
  };
}

export function buildReportProjection(input: ReportInput): ReportProjection {
  if (!RUN_ID.test(input.runId)) fail('invalid_run_id');
  const config = object(input.config); const result = object(input.result);
  if (config.version !== 1 || result.version !== 1) fail('unsupported_report_version');
  if (result.invariantId !== INVARIANT.id) fail('inconsistent_report_record');
  const revision = string(config.revision, 40); if (!REVISION.test(revision)) fail('invalid_report_record');
  const caseName = enumValue(config.case, ['positive', 'negative'] as const);
  const outcome = enumValue(result.outcome, outcomes);
  const planId = typeof result.planId === 'string' && HASH.test(result.planId) ? result.planId : undefined;
  const sourcePlan = input.plan === undefined ? undefined : actions(input.plan, planId);
  if (planId && !sourcePlan) fail('missing_report_plan');
  const policy = object(result.policy); const accounting = object(result.accounting);
  if (!Array.isArray(result.trials)) fail('invalid_report_record');
  const rawTrials = result.trials as unknown[];
  const trials = rawTrials.map((raw): ReportTrial => {
    const trial = object(raw);
    return { index: integer(trial.index, 20), proposed: integer(trial.proposed, 10_000), executed: integer(trial.executed, 10_000),
      denials: integer(trial.denials, 10_000), elapsedMs: integer(trial.elapsedMs, 3_600_000), reason: safeLabel(trial.reason, 'unknown') };
  });
  let comparison: ReportProjection['comparison']; let actor: 'alice' | 'bob' | undefined; let resource: string | undefined;
  if (result.replays !== undefined) {
    if (!planId) fail('inconsistent_report_record');
    const pair = object(result.replays); const baseline = replay(pair.baseline, planId); const candidate = replay(pair.candidate, planId);
    if (baseline.actor !== candidate.actor || baseline.resource !== candidate.resource) fail('inconsistent_report_record');
    if (sourcePlan && (sourcePlan.probeActor !== candidate.actor || sourcePlan.probeResource !== candidate.resource)) fail('inconsistent_report_record');
    actor = candidate.actor; resource = candidate.resource;
    comparison = { baseline: { result: baseline.result, setupEquivalent: baseline.setupEquivalent }, candidate: { result: candidate.result, setupEquivalent: candidate.setupEquivalent } };
  }
  const confirmed = outcome === 'candidate_only_violation' && comparison?.baseline.result === 'denied' && comparison.candidate.result === 'violation' &&
    comparison.baseline.setupEquivalent && comparison.candidate.setupEquivalent;
  if (confirmed && caseName !== 'positive') fail('inconsistent_report_record');
  const finding = confirmed ? {
    outcome, confirmed, title: 'Removed member retained document write access',
    summary: 'Fresh paired replay denied the write on the baseline and reproduced the persisted unauthorized write on the candidate.',
    ...(actor ? { actor } : {}), ...(resource ? { resource } : {}),
  } : {
    outcome, confirmed: false, title: outcome === 'no_suspicion' ? 'No candidate-only suspicion observed' : 'Run did not produce a confirmed finding',
    summary: 'This result is not a security pass. Review the terminal outcome and private journal before drawing a conclusion.',
  };
  const projection: ReportProjection = {
    version: 1, kind: 'hound-finding-report', generatedAt: input.generatedAt ? iso(input.generatedAt) : new Date().toISOString(), runId: input.runId,
    invariant: INVARIANT, source: { revision, createdAt: iso(config.createdAt), case: caseName }, finding, ...(comparison ? { comparison } : {}),
    exploration: {
      startedAt: iso(result.startedAt), finishedAt: iso(result.finishedAt), elapsedMs: integer(result.elapsedMs, 3_600_000), trials,
      ...(planId ? { planId } : {}), originalActions: sourcePlan?.actions ?? [],
      policy: { provider: safeLabel(policy.provider, 'unknown'), model: safeLabel(policy.model, 'unknown'), reasoning: safeLabel(policy.reasoning, 'unknown'),
        promptVersion: safeLabel(policy.promptVersion, 'unknown'), simulated: policy.simulated === true },
      accounting: { calls: integer(accounting.calls, 100_000), unknownUsageCalls: integer(accounting.unknownUsageCalls, 100_000), estimatedCostUsd: number(accounting.estimatedCostUsd, 10_000) },
    },
  };
  return input.minimization ? attachMinimizationProjection(projection, input.minimization) : projection;
}

export function attachMinimizationProjection(source: ReportProjection, input: ReportMinimizationInput): ReportProjection {
  const projection = structuredClone(source);
  const sourcePlanId = projection.exploration.planId;
  if (!projection.finding.confirmed || !sourcePlanId || projection.minimization || projection.regression) fail('minimization_without_finding');
  const minConfig = object(input.config); const minResult = object(input.result);
  if (minConfig.version !== 1 || minResult.version !== 1 || minConfig.sourceRunId !== projection.runId || minConfig.sourcePlanId !== sourcePlanId) fail('inconsistent_minimization_record');
  const minOutcome = enumValue(minResult.outcome, ['minimized', 'unchanged'] as const);
  if (minResult.deletionMinimal !== true || !Array.isArray(minResult.attempts) || !Array.isArray(minResult.confirmations) ||
      minResult.confirmations.length < 1 || minResult.confirmations.length > 5 ||
      minResult.confirmations.some(item => object(item).outcome !== 'candidate_only_violation')) fail('unconfirmed_minimization_record');
  const minPlan = actions(input.plan);
  const rawAttempts = minResult.attempts as unknown[]; const rawConfirmations = minResult.confirmations as unknown[];
  const attempts = rawAttempts.map(item => object(item));
  const originalLength = integer(minResult.originalLength, 120); const minimizedLength = integer(minResult.minimizedLength, 120);
  if (originalLength !== projection.exploration.originalActions.length || minimizedLength !== minPlan.actions.length ||
      minPlan.probeActor !== projection.finding.actor || minPlan.probeResource !== projection.finding.resource) fail('inconsistent_minimization_record');
  projection.minimization = {
    outcome: minOutcome, originalLength, minimizedLength, deletionMinimal: true,
    attempts: attempts.length, acceptedDeletions: attempts.filter(item => item.accepted === true).length,
    dependencySkips: attempts.filter(item => item.reason === 'dependency_required').length, confirmations: rawConfirmations.length,
    elapsedMs: integer(minResult.elapsedMs, 3_600_000), modelCalls: integer(minResult.modelCalls, 100_000), planId: minPlan.id, actions: minPlan.actions,
  };
  const generated = object(minResult.generated, 'missing_generated_regression');
  if (generated.path !== 'generated-tests/removed-member-write.spec.ts' || typeof generated.sha256 !== 'string' || !HASH.test(generated.sha256)) fail('invalid_generated_regression');
  projection.regression = { path: generated.path as string, sha256: generated.sha256 as string, command: 'npm run test:generated', seededCommand: 'HOUND_FIXTURE_MODE=stale-write npm run test:generated' };
  return projection;
}

const escape = (value: unknown) => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const duration = (ms: number) => ms < 1_000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1_000).toFixed(1)} s` : `${(ms / 60_000).toFixed(1)} min`;
const money = (value: number) => `$${value.toFixed(4)}`;
const counted = (value: number, singular: string, plural = `${singular}s`) => `${value} ${value === 1 ? singular : plural}`;
const titleCase = (value: string) => value.replaceAll('_', ' ').replace(/\b\w/g, part => part.toUpperCase());
const actionList = (items: ReportAction[], label: string) => `<ol class="timeline" aria-label="${escape(label)}">${items.map(item => `<li class="action ${item.probe ? 'probe' : ''}">
  <span class="step">${item.index + 1}</span><span class="actor ${item.actor}">${escape(item.actor)}</span>
  <span class="action-copy"><strong>${escape(item.description)}</strong><small>${escape(item.kind)}${item.probe ? ' · protected probe' : ''}</small></span>
</li>`).join('')}</ol>`;

export function renderHtmlReport(report: ReportProjection) {
  if (report.version !== 1 || report.kind !== 'hound-finding-report') fail('unsupported_report_projection');
  const minimized = report.minimization;
  const status = report.finding.confirmed ? 'Confirmed regression' : titleCase(report.finding.outcome);
  const comparison = report.comparison ? `<div class="comparison">
    <article><span class="eyebrow">Baseline</span><strong class="good">${escape(titleCase(report.comparison.baseline.result))}</strong><p>Correct deployment rejected the protected write.</p></article>
    <div class="versus" aria-hidden="true">vs</div>
    <article><span class="eyebrow">Candidate</span><strong class="bad">${escape(titleCase(report.comparison.candidate.result))}</strong><p>Candidate persisted the removed member's write.</p></article>
  </div>` : '<p class="empty">No comparable paired replay was recorded.</p>';
  const metrics = [
    ['Exploration', duration(report.exploration.elapsedMs), counted(report.exploration.trials.length, 'trial')],
    ['Model calls', report.exploration.accounting.calls, money(report.exploration.accounting.estimatedCostUsd)],
    ['Trajectory', minimized ? `${minimized.originalLength} → ${minimized.minimizedLength}` : report.exploration.originalActions.length, minimized ? 'deletion-minimal' : 'original actions'],
    ['Confirmations', minimized?.confirmations ?? 0, minimized ? 'fresh paired replays' : 'not minimized'],
  ];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><title>Hound report · ${escape(report.runId)}</title>
<style>
:root{--ink:#f4f0e8;--muted:#aaa59b;--panel:#171817;--line:#30322e;--acid:#d7f861;--red:#ff796f;--blue:#7fc7ff;--bg:#0d0e0d}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body:before{content:"";position:fixed;inset:0;pointer-events:none;background:radial-gradient(circle at 85% 5%,rgba(215,248,97,.09),transparent 28rem),linear-gradient(rgba(255,255,255,.016) 1px,transparent 1px);background-size:auto,100% 32px}.shell{position:relative;max-width:1120px;margin:auto;padding:48px 28px 80px}.brand{display:flex;align-items:center;gap:12px;font-weight:800;letter-spacing:.18em;text-transform:uppercase}.mark{display:grid;place-items:center;width:32px;height:32px;border:1px solid var(--acid);border-radius:50%;color:var(--acid)}.hero{padding:92px 0 48px;max-width:880px}.kicker,.eyebrow{color:var(--acid);font:700 11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase}.hero h1{font-size:clamp(44px,8vw,92px);line-height:.94;letter-spacing:-.055em;margin:16px 0 24px;max-width:900px}.lede{font-size:19px;color:#cbc7bf;max-width:730px}.status{display:inline-flex;align-items:center;gap:9px;border:1px solid #526018;background:#1a200e;color:var(--acid);padding:8px 12px;border-radius:999px;font-weight:700}.status:before{content:"";width:8px;height:8px;border-radius:50%;background:var(--acid);box-shadow:0 0 14px var(--acid)}.meta{margin-top:28px;color:var(--muted);font:12px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.metrics{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--line);border-radius:16px;overflow:hidden;background:var(--panel)}.metric{padding:24px;border-right:1px solid var(--line)}.metric:last-child{border:0}.metric span{display:block;color:var(--muted);font-size:12px}.metric strong{display:block;font-size:30px;letter-spacing:-.04em;margin:7px 0 2px}.section{padding:72px 0 0}.section-head{display:flex;align-items:end;justify-content:space-between;gap:24px;margin-bottom:24px}.section h2{font-size:32px;letter-spacing:-.035em;margin:6px 0}.section-head p{max-width:480px;color:var(--muted);margin:0}.comparison{display:grid;grid-template-columns:1fr auto 1fr;gap:20px;align-items:stretch}.comparison article,.card{border:1px solid var(--line);border-radius:16px;background:var(--panel);padding:28px}.comparison strong{display:block;font-size:42px;letter-spacing:-.04em;margin:28px 0 4px}.comparison p{color:var(--muted);margin:0}.good{color:var(--blue)}.bad{color:var(--red)}.versus{align-self:center;color:var(--muted);font:12px ui-monospace,SFMono-Regular,Menlo,monospace}.timeline{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:16px;overflow:hidden;background:var(--panel)}.action{display:grid;grid-template-columns:36px 72px 1fr;align-items:center;gap:14px;padding:15px 20px;border-bottom:1px solid var(--line)}.action:last-child{border:0}.action.probe{background:linear-gradient(90deg,rgba(255,121,111,.09),transparent)}.step{display:grid;place-items:center;width:28px;height:28px;border:1px solid var(--line);border-radius:50%;font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}.actor{font:700 11px ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase}.actor.alice{color:var(--acid)}.actor.bob{color:var(--blue)}.action-copy{display:flex;justify-content:space-between;align-items:center;gap:14px}.action-copy small{color:var(--muted);font:11px ui-monospace,SFMono-Regular,Menlo,monospace}.split{display:grid;grid-template-columns:1fr 1fr;gap:20px}.code{white-space:pre-wrap;overflow-wrap:anywhere;background:#090a09;border:1px solid var(--line);border-radius:12px;padding:18px;color:#d9e7bd;font:12px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace}.facts{display:grid;grid-template-columns:auto 1fr;gap:9px 20px;margin:0}.facts dt{color:var(--muted)}.facts dd{margin:0;font-weight:650;overflow-wrap:anywhere}.footer{margin-top:72px;padding-top:24px;border-top:1px solid var(--line);display:flex;justify-content:space-between;color:var(--muted);font-size:12px}.empty{border:1px dashed var(--line);border-radius:16px;padding:28px;color:var(--muted)}@media(max-width:760px){.shell{padding:28px 18px 56px}.hero{padding-top:64px}.metrics{grid-template-columns:1fr 1fr}.metric:nth-child(2){border-right:0}.metric:nth-child(-n+2){border-bottom:1px solid var(--line)}.comparison,.split{grid-template-columns:1fr}.versus{display:none}.action{grid-template-columns:32px 58px 1fr;padding:14px 12px}.action-copy{display:block}.action-copy small{display:block;margin-top:3px}.section-head{display:block}.footer{display:block}}@media print{body{background:#fff;color:#111}body:before{display:none}.shell{max-width:none}.card,.comparison article,.metrics,.timeline{background:#fff;break-inside:avoid}.section{break-inside:avoid}.meta,.metric span,.comparison p,.section-head p,.facts dt,.action-copy small,.footer{color:#555}}
</style></head><body><main class="shell">
<header class="brand"><span class="mark">H</span> Hound <span class="eyebrow">Finding report</span></header>
<section class="hero"><span class="status">${escape(status)}</span><h1>${escape(report.finding.title)}</h1><p class="lede">${escape(report.finding.summary)}</p>
<div class="meta">Run ${escape(report.runId)}<br>Invariant ${escape(report.invariant.id)} · Revision ${escape(report.source.revision.slice(0, 12))} · Generated ${escape(report.generatedAt)}</div></section>
<section class="metrics">${metrics.map(([label, value, note]) => `<div class="metric"><span>${escape(label)}</span><strong>${escape(value)}</strong><span>${escape(note)}</span></div>`).join('')}</section>
<section class="section"><div class="section-head"><div><span class="eyebrow">Paired oracle</span><h2>Same setup. Different authorization.</h2></div><p>${escape(report.invariant.text)}</p></div>${comparison}</section>
${minimized ? `<section class="section"><div class="section-head"><div><span class="eyebrow">Counterexample</span><h2>Deletion-minimal reproduction</h2></div><p>${counted(minimized.attempts, 'proposal')}, ${counted(minimized.acceptedDeletions, 'accepted deletion')}, ${counted(minimized.dependencySkips, 'dependency skip')}, and ${counted(minimized.confirmations, 'fresh confirmation')}.</p></div>${actionList(minimized.actions, 'Minimized browser actions')}</section>` : report.exploration.originalActions.length ? `<section class="section"><div class="section-head"><div><span class="eyebrow">Trajectory</span><h2>Original reproduction</h2></div></div>${actionList(report.exploration.originalActions, 'Original browser actions')}</section>` : ''}
<section class="section"><div class="section-head"><div><span class="eyebrow">Run record</span><h2>Evidence at a glance</h2></div><p>Allowlisted projection only. Raw observations, credentials, provider text, HTTP bodies, and private journal paths are excluded.</p></div><div class="split">
<article class="card"><dl class="facts"><dt>Policy</dt><dd>${escape(report.exploration.policy.promptVersion)}</dd><dt>Model</dt><dd>${escape(report.exploration.policy.model)}</dd><dt>Trials</dt><dd>${report.exploration.trials.length}</dd><dt>Elapsed</dt><dd>${escape(duration(report.exploration.elapsedMs))}</dd><dt>Estimated cost</dt><dd>${escape(money(report.exploration.accounting.estimatedCostUsd))}</dd><dt>Unknown usage calls</dt><dd>${report.exploration.accounting.unknownUsageCalls}</dd>${minimized ? `<dt>Minimizer</dt><dd>${escape(duration(minimized.elapsedMs))} · ${counted(minimized.modelCalls, 'model call')}</dd>` : ''}</dl></article>
<article class="card"><span class="eyebrow">Generated regression</span>${report.regression ? `<p><strong>${escape(report.regression.path)}</strong></p><div class="code">${escape(report.regression.command)}\n\n# Expected to fail with the seeded regression\n${escape(report.regression.seededCommand)}</div><p class="meta">SHA-256 ${escape(report.regression.sha256)}</p>` : '<p class="empty">No confirmed generated regression is attached.</p>'}</article></div></section>
<footer class="footer"><span>Generated by the Hound CLI · static secondary artifact</span><span>CLI records remain the source of truth</span></footer>
</main></body></html>`;
}

export function terminalSummary(report: ReportProjection) {
  const lines = [
    `${report.finding.confirmed ? 'CONFIRMED' : 'RESULT'}  ${report.finding.title}`,
    `Run        ${report.runId}`,
    `Outcome    ${report.finding.outcome}`,
    `Invariant  ${report.invariant.text}`,
  ];
  if (report.comparison) lines.push(`Pair       baseline=${report.comparison.baseline.result} candidate=${report.comparison.candidate.result}`);
  lines.push(`Explore    ${counted(report.exploration.trials.length, 'trial')} · ${counted(report.exploration.accounting.calls, 'model call')} · ${money(report.exploration.accounting.estimatedCostUsd)} · ${duration(report.exploration.elapsedMs)}`);
  if (report.minimization) lines.push(`Minimize   ${report.minimization.originalLength} → ${report.minimization.minimizedLength} actions · ${counted(report.minimization.confirmations, 'confirmation')} · ${counted(report.minimization.modelCalls, 'model call')}`);
  if (report.regression) lines.push(`Regression ${report.regression.path}`);
  return lines.join('\n');
}

export const reportRunIdPattern = RUN_ID;

/** Returns output parents below a normalized workspace root, stopping safely at the filesystem root. */
export function reportOutputAncestors(workspaceRoot: string, outputPath: string) {
  const root = resolve(workspaceRoot); const output = resolve(outputPath); const within = relative(root, output);
  if (!within || within === '..' || within.startsWith(`..${sep}`)) fail('invalid_output_path');
  const parents: string[] = []; let cursor = dirname(output);
  while (cursor !== root) {
    const next = dirname(cursor); if (next === cursor) fail('invalid_output_path');
    parents.push(cursor); cursor = next;
  }
  return parents;
}
