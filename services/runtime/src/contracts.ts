export type Actor = 'alice' | 'bob';
export type TextValue = { literal: string } | { ref: 'trial_text' };
type Target = { version: 1; actor: Actor; observationId: string; targetId: string };
export type Decision =
  | (Target & { kind: 'click' })
  | (Target & { kind: 'fill'; value: TextValue })
  | (Target & { kind: 'select'; option: string })
  | { version: 1; kind: 'navigate'; actor: Actor; routeRef: string }
  | { version: 1; kind: 'observe'; actor: Actor }
  | { version: 1; kind: 'stop'; reason: string };

export class ContractError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export function reject(code: string): never { throw new ContractError(code); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) reject('invalid_object');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).length !== allowed.length || allowed.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !allowed.includes(key))) reject('invalid_fields');
}
function string(value: unknown, limit: number, empty = false): string {
  if (typeof value !== 'string' || value.length > limit || (!empty && !value.trim())) reject('invalid_string');
  return value;
}
export function parseDecision(input: unknown): Decision {
  // The provider boundary is serialized JSON. Objects are accepted only for local callers/tests.
  let value: unknown = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input) > 16_384) reject('decision_too_large');
    try { value = JSON.parse(input); } catch { reject('invalid_json'); }
  }
  const data = record(value);
  if (data.version !== 1) reject('unsupported_version');
  if (data.kind === 'stop') {
    keys(data, ['version', 'kind', 'reason']);
    return { version: 1, kind: 'stop', reason: string(data.reason, 240) };
  }
  if (data.actor !== 'alice' && data.actor !== 'bob') reject('unknown_actor');
  const actor = data.actor;
  if (data.kind === 'observe') {
    keys(data, ['version', 'kind', 'actor']); return { version: 1, kind: 'observe', actor };
  }
  if (data.kind === 'navigate') {
    keys(data, ['version', 'kind', 'actor', 'routeRef']);
    const routeRef = string(data.routeRef, 80);
    if (routeRef !== 'home' && !/^(workspace|document)_[1-9]\d*\.page$/.test(routeRef)) reject('invalid_route_ref');
    return { version: 1, kind: 'navigate', actor, routeRef };
  }
  const common = ['version', 'kind', 'actor', 'observationId', 'targetId'];
  const target: Target = { version: 1, actor, observationId: string(data.observationId, 100), targetId: string(data.targetId, 100) };
  if (data.kind === 'click') { keys(data, common); return { ...target, kind: 'click' }; }
  if (data.kind === 'select') {
    keys(data, [...common, 'option']); return { ...target, kind: 'select', option: string(data.option, 256, true) };
  }
  if (data.kind === 'fill') {
    keys(data, [...common, 'value']);
    const field = record(data.value);
    let text: TextValue;
    if (Object.hasOwn(field, 'literal')) { keys(field, ['literal']); text = { literal: string(field.literal, 10_000, true) }; }
    else { keys(field, ['ref']); if (field.ref !== 'trial_text') reject('unknown_text_ref'); text = { ref: 'trial_text' }; }
    return { ...target, kind: 'fill', value: text };
  }
  return reject('unknown_action');
}

export type TextPart = { literal: string } | { ref: string };
export type TextTemplate = TextPart[];
export interface LocatorRecipe { by: 'role' | 'label'; role?: 'button' | 'link' | 'textbox' | 'combobox'; name: TextTemplate; scope?: { role: 'article'; name: TextTemplate } }
export interface Control { id: string; role: 'button' | 'link' | 'textbox' | 'combobox'; name: string; enabled: boolean; value?: string; options?: string[] }
export interface Observation {
  version: 1; actor: Actor; session: 'primary'; observationId: string; routeRef: string;
  text: string; controls: Control[]; knownRoutes: string[]; truncated: boolean;
}
export interface HttpExchange {
  method: string; path: string; status: number; requestBody?: unknown; responseBody?: unknown;
}
