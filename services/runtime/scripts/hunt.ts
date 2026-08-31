import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, type Browser } from '@playwright/test';
import { startFixture } from '../../../apps/fixture/src/server.js';
import { BrowserExperiment } from '../src/experiment.js';
import { runHunt, type HuntResult } from '../src/hunt.js';
import { RunJournal } from '../src/journal.js';
import { OpenAIPolicy, MODEL, RATE_CARD } from '../src/openai-policy.js';
import { PolicyError, PROMPT_VERSION } from '../src/policy.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const help = `Hound local agent pilot (owned loopback fixtures only)

  ./hound hunt --preflight
  ./hound hunt --case positive --max-cost-usd 2
  ./hound hunt --case negative --max-cost-usd 2

Options: --case positive|negative, --max-cost-usd <0..10>, --trials <1..3>, --headed, --preflight, --help
Requires OPENAI_API_KEY in your environment or the ignored project .env file.
An explicit dollar budget is required before any model call. No key or budget is needed for --help/--preflight.
negative uses two correct deployments; a nondetection is not proof of correctness.
For credential-free authored integration checks: npm run hunt:check
`;

async function main() {
  let args;
  try { args = parseArgs({ options: { case: { type: 'string' }, 'max-cost-usd': { type: 'string' }, trials: { type: 'string' },
    headed: { type: 'boolean' }, preflight: { type: 'boolean' }, help: { type: 'boolean' } }, strict: true }); }
  catch { console.error('Invalid command arguments. Run ./hound hunt --help.'); process.exitCode = 2; return; }
  const { values } = args;
  if (values.help) { console.log(help); return; }
  const caseName = values.case ?? 'positive';
  const costText = values['max-cost-usd'];
  const maxCostUsd = costText === undefined ? undefined : Number(costText);
  const trials = values.trials === undefined ? 3 : Number(values.trials);
  if (!['positive', 'negative'].includes(caseName) || !Number.isInteger(trials) || trials < 1 || trials > 3 ||
      (costText !== undefined && (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(costText) || !Number.isFinite(maxCostUsd) || maxCostUsd! <= 0 || maxCostUsd! > 10))) {
    console.error('Invalid case or budget. Run ./hound hunt --help.'); process.exitCode = 2; return;
  }
  const apiKey = process.env.OPENAI_API_KEY?.trim() ?? '';
  const browserInstalled = existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? chromium.executablePath());
  if (values.preflight) {
    console.log(JSON.stringify({ model: MODEL, reasoning: 'medium', rateCard: RATE_CARD, apiKey: apiKey ? 'present (not validated)' : 'missing',
      maxCostUsd: maxCostUsd ?? null, browserInstalled, case: caseName, trials,
      ready: !!apiKey && maxCostUsd !== undefined && browserInstalled, networkRequestsMade: 0 }, null, 2));
    return;
  }
  if (!apiKey || maxCostUsd === undefined || !browserInstalled) {
    console.error(!apiKey ? 'OPENAI_API_KEY is missing. Configure it locally; do not paste it into chat or commit it.' :
      maxCostUsd === undefined ? 'Supply --max-cost-usd explicitly to authorize a bounded live run.' : 'Chromium is missing. Run npm run setup:browser.');
    console.error('No model request was made. Run ./hound hunt --preflight for readiness details.'); process.exitCode = 2; return;
  }
  const policy = new OpenAIPolicy({ apiKey, maxCostUsd });
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const credentials = { alice: `alice-${randomBytes(24).toString('hex')}`, bob: `bob-${randomBytes(24).toString('hex')}` };
  const keys = { baseline: randomBytes(32).toString('hex'), candidate: randomBytes(32).toString('hex') };
  const journal = await RunJournal.create(join(root, '.hound/runs'), [apiKey, ...Object.values(credentials), ...Object.values(keys)]);
  let revision = 'unknown';
  try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Source archives need not have Git metadata. */ }
  await journal.write('config', { version: 1, revision, case: caseName, policy: policy.metadata, promptVersion: PROMPT_VERSION, rateCard: RATE_CARD,
    maxCostUsd, maxTrials: trials, maxDecisions: 40, discoveryMs: 600_000, verificationMs: 180_000, createdAt: new Date().toISOString() });
  console.log(`Starting ${caseName} pilot with ${MODEL}; estimated spend allowance $${maxCostUsd.toFixed(2)}.`);
  console.log(`Private run records: ${journal.directory}`);
  let baseline: Awaited<ReturnType<typeof startFixture>> | undefined;
  let candidate: typeof baseline;
  let browser: Browser | undefined;
  let result: HuntResult | undefined;
  let failure: string | undefined;
  try {
    baseline = await startFixture({ mode: 'baseline', credentials, harnessKey: keys.baseline });
    candidate = await startFixture({ mode: caseName === 'positive' ? 'stale-write' : 'baseline', credentials, harnessKey: keys.candidate });
    browser = await chromium.launch({ headless: !values.headed, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    result = await runHunt({ policy, maxTrials: trials, signal: controller.signal,
      factory: { open: (target, options) => BrowserExperiment.open(browser!, { ...(target === 'baseline' ? baseline! : candidate!),
        harnessKey: keys[target], credentials, ...options }) },
      emit: async event => {
        await journal.append(event);
        if (event.type === 'trial_started') console.log(`Trial ${Number(event.trial) + 1}: exploring through isolated actor browsers.`);
        if (event.type === 'suspicion') console.log('Deterministic suspicion observed; starting fresh paired replay.');
        if (event.type === 'replay_started') console.log(`Replaying ${event.target}.`);
      },
      savePlan: plan => journal.write('plan', plan),
    });
  } catch (error) { failure = error instanceof PolicyError ? error.code : 'pilot_setup_failed'; }
  finally {
    const cleanup = await Promise.allSettled([browser?.close(), baseline?.close(), candidate?.close()]);
    if (cleanup.some(item => item.status === 'rejected')) failure = 'cleanup_failed';
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
  if (failure) {
    if (result) { result.outcome = 'inconclusive'; result.reason = failure; }
    else { await journal.write('result', { version: 1, outcome: 'inconclusive', reason: failure, accounting: policy.accounting() }); }
  }
  if (result) await journal.write('result', result);
  console.log(`Outcome: ${result?.outcome ?? 'inconclusive'}${result?.reason || failure ? ` (${result?.reason ?? failure})` : ''}.`);
  console.log(`Estimated model cost: $${policy.accounting().estimatedCostUsd.toFixed(4)}; calls: ${policy.accounting().calls}.`);
  process.exitCode = result?.outcome === 'cancelled' ? 130 : !failure && result && !['inconclusive', 'provider_stopped'].includes(result.outcome) ? 0 : 1;
}

main().catch(() => { console.error('Pilot stopped because local configuration or record writing failed. No success is implied; inspect the private run directory if one was created.'); process.exitCode = 1; });
