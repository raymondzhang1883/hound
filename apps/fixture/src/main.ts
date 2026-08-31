import { startFixture } from './server.js';
import type { Mode } from './store.js';

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function port(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 0 || value > 65_535) throw new Error(`${name} must be a valid port`);
  return value;
}

try {
  const fixture = await startFixture({
    mode: required('FIXTURE_MODE') as Mode,
    credentials: { alice: required('FIXTURE_ALICE_PASSWORD'), bob: required('FIXTURE_BOB_PASSWORD') },
    harnessKey: required('FIXTURE_HARNESS_KEY'),
    appPort: port('FIXTURE_PORT', 4311), harnessPort: port('FIXTURE_HARNESS_PORT', 4411),
  });
  console.log(`Fixture listening at ${fixture.appUrl}; harness at ${fixture.harnessUrl}`);
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await fixture.close(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Could not start fixture');
  process.exitCode = 1;
}
