import { execFileSync } from 'node:child_process';
import { mkdir, rename } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import type { ApplicationAdapter } from './application-adapter.js';
import type { ReplayPlan } from './experiment.js';
import { fieldnotesAdapter } from './fieldnotes-adapter.js';
import { runHunt, type HuntResult } from './hunt.js';
import { RunJournal } from './journal.js';
import { OpenAIPolicy, RATE_CARD } from './openai-policy.js';
import { PolicyError, PROMPT_VERSION, type Policy } from './policy.js';
import { buildReportProjection, type ReportProjection } from './report.js';

type AccountedPolicy = Omit<Policy, 'accounting'> & { accounting(): ReturnType<OpenAIPolicy['accounting']> };

export interface LocalHuntOptions {
  root: string;
  apiKey?: string;
  policy?: AccountedPolicy;
  policySecrets?: string[];
  application?: ApplicationAdapter;
  caseName: 'positive' | 'negative';
  maxCostUsd: number;
  maxTrials: number;
  headed?: boolean;
  signal?: AbortSignal;
  runId?: string;
  attempt?: number;
  emit?: (event: { type: string; at: string; [key: string]: unknown }) => Promise<void>;
}

export interface LocalHuntExecution {
  runId: string;
  journalDirectory: string;
  result?: HuntResult;
  plan?: ReplayPlan;
  projection?: ReportProjection;
  failure?: string;
  accounting: ReturnType<OpenAIPolicy['accounting']>;
}

async function journalFor(options: LocalHuntOptions, secrets: string[]) {
  const parent = join(options.root, '.hound/runs');
  if (!options.runId) return RunJournal.create(parent, secrets);
  if ((options.attempt ?? 1) > 1) {
    const archive = join(options.root, '.hound/attempts', options.runId);
    await mkdir(archive, { recursive: true, mode: 0o700 });
    try { await rename(join(parent, options.runId), join(archive, `attempt-${(options.attempt ?? 1) - 1}`)); }
    catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  }
  return RunJournal.createNamed(parent, options.runId, secrets);
}

export async function executeLocalHunt(options: LocalHuntOptions): Promise<LocalHuntExecution> {
  if (!options.policy && !options.apiKey) throw new PolicyError('missing_api_key');
  const policy: AccountedPolicy =
    options.policy ?? new OpenAIPolicy({ apiKey: options.apiKey!, maxCostUsd: options.maxCostUsd });
  const application = options.application ?? fieldnotesAdapter;
  const applicationSession = application.createSession();
  const journal = await journalFor(options, [...(options.apiKey ? [options.apiKey] : []), ...(options.policySecrets ?? []), ...applicationSession.secrets]);
  const runId = basename(journal.directory);
  let revision = 'unknown';
  try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: options.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { /* Source archives need not have Git metadata. */ }
  const config = { version: 1, revision, case: options.caseName, application: application.metadata, policy: policy.metadata, promptVersion: PROMPT_VERSION, rateCard: RATE_CARD,
    maxCostUsd: options.maxCostUsd, maxTrials: options.maxTrials, maxDecisions: 40, discoveryMs: 600_000, verificationMs: 180_000, createdAt: new Date().toISOString() };
  await journal.write('config', config);
  let browser: Browser | undefined;
  let result: HuntResult | undefined;
  let plan: ReplayPlan | undefined;
  let failure: string | undefined;
  try {
    await applicationSession.start(options.caseName);
    browser = await chromium.launch({ headless: !options.headed, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    result = await runHunt({ policy, maxTrials: options.maxTrials, signal: options.signal,
      factory: { open: (target, experimentOptions) => applicationSession.open(target, browser!, experimentOptions) },
      emit: async event => { await journal.append(event); await options.emit?.(event); },
      savePlan: async value => { plan = value; await journal.write('plan', value); },
    });
  } catch (error) { failure = error instanceof PolicyError ? error.code : 'pilot_setup_failed'; }
  finally {
    const cleanup = await Promise.allSettled([browser?.close(), applicationSession.close()]);
    if (cleanup.some(item => item.status === 'rejected')) failure = 'cleanup_failed';
  }
  if (failure) {
    if (result) { result.outcome = 'inconclusive'; result.reason = failure; }
    else { await journal.write('result', { version: 1, outcome: 'inconclusive', reason: failure, accounting: policy.accounting() }); }
  }
  if (result) await journal.write('result', result);
  const projection = result ? buildReportProjection({ runId, config, result, ...(plan ? { plan } : {}) }) : undefined;
  return { runId, journalDirectory: journal.directory, result, ...(plan ? { plan } : {}), ...(projection ? { projection } : {}), failure, accounting: policy.accounting() };
}
