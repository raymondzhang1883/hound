import { randomBytes } from 'node:crypto';
import type { Browser } from '@playwright/test';
import { startFixture } from '../../../apps/fixture/src/server.js';
import type { ApplicationAdapter, ApplicationSession } from './application-adapter.js';
import { BrowserExperiment } from './experiment.js';
import { INVARIANT } from './policy.js';

class FieldnotesSession implements ApplicationSession {
  private readonly credentials = { alice: `alice-${randomBytes(24).toString('hex')}`, bob: `bob-${randomBytes(24).toString('hex')}` };
  private readonly keys = { baseline: randomBytes(32).toString('hex'), candidate: randomBytes(32).toString('hex') };
  private baseline?: Awaited<ReturnType<typeof startFixture>>;
  private candidate?: Awaited<ReturnType<typeof startFixture>>;
  private started = false;
  private closed = false;

  readonly secrets = [...Object.values(this.credentials), ...Object.values(this.keys)];

  async start(caseName: 'positive' | 'negative') {
    if (this.started || this.closed) throw new Error('application_session_state');
    this.started = true;
    try {
      this.baseline = await startFixture({ mode: 'baseline', credentials: this.credentials, harnessKey: this.keys.baseline });
      this.candidate = await startFixture({ mode: caseName === 'positive' ? 'stale-write' : 'baseline', credentials: this.credentials, harnessKey: this.keys.candidate });
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  open(target: 'baseline' | 'candidate', browser: Browser, options: { maxDecisions: number; deadlineMs: number; signal: AbortSignal }) {
    const deployment = target === 'baseline' ? this.baseline : this.candidate;
    if (!this.started || this.closed || !deployment) throw new Error('application_session_state');
    return BrowserExperiment.open(browser, { ...deployment, harnessKey: this.keys[target], credentials: this.credentials, ...options });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const cleanup = await Promise.allSettled([this.baseline?.close(), this.candidate?.close()]);
    if (cleanup.some(item => item.status === 'rejected')) throw new Error('application_cleanup_failed');
  }
}

export const fieldnotesAdapter: ApplicationAdapter = {
  metadata: { id: 'fieldnotes', version: 1, invariantId: INVARIANT.id },
  createSession: () => new FieldnotesSession(),
};
