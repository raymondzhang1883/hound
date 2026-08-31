import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { FixtureStore, FixtureError, fail, sameSecret, type Credentials, type Mode } from './store.js';

export interface FixtureConfig { mode: Mode; credentials: Credentials; harnessKey: string; appPort?: number; harnessPort?: number }
export interface FixtureInstance { appUrl: string; harnessUrl: string; close(): Promise<void> }
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

function send(res: ServerResponse, status: number, value?: unknown) {
  res.statusCode = status;
  if (value === undefined) { res.end(); return; }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}
function report(res: ServerResponse, error: unknown) {
  if (res.destroyed || res.writableEnded) return;
  const known = error instanceof FixtureError;
  send(res, known ? error.status : 500, { error: { code: known ? error.code : 'internal_error',
    message: known ? error.message : 'An unexpected fixture error occurred.' } });
}
function textField(body: Record<string, unknown>, field: string, max = 120, allowEmpty = false) {
  const value = body[field];
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) fail(400, 'invalid_body', `Invalid ${field}.`);
  return value;
}
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') fail(415, 'unsupported_media_type', 'Use application/json.');
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    let length = 0; let oversized = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (oversized) return; // Drain the rest without retaining an unbounded request.
      length += chunk.length;
      if (length > 32_768) {
        oversized = true; chunks.length = 0;
        reject(new FixtureError(413, 'body_too_large', 'Request body is too large.'));
      } else chunks.push(chunk);
    });
    req.once('end', () => { if (!oversized) resolve(Buffer.concat(chunks)); });
    req.once('error', reject);
    req.once('aborted', () => reject(new FixtureError(400, 'request_aborted', 'Request body was interrupted.')));
  });
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { fail(400, 'invalid_json', 'Expected valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_body', 'Expected a JSON object.');
  return value as Record<string, unknown>;
}
function protect(req: IncomingMessage, res: ServerResponse, origin: string) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (req.headers.host !== new URL(origin).host) fail(403, 'invalid_host', 'Use the configured loopback URL.');
  if (req.headers.origin && req.headers.origin !== origin) fail(403, 'invalid_origin', 'Cross-origin requests are not allowed.');
}
function listen(server: Server, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Invalid listener address'));
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}
function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

