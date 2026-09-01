import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ControlRun {
  id: string;
  case: 'positive' | 'negative';
  maxCostUsd: number;
  maxTrials: number;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  outcome?: string;
  reason?: string;
  job: { id: string; status: string; attempt: number; maxAttempts: number; leaseEpoch: number; leaseOwner?: string; leaseExpiresAt?: string };
}

export interface ControlLease {
  jobId: string;
  runId: string;
  attempt: number;
  leaseEpoch: number;
  leaseToken: string;
  leaseExpiresAt: string;
  case: 'positive' | 'negative';
  maxCostUsd: number;
  maxTrials: number;
}

export class ControlError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(code); }
}

export async function controlEnvironment(root: string) {
  const path = process.env.HOUND_CONTROL_ENV ?? join(root, '.hound/control-plane.env');
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 || metadata.size > 16 * 1024) throw new ControlError('unsafe_control_environment');
  const values = Object.fromEntries((await readFile(path, 'utf8')).split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => {
    const split = line.indexOf('=');
    if (split < 1) throw new ControlError('invalid_control_environment');
    return [line.slice(0, split), line.slice(split + 1)];
  }));
  const baseURL = process.env.HOUND_CONTROL_URL ?? `http://127.0.0.1:${values.HOUND_CONTROL_PORT ?? '8090'}`;
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(baseURL)) throw new ControlError('control_url_must_be_loopback');
  return { baseURL, workerKey: values.HOUND_WORKER_KEY ?? '' };
}

export class ControlApi {
  constructor(readonly baseURL: string) {}

  async request<T>(path: string, options: RequestInit & { expected?: number[] } = {}): Promise<T | undefined> {
    const expected = options.expected ?? [200];
    let response: Response;
    try { response = await fetch(`${this.baseURL}${path}`, { ...options, signal: options.signal ?? AbortSignal.timeout(5_000), redirect: 'error', headers: { 'content-type': 'application/json', ...options.headers } }); }
    catch { throw new ControlError('control_unavailable'); }
    const text = await response.text();
    if (!expected.includes(response.status)) {
      let code = 'control_request_failed';
      try { code = JSON.parse(text)?.error?.code ?? code; } catch { /* Keep the stable generic code. */ }
      throw new ControlError(code, response.status);
    }
    if (!text) return undefined;
    try { return JSON.parse(text) as T; } catch { throw new ControlError('invalid_control_response'); }
  }

  health(signal?: AbortSignal) { return this.request<{ status: string; version: number }>('/health', { signal }); }
  createRun(input: { case: string; maxCostUsd: number; maxTrials: number }) {
    return this.request<ControlRun>('/v1/runs', { method: 'POST', expected: [201], body: JSON.stringify(input) });
  }
  run(id: string) { return this.request<ControlRun>(`/v1/runs/${encodeURIComponent(id)}`); }
  cancel(id: string) { return this.request<{ status: string }>(`/v1/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }); }
}

export function leaseHeaders(lease: ControlLease) {
  return { Authorization: `Bearer ${lease.leaseToken}`, 'X-Hound-Lease-Epoch': String(lease.leaseEpoch) };
}
