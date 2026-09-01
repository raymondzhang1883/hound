import { it } from 'node:test';
import assert from 'node:assert/strict';
import { exportPlaywrightRegression } from '../src/exporter.js';
import type { ReplayPlan } from '../src/experiment.js';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const plan: ReplayPlan = { version: 1, id: 'local-plan', probeActor: 'bob', probeResource: 'document_1', steps: [{
  action: { actor: 'bob', kind: 'fill', recipe: { by: 'label', name: [{ literal: `Body ' \\ \u2028` }] }, value: { literal: `value ' \\ \u2029` } },
  before: [{ literal: '{}' }], after: [{ literal: '{}' }], http: [{ literal: '[]' }],
}] };

it('exports a model-free regression with JSON-safe data and no private configuration', () => {
  const source = exportPlaywrightRegression(plan);
  assert.ok(source.includes("expect(result.result).toBe('denied')"));
  assert.ok(source.includes('HOUND_FIXTURE_MODE'));
  assert.ok(source.includes('\\u2028')); assert.ok(source.includes('\\u2029'));
  for (const forbidden of ['OPENAI_API_KEY', '.hound/runs', 'previous_response_id', 'harness-token']) assert.ok(!source.includes(forbidden));
});

it('refuses to export an unrecognized invariant plan', () => {
  assert.throws(() => exportPlaywrightRegression({ ...plan, probeActor: 'alice' }), /unsupported_export_plan/);
});

it('minimizer CLI help and invalid IDs make no model or browser request', async () => {
  const script = fileURLToPath(new URL('../scripts/minimize.ts', import.meta.url));
  const run = (args: string[]) => promisify(execFile)(process.execPath, ['--import', 'tsx', script, ...args], { timeout: 10_000 });
  const help = await run(['--help']);
  assert.match(help.stdout, /zero model calls/i);
  await assert.rejects(run(['--run-id', '../private']), (error: any) => error.code === 2 && /valid run ID/.test(error.stderr));
});
