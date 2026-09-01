import type { Actor } from './contracts.js';
import { MODEL, OpenAIPolicy } from './openai-policy.js';
import type { Policy, PolicyInput } from './policy.js';

const DEMO_SECRET = 'simulated-provider-key';

// This authored path makes the local demo deterministic. It resolves controls from
// live observations and still crosses the production Responses API parser boundary.
const sequence: { actor: Actor; kind: 'fill' | 'click' | 'select'; name: RegExp; value?: unknown }[] = [
  { actor: 'alice', kind: 'fill', name: /^Workspace name$/, value: { ref: 'trial_text' } },
  { actor: 'alice', kind: 'click', name: /^Create workspace$/ },
  { actor: 'alice', kind: 'select', name: /^Invite a teammate$/, value: 'bob' },
  { actor: 'alice', kind: 'click', name: /^Send invitation$/ },
  { actor: 'bob', kind: 'click', name: /^Refresh$/ },
  { actor: 'bob', kind: 'click', name: /^Accept invitation$/ },
  { actor: 'bob', kind: 'click', name: /Open workspace/ },
  { actor: 'bob', kind: 'click', name: /Shared document/ },
  { actor: 'bob', kind: 'fill', name: /^Document body$/, value: { literal: 'Legitimate demo edit' } },
  { actor: 'bob', kind: 'click', name: /^Save document$/ },
  { actor: 'alice', kind: 'click', name: /^Refresh members$/ },
  { actor: 'alice', kind: 'click', name: /^Remove Bob$/ },
  { actor: 'bob', kind: 'fill', name: /^Document body$/, value: { ref: 'trial_text' } },
  { actor: 'bob', kind: 'click', name: /^Save document$/ },
];

export interface DemoPolicy extends Policy {
  accounting(): ReturnType<OpenAIPolicy['accounting']> & { simulated: true; actualModelRequests: 0 };
}

export function createDemoPolicy(): { policy: DemoPolicy; secrets: string[]; telemetry: { inputs: PolicyInput[]; calls(): number } } {
  let calls = 0;
  const inputs: PolicyInput[] = [];
  const adapter = new OpenAIPolicy({ apiKey: DEMO_SECRET, maxCostUsd: 2, transport: async (url, init) => {
    if (url !== 'https://api.openai.com/v1/responses') throw new Error('unexpected_demo_provider_url');
    const request = JSON.parse(String(init?.body));
    const input = JSON.parse(request.input?.[0]?.content ?? 'null') as PolicyInput;
    inputs.push(input);
    const action = sequence[calls++];
    let decision: unknown = { version: 1, kind: 'stop', reason: 'Authored demo sequence finished' };
    if (action) {
      const observation = input.observations[action.actor];
      const targets = observation.controls.filter(control => action.name.test(control.name));
      if (targets.length !== 1) throw new Error('demo_control_resolution_failed');
      decision = {
        version: 1,
        actor: action.actor,
        kind: action.kind,
        observationId: observation.observationId,
        targetId: targets[0]!.id,
        ...(action.kind === 'fill' ? { value: action.value } : action.kind === 'select' ? { option: action.value } : {}),
      };
    }
    return Response.json({
      model: MODEL,
      status: 'completed',
      service_tier: 'default',
      usage: { input_tokens: 0, output_tokens: 0 },
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ decision }) }] }],
    });
  } });
  const policy: DemoPolicy = {
    metadata: { ...adapter.metadata, provider: 'simulated-openai', simulated: true },
    decide: (input, signal) => adapter.decide(input, signal),
    accounting: () => ({ ...adapter.accounting(), simulated: true, actualModelRequests: 0 }),
  };
  return { policy, secrets: [DEMO_SECRET], telemetry: { inputs, calls: () => calls } };
}
