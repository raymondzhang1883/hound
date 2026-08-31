import { it } from 'node:test';
import assert from 'node:assert/strict';
import { actionReferences, dependencySafeDeletion, minimize, type MinimizerFactory } from '../src/minimizer.js';
import type { RecordedAction, RecordedStep, ReplayPlan, RecordResult } from '../src/experiment.js';
import type { ReplayConclusion } from '../src/oracle.js';
import type { TextTemplate } from '../src/contracts.js';

const template = (literal: string): TextTemplate => [{ literal }];
const recipe = (name: string) => ({ by: 'role' as const, role: 'button' as const, name: template(name) });
const actions: RecordedAction[] = [
  { actor: 'alice', kind: 'click', recipe: recipe('create') },
  { actor: 'alice', kind: 'observe' },
  { actor: 'bob', kind: 'navigate', routeRef: 'document_1.page' },
  { actor: 'alice', kind: 'click', recipe: recipe('remove') },
  { actor: 'bob', kind: 'fill', recipe: { by: 'label', name: template('body') }, value: { ref: 'trial_text' } },
];
const step = (action: RecordedAction, index: number): RecordedStep => ({ action, before: template(`before-${index}`),
  after: index === 0 ? [{ ref: 'document_1' }] : template(`after-${index}`), http: template('[]') });
const makePlan = (selected = actions): ReplayPlan => ({ version: 1, id: `plan-${selected.map(action => JSON.stringify(action)).join('-').length}`,
  steps: selected.map(step), probeActor: 'bob', probeResource: 'document_1' });
const conclusion = (plan: ReplayPlan, result: 'denied' | 'violation'): ReplayConclusion => ({ planId: plan.id, probeStep: plan.steps.length - 1,
  actor: 'bob', resourceRef: 'document_1', setupEquivalent: true, result });

it('tracks logical resource dependencies before trying a deletion', () => {
  const plan = makePlan();
  assert.deepEqual(actionReferences(actions[2]!), ['document_1']);
  assert.equal(dependencySafeDeletion(plan, [0]), false);
  assert.equal(dependencySafeDeletion(plan, [1]), true);
  assert.equal(dependencySafeDeletion(plan, [4]), false);
});

it('finds a deletion-minimal fixed point and preserves every paired attempt', async () => {
  let opens = 0; let closes = 0;
  const factory: MinimizerFactory = { open: async target => {
    opens++;
    return {
      record: async selected => {
        const serialized = JSON.stringify(selected);
        if (!['create', 'document_1.page', 'remove', 'body'].every(value => serialized.includes(value))) {
          return { status: 'inconclusive', reason: 'missing_causal_action' } satisfies RecordResult;
        }
        const plan = makePlan(selected);
        return { status: 'recorded', plan, conclusion: conclusion(plan, 'violation') } satisfies RecordResult;
      },
      replay: async plan => conclusion(plan, target === 'baseline' ? 'denied' : 'violation'),
      close: async () => { closes++; },
    };
  } };
  const result = await minimize({ plan: makePlan(), factory, confirmations: 2, maxAttempts: 30 });
  assert.equal(result.outcome, 'minimized');
  assert.equal(result.originalLength, 5); assert.equal(result.minimizedLength, 4); assert.equal(result.deletionMinimal, true);
  assert.ok(result.attempts.some(attempt => attempt.accepted && attempt.removed.includes(1)));
  assert.ok(result.attempts.some(attempt => !attempt.dependencySafe && attempt.reason === 'dependency_required'));
  assert.deepEqual(result.confirmations.map(item => item.outcome), ['candidate_only_violation', 'candidate_only_violation']);
  assert.equal(opens, closes); assert.ok(opens >= 6);
});
