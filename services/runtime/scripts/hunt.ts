import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { executeLocalHunt } from '../src/local-runner.js';
import { MODEL, RATE_CARD } from '../src/openai-policy.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const help = `Hound direct local agent pilot (owned loopback fixtures only)

  ./hound hunt --local --preflight
  ./hound hunt --local --case positive --max-cost-usd 2
  ./hound hunt --local --case negative --max-cost-usd 2

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
    console.error('No model request was made. Run ./hound hunt --local --preflight for direct-run readiness details.'); process.exitCode = 2; return;
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  console.log(`Starting direct local ${caseName} pilot with ${MODEL}; estimated spend allowance $${maxCostUsd.toFixed(2)}.`);
  let execution;
  try {
    execution = await executeLocalHunt({ root, apiKey, caseName: caseName as 'positive' | 'negative', maxCostUsd, maxTrials: trials, headed: values.headed, signal: controller.signal,
      emit: async event => {
        if (event.type === 'trial_started') console.log(`Trial ${Number(event.trial) + 1}: exploring through isolated actor browsers.`);
        if (event.type === 'suspicion') console.log('Deterministic suspicion observed; starting fresh paired replay.');
        if (event.type === 'replay_started') console.log(`Replaying ${event.target}.`);
      },
    });
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
  const result = execution.result; const failure = execution.failure;
  console.log(`Private run records: ${execution.journalDirectory}`);
  console.log(`Outcome: ${result?.outcome ?? 'inconclusive'}${result?.reason || failure ? ` (${result?.reason ?? failure})` : ''}.`);
  console.log(`Estimated model cost: $${execution.accounting.estimatedCostUsd.toFixed(4)}; calls: ${execution.accounting.calls}.`);
  process.exitCode = result?.outcome === 'cancelled' ? 130 : !failure && result && !['inconclusive', 'provider_stopped'].includes(result.outcome) ? 0 : 1;
}

main().catch(() => { console.error('Pilot stopped because local configuration or record writing failed. No success is implied; inspect the private run directory if one was created.'); process.exitCode = 1; });
