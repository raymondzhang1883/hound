import { it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIPolicy, MODEL } from '../src/openai-policy.js';
import { policyInput, historyItem, PolicyError, type PolicyInput } from '../src/policy.js';

const observation = (actor: 'alice' | 'bob') => ({ version: 1 as const, actor, session: 'primary' as const, observationId: `${actor}-o1`, routeRef: 'home', text: 'Workspaces', controls: [], knownRoutes: ['home'], truncated: false });
const input = (): PolicyInput => policyInput({ alice: observation('alice'), bob: observation('bob') }, [], 40);
const decision = { version: 1, kind: 'observe', actor: 'alice' };
const completed = (extra: Record<string, unknown> = {}) => ({ model: MODEL, service_tier: 'default', status: 'completed', usage: { input_tokens: 6000, output_tokens: 1000 },
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ decision }) }] }], ...extra });
const transport = (data: unknown): typeof fetch => async () => Response.json(data);
const signal = () => new AbortController().signal;

it('sends a fixed structured request without hosted tools or hidden state and accounts for output reasoning tokens', async () => {
  let calls = 0;
  const policy = new OpenAIPolicy({ apiKey: 'local-unit-key', maxCostUsd: 2, transport: async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(init?.redirect, 'error');
    const body = JSON.parse(init!.body as string);
    assert.equal(body.model, MODEL); assert.equal(body.store, false); assert.deepEqual(body.tools, []);
    assert.equal(body.reasoning.effort, 'medium'); assert.equal(body.max_output_tokens, 4096);
    assert.equal(body.text.format.strict, true); assert.equal(body.text.format.schema.additionalProperties, false);
    assert.ok(body.text.format.schema.properties.decision.anyOf);
    assert.ok(!('previous_response_id' in body)); assert.ok(!(init!.body as string).includes('local-unit-key'));
    return Response.json(completed());
  } });
  assert.deepEqual(await policy.decide(input(), signal()), decision);
  assert.equal(calls, 1); assert.equal(policy.accounting().estimatedCostUsd, 0.009);
  assert.equal(policy.accounting().unknownUsageCalls, 0);
});

it('reserves cost before dispatch and enforces the provider call budget', async () => {
  let calls = 0;
  const send: typeof fetch = async () => { calls++; return Response.json(completed()); };
  const tooSmall = new OpenAIPolicy({ apiKey: 'test-key', maxCostUsd: 0.001, transport: send });
  await assert.rejects(tooSmall.decide(input(), signal()), /cost_budget/); assert.equal(calls, 0);
  const one = new OpenAIPolicy({ apiKey: 'test-key', maxCostUsd: 2, maxCalls: 1, transport: send });
  await one.decide(input(), signal());
  await assert.rejects(one.decide(input(), signal()), /provider_call_budget/); assert.equal(calls, 1);
});

