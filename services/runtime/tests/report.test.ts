import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildReportProjection, renderHtmlReport, reportOutputAncestors, ReportError, terminalSummary } from '../src/report.js';

const runId = '2026-08-31T21-20-39.250Z-1307548c-9f96-4905-9cd4-c427db07b4a2';
const sourcePlanId = '4'.repeat(64); const minimizedPlanId = 'b'.repeat(64);
const step = (name: string, actor: 'alice' | 'bob' = 'alice', kind: 'click' | 'fill' = 'click') => ({
  action: { actor, kind, recipe: { by: 'role', role: kind === 'fill' ? 'textbox' : 'button', name: [{ literal: name }] },
    ...(kind === 'fill' ? { value: { literal: '<script>private-input</script>' } } : {}) },
  before: [{ literal: '{}' }], after: [{ literal: '{}' }], http: [{ literal: '[]' }],
});
const plan = (id: string, steps: unknown[]) => ({ version: 1, id, probeActor: 'bob', probeResource: 'document_1', steps });
const config = { version: 1, revision: 'a'.repeat(40), case: 'positive', createdAt: '2026-08-31T21:20:39.450Z' };
const result = {
  version: 1, invariantId: 'removed-member-write@1', startedAt: '2026-08-31T21:20:39.450Z', finishedAt: '2026-08-31T21:22:52.674Z', elapsedMs: 133224,
  outcome: 'candidate_only_violation', suspicion: true, planId: sourcePlanId,
  policy: { provider: 'openai', model: '<script>model</script>', reasoning: 'medium', promptVersion: 'hound-simple-browser@2', simulated: false },
  trials: [{ index: 0, proposed: 4, executed: 3, denials: 0, elapsedMs: 1200, reason: 'suspected_violation' }],
  replays: {
    baseline: { planId: sourcePlanId, probeStep: 1, actor: 'bob', resourceRef: 'document_1', setupEquivalent: true, result: 'denied' },
    candidate: { planId: sourcePlanId, probeStep: 1, actor: 'bob', resourceRef: 'document_1', setupEquivalent: true, result: 'violation' },
  },
  accounting: { calls: 4, unknownUsageCalls: 0, estimatedCostUsd: 0.0123 },
};
const minimization = {
  config: { version: 1, sourceRunId: runId, sourcePlanId },
  result: { version: 1, outcome: 'minimized', originalLength: 2, minimizedLength: 1, deletionMinimal: true,
    attempts: [{ accepted: true, reason: 'candidate_only_violation' }, { accepted: false, reason: 'dependency_required' }],
    confirmations: [{ outcome: 'candidate_only_violation' }, { outcome: 'candidate_only_violation' }, { outcome: 'candidate_only_violation' }],
    elapsedMs: 2200, modelCalls: 0, generated: { path: 'generated-tests/removed-member-write.spec.ts', sha256: 'd'.repeat(64) } },
  plan: plan(minimizedPlanId, [step('<img src=x onerror=alert(1)>', 'bob', 'fill')]),
};

it('projects only allowlisted finding data and renders a self-contained CLI-secondary report', () => {
  const report = buildReportProjection({ runId, config, result, plan: plan(sourcePlanId, [step('Create workspace'), step('Save document', 'bob')]), minimization,
    generatedAt: '2026-08-31T23:00:00.000Z' });
  assert.equal(report.finding.confirmed, true);
  assert.equal(report.exploration.policy.model, 'unknown');
  assert.deepEqual(report.minimization && { length: report.minimization.minimizedLength, attempts: report.minimization.attempts,
    accepted: report.minimization.acceptedDeletions, skips: report.minimization.dependencySkips, confirmations: report.minimization.confirmations },
    { length: 1, attempts: 2, accepted: 1, skips: 1, confirmations: 3 });
  const serialized = JSON.stringify(report); const html = renderHtmlReport(report);
  for (const forbidden of ['private-input', '<script>model', '<img src=x', 'harnessKey', '.hound/runs']) {
    assert.ok(!serialized.includes(forbidden), `projection retained ${forbidden}`); assert.ok(!html.includes(forbidden), `HTML retained ${forbidden}`);
  }
  assert.ok(!Object.hasOwn(report, 'observations'));
  assert.match(html, /static secondary artifact/); assert.match(html, /CLI records remain the source of truth/);
  assert.ok(!/<script\b/i.test(html)); assert.ok(!/<link\b/i.test(html));
  assert.match(terminalSummary(report), /CONFIRMED/); assert.match(terminalSummary(report), /14|2 → 1|Minimize/);
});

it('refuses inconsistent and unconfirmed minimization records', () => {
  assert.throws(() => buildReportProjection({ runId, config, result, plan: plan(sourcePlanId, [step('Save document', 'bob')]),
    minimization: { ...minimization, config: { version: 1, sourceRunId: runId, sourcePlanId: '0'.repeat(64) } } }),
    (error: unknown) => error instanceof ReportError && error.code === 'inconsistent_minimization_record');
  assert.throws(() => buildReportProjection({ runId, config, result, plan: plan(sourcePlanId, [step('Save document', 'bob')]),
    minimization: { ...minimization, result: { ...(minimization.result as any), deletionMinimal: false } } }),
    (error: unknown) => error instanceof ReportError && error.code === 'unconfirmed_minimization_record');
});

it('CLI help and invalid IDs stay read-only and fail before record access', async () => {
  const script = fileURLToPath(new URL('../scripts/hound.ts', import.meta.url));
  const wrapper = fileURLToPath(new URL('../../../hound', import.meta.url));
  const run = (args: string[]) => promisify(execFile)(process.execPath, ['--import', 'tsx', script, ...args], { timeout: 10_000 });
  const help = await run(['--help']); assert.match(help.stdout, /terminal-first/i); assert.match(help.stdout, /launch no browser, fixture, or model/i);
  const packaged = await promisify(execFile)(wrapper, ['--help'], { timeout: 10_000 }); assert.match(packaged.stdout, /\.\/hound runs/);
  await assert.rejects(run(['report', '--run-id', '../private']), (error: any) => error.code === 2 && /invalid_arguments/.test(error.stderr));
});

it('normalizes trailing workspace separators and bounds the report parent walk', () => {
  assert.deepEqual(reportOutputAncestors('/tmp/hound/', '/tmp/hound/docs/reports/finding.html'), ['/tmp/hound/docs/reports', '/tmp/hound/docs']);
  assert.throws(() => reportOutputAncestors('/tmp/hound/', '/tmp/private.html'),
    (error: unknown) => error instanceof ReportError && error.code === 'invalid_output_path');
});
