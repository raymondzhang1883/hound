import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Bindings } from '../src/bindings.js';
import { parseDecision, ContractError } from '../src/contracts.js';

it('rejects injected capabilities, unknown actors, secret references, and oversized decisions', () => {
  const valid = { version: 1, actor: 'bob', observationId: 'o1', targetId: 'c1', kind: 'click' };
  assert.equal(parseDecision(JSON.stringify(valid)).kind, 'click');
  for (const input of [
    { ...valid, actor: 'harness' }, { ...valid, script: 'fetch(harness)' }, { ...valid, headers: { Authorization: 'secret' } },
    { ...valid, kind: 'evaluate' }, { ...valid, version: 2 }, { ...valid, kind: 'fill', value: { ref: 'harness_key' } },
    { version: 1, actor: 'bob', kind: 'navigate', routeRef: 'http://127.0.0.1:4411/executions' },
    JSON.stringify({ ...valid, ignored: 'x'.repeat(17_000) }), 'not JSON', 'null', '[]',
    JSON.stringify({ ...valid, kind: 'fill', value: { literal: '', ref: 'trial_text' } }),
  ]) assert.throws(() => parseDecision(input), ContractError);
  assert.deepEqual(parseDecision({ ...valid, kind: 'fill', value: { literal: '' } }), { ...valid, kind: 'fill', value: { literal: '' } });
});

it('rebinding preserves resource and generated-text dependencies without evaluating literal templates', () => {
  const source = new Bindings('source-marker'); const target = new Bindings('new-marker');
  const sourceWs = randomUUID(); const sourceDoc = randomUUID(); const targetWs = randomUUID(); const targetDoc = randomUUID();
  for (const [bindings, workspace, document] of [[source, sourceWs, sourceDoc], [target, targetWs, targetDoc]] as const) {
    bindings.capture({ method: 'POST', path: '/api/workspaces', status: 201, responseBody: { workspace: { id: workspace }, document: { id: document, workspaceId: workspace } } }, 3);
  }
  const recipe = source.template(`source-marker / ${sourceDoc} / {{harness_key}}`);
  assert.equal(target.render(recipe), `new-marker / ${targetDoc} / {{harness_key}}`);
  assert.deepEqual(source.dependencies(recipe), [3]);
  assert.equal(source.routeRef(`/#document/${sourceDoc}`), 'document_1.page');
  assert.equal(target.route('document_1.page'), `/#document/${targetDoc}`);
  assert.throws(() => source.routeRef(`/#document/${targetDoc}`), ContractError);
  assert.throws(() => source.route('document_99.page'), ContractError);
  assert.throws(() => target.render([{ ref: 'harness_key' }]), ContractError);
});
