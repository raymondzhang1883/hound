import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { FixtureHarness } from '../src/harness-client.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const manifest = new URL('../../../.hound/demo.json', import.meta.url);
const lockDirectory = new URL('../../../.hound/demo.lock/', import.meta.url);
const actors = { alice: 'alice-local-demo', bob: 'bob-local-demo' };
const children: ChildProcess[] = [];
let stopping = false;
let ownsLock = false;

async function stop() {
  if (stopping) return;
  stopping = true;
  await Promise.all(children.map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 3_000);
  })));
  if (ownsLock) {
    await rm(manifest, { force: true });
    await rm(lockDirectory, { recursive: true, force: true });
  }
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

async function start(mode: 'baseline' | 'stale-write', appPort: number, harnessPort: number) {
  const key = randomBytes(32).toString('hex');
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/fixture/src/main.ts'], {
    cwd: root, stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, FIXTURE_MODE: mode, FIXTURE_PORT: String(appPort), FIXTURE_HARNESS_PORT: String(harnessPort),
      FIXTURE_HARNESS_KEY: key, FIXTURE_ALICE_PASSWORD: actors.alice, FIXTURE_BOB_PASSWORD: actors.bob },
  });
  children.push(child);
  let spawnError: Error | undefined;
  child.once('error', error => { spawnError = error; });
  child.once('exit', code => { if (!stopping) { console.error(`Fixture exited unexpectedly (${code}). Stopping the demo.`); process.exitCode = 1; void stop(); } });
  const appUrl = `http://127.0.0.1:${appPort}`;
  const harnessUrl = `http://127.0.0.1:${harnessPort}`;
  const harness = new FixtureHarness(harnessUrl, key);
  const deadline = Date.now() + 10_000;
  while (true) {
    if (spawnError) throw spawnError;
    if (stopping || child.exitCode !== null) throw new Error('Fixture stopped during startup');
    try { await harness.health(); break; }
    catch { if (Date.now() >= deadline) throw new Error('Fixture did not become ready'); await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  const execution = await harness.begin();
  return { appUrl, harnessUrl, harnessKey: key, execution };
}

try {
  await mkdir(new URL('../../../.hound/', import.meta.url), { recursive: true });
  try { await mkdir(lockDirectory); ownsLock = true; }
  catch { throw new Error('A demo lock already exists. Stop the existing demo, or remove .hound/demo.lock after verifying it is no longer running.'); }
  const baseline = await start('baseline', 4311, 4411);
  const candidate = await start('stale-write', 4312, 4412);
  if (!stopping) {
    await writeFile(manifest, JSON.stringify({ contractVersion: 1, actors, baseline, candidate }, null, 2), { mode: 0o600 });
    console.log('\nFieldnotes demo ready\n');
    console.log(`Baseline:  ${baseline.appUrl}\nCandidate: ${candidate.appUrl}`);
    console.log('\nLocal demo accounts: Alice / alice-local-demo, Bob / bob-local-demo');
    console.log('Use separate browser profiles for Alice and Bob; tabs share login cookies.');
    console.log('Private integration manifest: .hound/demo.json (do not commit or share).');
    console.log('Ctrl+C stops both fixtures. Run npm run demo again for clean state.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Demo startup failed');
  process.exitCode = 1;
  await stop();
}
