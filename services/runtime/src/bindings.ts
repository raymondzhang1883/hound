import { randomUUID } from 'node:crypto';
import { reject, type HttpExchange, type TextTemplate, type TextValue } from './contracts.js';

export class Bindings {
  private values = new Map<string, string>();
  private origins = new Map<string, number>();
  constructor(trialText = `hound-${randomUUID()}`) { this.values.set('trial_text', trialText); }
  value(ref: string) { return this.values.get(ref) ?? reject('unbound_reference'); }
  text(value: TextValue) { return 'literal' in value ? value.literal : this.value(value.ref); }
  template(text: string): TextTemplate {
    const values = [...this.values].sort((a, b) => b[1].length - a[1].length);
    const result: TextTemplate = []; let offset = 0;
    while (offset < text.length) {
      let next: { ref: string; value: string; index: number } | undefined;
      for (const [ref, value] of values) {
        const index = text.indexOf(value, offset);
        if (index >= 0 && (!next || index < next.index)) next = { ref, value, index };
      }
      if (!next) { result.push({ literal: text.slice(offset) }); break; }
      if (next.index > offset) result.push({ literal: text.slice(offset, next.index) });
      result.push({ ref: next.ref }); offset = next.index + next.value.length;
    }
    return result.length ? result : [{ literal: '' }];
  }
  render(template: TextTemplate) { return template.map(part => 'literal' in part ? part.literal : this.value(part.ref)).join(''); }
  display(text: string) { return this.template(text).map(part => 'literal' in part ? part.literal : `<${part.ref}>`).join(''); }
  private bind(kind: 'workspace' | 'document' | 'invitation', id: unknown, step: number) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) reject('invalid_resource_binding');
    const existing = [...this.values].find(([ref, value]) => ref.startsWith(`${kind}_`) && value === id);
    if (existing) return existing[0];
    if ([...this.values.values()].includes(id)) reject('conflicting_resource_binding');
    const ref = `${kind}_${[...this.values.keys()].filter(key => key.startsWith(`${kind}_`)).length + 1}`;
    this.values.set(ref, id); this.origins.set(ref, step); return ref;
  }
  capture(exchange: HttpExchange, step: number) {
    if (exchange.status !== 201) return;
    const body = exchange.responseBody as Record<string, any> | undefined;
    if (exchange.method === 'POST' && exchange.path === '/api/workspaces') {
      if (!body?.workspace || !body.document || body.document.workspaceId !== body.workspace.id) reject('invalid_resource_binding');
      this.bind('workspace', body.workspace.id, step); this.bind('document', body.document.id, step);
    } else if (exchange.method === 'POST' && /^\/api\/workspaces\/[^/]+\/invitations$/.test(exchange.path)) {
      const workspaceId = exchange.path.split('/')[3];
      if (!body || body.workspaceId !== workspaceId || !['alice', 'bob'].includes(body.recipient) || body.status !== 'pending') reject('invalid_resource_binding');
      this.bind('invitation', body.id, step);
    }
  }
  routeRef(path: string): string {
    if (path === '/' || path === '/#' || path === '') return 'home';
    const match = /^\/#(workspace|document)\/([^/]+)$/.exec(path);
    if (!match) return reject('unsupported_route');
    const bound = [...this.values].find(([ref, id]) => ref.startsWith(`${match[1]}_`) && id === match[2]);
    return bound ? `${bound[0]}.page` : reject('unbound_route');
  }
  route(ref: string) {
    if (ref === 'home') return '/';
    const match = /^(workspace|document)_([1-9]\d*)\.page$/.exec(ref);
    if (!match) return reject('invalid_route_ref');
    return `/#${match[1]}/${this.value(ref.slice(0, -5))}`;
  }
  dependencies(template: TextTemplate) {
    return [...new Set(template.flatMap(part => 'ref' in part && this.origins.has(part.ref) ? [this.origins.get(part.ref)!] : []))];
  }
}