export async function startFixture(config: FixtureConfig): Promise<FixtureInstance> {
  if (!['baseline', 'stale-write'].includes(config.mode)) throw new Error('Invalid fixture mode');
  if (config.harnessKey.length < 24 || !config.credentials.alice || !config.credentials.bob) throw new Error('Explicit actor credentials and a harness key of at least 24 characters are required');
  const store = new FixtureStore(config.mode, { ...config.credentials });
  const files = new Map(await Promise.all([...assets].map(async ([route, [name, mime]]) =>
    [route, { mime: mime!, bytes: await readFile(new URL(`../public/${name}`, import.meta.url)) }] as const)));
  let appUrl = ''; let harnessUrl = ''; let cookieName = '';
  const app = createServer({ requestTimeout: 10_000, headersTimeout: 5_000 }, async (req, res) => {
    try {
      protect(req, res, appUrl);
      const path = new URL(req.url ?? '/', appUrl).pathname;
      const method = req.method ?? 'GET';
      const asset = files.get(path);
      if (method === 'GET' && asset) { res.setHeader('Content-Type', asset.mime); res.end(asset.bytes); return; }
      if (!path.startsWith('/api/')) fail(404, 'not_found', 'Route not found.');
      // Fence even login requests that arrive before an execution ends while a body is streaming.
      const generation = store.requireActive();
      const body = method === 'POST' || method === 'PATCH' ? await readBody(req) : {};
      store.assertGeneration(generation);
      const token = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? '';
      const cookie = (value: string, maxAge: number) => `${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
      if (path === '/api/session' && method === 'POST') {
        const result = store.login(textField(body, 'actorKey'), textField(body, 'password', 256));
        // A new sign-in replaces, rather than leaves behind, this browser's previous session.
        if (token) { try { store.logout(token); } catch (error) { if (!(error instanceof FixtureError) || error.status !== 401) throw error; } }
        res.setHeader('Set-Cookie', cookie(result.token, 28_800)); send(res, 200, result.user); return;
      }
      store.whoami(token);
      if (path === '/api/session' && method === 'GET') { send(res, 200, store.whoami(token)); return; }
      if (path === '/api/session' && method === 'DELETE') { store.logout(token); res.setHeader('Set-Cookie', cookie('', 0)); send(res, 204); return; }
      if (path === '/api/workspaces' && method === 'GET') { send(res, 200, store.listWorkspaces(token)); return; }
      if (path === '/api/workspaces' && method === 'POST') { send(res, 201, store.createWorkspace(token, textField(body, 'name'))); return; }
      if (path === '/api/invitations' && method === 'GET') { send(res, 200, store.listInvitations(token)); return; }
      let match: RegExpExecArray | null;
      if ((match = /^\/api\/workspaces\/([^/]+)$/.exec(path)) && method === 'GET') { send(res, 200, store.getWorkspace(token, match[1]!)); return; }
      if ((match = /^\/api\/workspaces\/([^/]+)\/invitations$/.exec(path)) && method === 'POST') { send(res, 201, store.invite(token, match[1]!, textField(body, 'recipient'))); return; }
      if ((match = /^\/api\/invitations\/([^/]+)\/accept$/.exec(path)) && method === 'POST') { send(res, 200, store.accept(token, match[1]!)); return; }
      if ((match = /^\/api\/workspaces\/([^/]+)\/members\/([^/]+)$/.exec(path)) && method === 'DELETE') { store.remove(token, match[1]!, match[2]!); send(res, 204); return; }
      if ((match = /^\/api\/documents\/([^/]+)$/.exec(path))) {
        if (method === 'GET') { send(res, 200, store.readDocument(token, match[1]!)); return; }
        if (method === 'PATCH') {
          if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 1) fail(400, 'invalid_body', 'Invalid expectedRevision.');
          send(res, 200, store.editDocument(token, match[1]!, textField(body, 'body', 10_000, true), body.expectedRevision as number)); return;
        }
      }
      fail(404, 'not_found', 'Route not found.');
    } catch (error) { report(res, error); }
  });
  const harness = createServer({ requestTimeout: 10_000, headersTimeout: 5_000 }, (req, res) => {
    try {
      protect(req, res, harnessUrl);
      if (!sameSecret(req.headers.authorization ?? '', `Bearer ${config.harnessKey}`)) fail(401, 'unauthenticated', 'Harness authentication required.');
      const path = new URL(req.url ?? '/', harnessUrl).pathname;
      if (path === '/health' && req.method === 'GET') { send(res, 200, { status: 'ready', contractVersion: 1 }); return; }
      if (path === '/executions' && req.method === 'POST') { send(res, 201, store.begin()); return; }
      const match = /^\/executions\/([^/]+)(\/state)?$/.exec(path);
      const executionToken = req.headers['x-execution-token'];
      if (match && typeof executionToken === 'string') {
        if (req.method === 'GET' && match[2]) { send(res, 200, store.inspect(match[1]!, executionToken)); return; }
        if (req.method === 'DELETE' && !match[2]) { store.end(match[1]!, executionToken); send(res, 204); return; }
      }
      fail(403, 'invalid_execution', 'Execution credentials or operation are invalid.');
    } catch (error) { report(res, error); }
    finally { req.resume(); }
  });
  try {
    appUrl = await listen(app, config.appPort ?? 0);
    cookieName = `hound_fixture_${new URL(appUrl).port}`;
    harnessUrl = await listen(harness, config.harnessPort ?? 0);
  } catch (error) { await Promise.all([closeServer(app), closeServer(harness)]); throw error; }
  return { appUrl, harnessUrl, async close() { await Promise.all([closeServer(app), closeServer(harness)]); } };
}
