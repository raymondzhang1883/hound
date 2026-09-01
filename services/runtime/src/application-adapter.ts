import type { Browser } from '@playwright/test';
import type { BrowserExperiment } from './experiment.js';

export interface ApplicationSession {
  readonly secrets: string[];
  start(caseName: 'positive' | 'negative'): Promise<void>;
  open(target: 'baseline' | 'candidate', browser: Browser, options: { maxDecisions: number; deadlineMs: number; signal: AbortSignal }): Promise<BrowserExperiment>;
  close(): Promise<void>;
}

export interface ApplicationAdapter {
  readonly metadata: { id: string; version: number; invariantId: string };
  createSession(): ApplicationSession;
}
