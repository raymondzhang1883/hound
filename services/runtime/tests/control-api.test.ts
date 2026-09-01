import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ControlError, controlEnvironment } from '../src/control-api.js';

test('loads only owner-private control credentials and loopback control URLs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hound-control-env-'));
  const path = join(directory, 'control.env');
  const previousPath = process.env.HOUND_CONTROL_ENV;
  const previousURL = process.env.HOUND_CONTROL_URL;
  process.env.HOUND_CONTROL_ENV = path;
  delete process.env.HOUND_CONTROL_URL;
  try {
    await writeFile(path, 'HOUND_WORKER_KEY=test-worker-key-with-at-least-32-characters\nHOUND_CONTROL_PORT=8123\n', { mode: 0o600 });
    assert.deepEqual(await controlEnvironment(directory), {
      baseURL: 'http://127.0.0.1:8123', workerKey: 'test-worker-key-with-at-least-32-characters',
    });

    await chmod(path, 0o644);
    await assert.rejects(() => controlEnvironment(directory), (error: unknown) => error instanceof ControlError && error.code === 'unsafe_control_environment');

    await chmod(path, 0o600);
    process.env.HOUND_CONTROL_URL = 'https://example.com';
    await assert.rejects(() => controlEnvironment(directory), (error: unknown) => error instanceof ControlError && error.code === 'control_url_must_be_loopback');
  } finally {
    if (previousPath === undefined) delete process.env.HOUND_CONTROL_ENV; else process.env.HOUND_CONTROL_ENV = previousPath;
    if (previousURL === undefined) delete process.env.HOUND_CONTROL_URL; else process.env.HOUND_CONTROL_URL = previousURL;
    await rm(directory, { recursive: true, force: true });
  }
});