it('refusal, incomplete output, and missing usage stop future calls without rewriting the prompt', async () => {
  for (const [data, code] of [
    [completed({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Local simulated refusal' }] }] }), 'provider_refused'],
    [completed({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), 'provider_incomplete'],
    [completed({ usage: null }), 'provider_usage_unknown'],
    [completed({ model: 'another-model' }), 'provider_configuration_mismatch'],
  ] as const) {
    let calls = 0;
    const policy = new OpenAIPolicy({ apiKey: 'test-key', maxCostUsd: 2, transport: async () => { calls++; return Response.json(data); } });
    await assert.rejects(policy.decide(input(), signal()), new RegExp(code));
    await assert.rejects(policy.decide(input(), signal()), new RegExp(code));
    assert.equal(calls, 1); assert.ok(policy.accounting().estimatedCostUsd > 0);
    assert.equal(policy.accounting().unknownUsageCalls, code === 'provider_usage_unknown' ? 1 : 0);
  }
});

it('unknown HTTP/network outcomes retain a charge estimate and never expose raw error bodies', async () => {
  for (const send of [async () => new Response('private-provider-body', { status: 429 }), async () => { throw new Error('private-provider-body'); }] as typeof fetch[]) {
    const policy = new OpenAIPolicy({ apiKey: 'test-key', maxCostUsd: 2, transport: send });
    await assert.rejects(policy.decide(input(), signal()), error => error instanceof PolicyError && !error.message.includes('private-provider-body'));
    assert.equal(policy.accounting().unknownUsageCalls, 1); assert.ok(policy.accounting().estimatedCostUsd > 0);
  }
});

it('identifies response-format failures without retaining raw output or dispatching a repair call', async () => {
  for (const [content, code] of [
    [[], 'provider_output_count'],
    [[{ type: 'output_text', text: 42 }], 'provider_output_type'],
    [[{ type: 'output_text', text: 'private-invalid-text' }], 'provider_output_not_json'],
    [[{ type: 'output_text', text: JSON.stringify({ action: decision }) }], 'provider_output_envelope'],
    [[{ type: 'output_text', text: 'x'.repeat(16_385) }], 'provider_output_too_large'],
  ] as const) {
    let calls = 0;
    const policy = new OpenAIPolicy({ apiKey: 'test-key', maxCostUsd: 1, transport: async () => {
      calls++; return Response.json(completed({ output: [{ type: 'message', content }] }));
    } });
    await assert.rejects(policy.decide(input(), signal()), new RegExp(code));
    await assert.rejects(policy.decide(input(), signal()), new RegExp(code));
    assert.equal(calls, 1); assert.equal(policy.accounting().unknownUsageCalls, 0);
    assert.ok(policy.accounting().estimatedCostUsd > 0);
  }
});

it('uses the final answer phase without treating intermediate commentary as a decision', async () => {
  const message = (phase: string, text: string) => ({ type: 'message', phase, status: 'completed', content: [{ type: 'output_text', text }] });
  const final = message('final_answer', JSON.stringify({ decision }));
  const commentary = message('commentary', 'private intermediate text');
  for (const output of [[commentary, final], [final, commentary], [final]]) {
    const policy = new OpenAIPolicy({ apiKey: 'test-key', maxCostUsd: 1, transport: transport(completed({ output })) });
    assert.deepEqual(await policy.decide(input(), signal()), decision);
    assert.equal(policy.accounting().outputShape?.phases.final_answer, 1);
    assert.ok(!JSON.stringify(policy.accounting()).includes('private intermediate text'));
  }
  for (const [output, code] of [
    [[final, final], 'provider_message_phase'],
    [[commentary], 'provider_message_phase'],
    [[message('private-unknown-phase', '{}'), final], 'provider_message_phase'],
    [[...completed().output, final], 'provider_message_phase'],
    [[{ ...final, status: 'incomplete' }], 'provider_incomplete'],
    [[{ ...commentary, content: [{ type: 'refusal', refusal: 'private refusal' }] }, final], 'provider_refused'],
  ] as const) {
    let calls = 0;
    const policy = new OpenAIPolicy({ apiKey: 'test-key', maxCostUsd: 1, transport: async () => { calls++; return Response.json(completed({ output })); } });
    await assert.rejects(policy.decide(input(), signal()), new RegExp(code));
    await assert.rejects(policy.decide(input(), signal()), new RegExp(code));
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(policy.accounting()).includes('private'));
  }
});

it('cancels a pending provider request and does not dispatch an already cancelled request', async () => {
  const controller = new AbortController(); let calls = 0;
  const policy = new OpenAIPolicy({ apiKey: 'test-key', maxCostUsd: 2, transport: async (_, init) => {
    calls++; controller.abort(); throw init!.signal!.reason;
  } });
  await assert.rejects(policy.decide(input(), controller.signal), /cancelled/);
  assert.equal(calls, 1); assert.equal(policy.accounting().unknownUsageCalls, 1);
  const never = new OpenAIPolicy({ apiKey: 'test-key', maxCostUsd: 2, transport: transport(completed()) });
  await assert.rejects(never.decide(input(), controller.signal), /cancelled/); assert.equal(never.accounting().calls, 0);
});

it('rejects missing keys and secret-bearing input, and keeps history separate from oracle state', async () => {
  assert.throws(() => new OpenAIPolicy({ apiKey: '', maxCostUsd: 2 }), /missing_api_key/);
  const policy = new OpenAIPolicy({ apiKey: 'test-key', maxCostUsd: 2, transport: transport(completed()) });
  const bad = input(); bad.observations.alice.text = 'test-key';
  await assert.rejects(policy.decide(bad, signal()), /secret_in_policy_input/); assert.equal(policy.accounting().calls, 0);
  const history = historyItem({ ...decision, script: 'not-supported' }, input().observations, 'rejected', 'invalid_fields');
  assert.deepEqual(history, { kind: 'invalid', status: 'rejected', code: 'invalid_fields' });
  const bounded = policyInput(input().observations, Array.from({ length: 30 }, () => history), 5);
  assert.equal(bounded.history.length, 12); assert.ok(!JSON.stringify(bounded).includes('not-supported'));
});
