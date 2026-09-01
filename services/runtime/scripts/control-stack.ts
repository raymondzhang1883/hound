import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlApi, controlEnvironment } from '../src/control-api.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const environmentPath = join(root, '.hound/control-plane.env');
const composePath = join(root, 'deploy/local/compose.yaml');
const help = `Hound local control plane

  ./hound control up       initialize local secrets, build, and start
  ./hound control status   show container status
  ./hound control logs     show recent control-plane and database logs
  ./hound control down     stop containers without deleting durable data
`;

async function initialize() {
  await mkdir(join(root, '.hound'), { recursive: true, mode: 0o700 });
  let created = false;
  try {
    const file = await open(environmentPath, 'wx', 0o600);
    try {
      await file.writeFile([
        `HOUND_POSTGRES_PASSWORD=${randomBytes(32).toString('hex')}`,
        `HOUND_WORKER_KEY=${randomBytes(32).toString('hex')}`,
        'HOUND_CONTROL_PORT=8090',
        'HOUND_LEASE_DURATION=30s',
        '',
      ].join('\n'));
      await file.sync(); created = true;
    } finally { await file.close(); }
  } catch (error: any) { if (error?.code !== 'EEXIST') throw error; }
  const metadata = await lstat(environmentPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('unsafe_control_environment');
  await chmod(environmentPath, 0o600);
  await controlEnvironment(root);
  if (created) console.log('Initialized private control-plane credentials in .hound/control-plane.env.');
}

function compose(args: string[]) {
  const result = spawnSync('docker', ['compose', '--env-file', environmentPath, '-f', composePath, ...args], { cwd: root, stdio: 'inherit' });
  if (result.error) throw new Error('docker_unavailable');
  if (result.status !== 0) throw new Error('compose_failed');
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help' || command === '-h') { console.log(help); return; }
  if (rest.length) throw new Error('invalid_arguments');
  if (command === 'up') {
    await initialize(); compose(['up', '-d', '--build']);
    const environment = await controlEnvironment(root); const api = new ControlApi(environment.baseURL);
    let ready = false;
    for (let attempt = 0; attempt < 20 && !ready; attempt += 1) {
      try { ready = (await api.health(AbortSignal.timeout(500)))?.status === 'ready'; } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    if (!ready) throw new Error('control_not_ready');
    console.log('Hound control plane is ready on loopback.'); return;
  }
  await controlEnvironment(root);
  if (command === 'status') { compose(['ps']); return; }
  if (command === 'logs') { compose(['logs', '--no-color', '--tail', '100']); return; }
  if (command === 'down') { compose(['down']); console.log('Hound control plane stopped; durable data was retained.'); return; }
  throw new Error('unknown_command');
}

main().catch((error: any) => {
  const code = typeof error?.message === 'string' && /^[a-z_]+$/.test(error.message) ? error.message : 'control_stack_failed';
  console.error(`Hound control command stopped: ${code}.`); process.exitCode = 2;
});
