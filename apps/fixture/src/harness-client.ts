import type { FixtureStore } from './store.js';

export interface Execution { id: string; token: string }
export type FixtureSnapshot = ReturnType<FixtureStore['inspect']>;
export class HarnessError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(`Fixture harness: ${status} ${code}`); }
}

/** Harness credentials must never be attached to an actor browser context. */
export class FixtureHarness {
  constructor(private readonly baseUrl: string, private readonly key: string) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('The local fixture harness requires an http://127.0.0.1:<port> origin');
    }
  }

  private async call<T>(path: string, method: string, execution?: Execution): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method, redirect: 'error', signal: AbortSignal.timeout(5_000),
      headers: { Authorization: `Bearer ${this.key}`, ...(execution ? { 'X-Execution-Token': execution.token } : {}) },
    });
    if (response.status === 204) return undefined as T;
    const body = await response.json() as { error?: { code: string } };
    if (!response.ok) throw new HarnessError(response.status, body.error?.code ?? 'unknown');
    return body as T;
  }

  health() { return this.call<{ status: 'ready'; contractVersion: 1 }>('/health', 'GET'); }
  begin() { return this.call<Execution>('/executions', 'POST'); }
  inspect(execution: Execution) { return this.call<FixtureSnapshot>(`/executions/${encodeURIComponent(execution.id)}/state`, 'GET', execution); }
  end(execution: Execution) { return this.call<void>(`/executions/${encodeURIComponent(execution.id)}`, 'DELETE', execution); }
}
