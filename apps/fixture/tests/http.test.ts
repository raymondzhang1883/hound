import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { startFixture } from '../src/server.js';
import { FixtureHarness, HarnessError } from '../src/harness-client.js';

const credentials = { alice: 'http-test-alice', bob: 'http-test-bob' };
async function setup() {
  const harnessKey = randomBytes(32).toString('hex');
  const fixture = await startFixture({ mode: 'baseline', credentials, harnessKey });
  const harness = new FixtureHarness(fixture.harnessUrl, harnessKey);
  return { fixture, harness, harnessKey };
}
async function login(url: string, actorKey = 'alice') {
  const response = await fetch(`${url}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actorKey, password: credentials[actorKey as keyof typeof credentials] }) });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie')!;
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['actorKey', 'displayName']);
  return { cookie: setCookie.split(';')[0]!, setCookie };
}

it('requires separate harness credentials and never mounts harness routes on the actor server', async t => {
  const { fixture, harness, harnessKey } = await setup(); t.after(() => fixture.close());
  assert.equal((await fetch(`${fixture.harnessUrl}/health`)).status, 401);
  assert.deepEqual(await harness.health(), { status: 'ready', contractVersion: 1 });
  assert.equal((await fetch(`${fixture.appUrl}/executions`, { method: 'POST', headers: { Authorization: `Bearer ${harnessKey}` } })).status, 404);
  assert.equal((await fetch(`${fixture.appUrl}/api/workspaces`)).status, 503);
  const execution = await harness.begin();
  await assert.rejects(harness.begin(), (e: unknown) => e instanceof HarnessError && e.status === 409);
  const { cookie } = await login(fixture.appUrl);
  const inspection = `${fixture.harnessUrl}/executions/${execution.id}/state`;
  assert.equal((await fetch(inspection, { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await fetch(inspection, { headers: { Authorization: `Bearer ${harnessKey}`, 'X-Execution-Token': 'wrong' } })).status, 403);
  assert.equal((await harness.inspect(execution)).workspaces.length, 0);
});

it('rejects malformed requests and cross-origin mutations without changing state', async t => {
  const { fixture, harness } = await setup(); t.after(() => fixture.close());
  const execution = await harness.begin();
  const { cookie, setCookie } = await login(fixture.appUrl);
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/);
  const url = `${fixture.appUrl}/api/workspaces`;
  const headers = { 'Content-Type': 'application/json', Cookie: cookie };
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'http://untrusted.example' }, body: '{"name":"bad"}' })).status, 403);
  // Native fetch normalizes Host; use the HTTP client to exercise a real foreign host header.
  const foreignHostStatus = await new Promise<number>((resolve, reject) => {
    const req = request(url, { headers: { Host: 'untrusted.example', Cookie: cookie } }, res => {
      res.resume(); resolve(res.statusCode!);
    });
    req.once('error', reject); req.end();
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await fetch(url, { method: 'POST', headers: { Cookie: cookie }, body: '{"name":"bad"}' })).status, 415);
  for (const body of ['{', '[]', 'null', '{}', '{"name":42}', '{"name":"   "}']) {
    assert.equal((await fetch(url, { method: 'POST', headers, body })).status, 400);
  }
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ name: 'x'.repeat(40_000) }) })).status, 413);
  assert.equal((await harness.inspect(execution)).workspaces.length, 0);
  const page = await fetch(fixture.appUrl);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.equal(page.headers.has('access-control-allow-origin'), false);
});

it('allows exactly one of two concurrent execution acquisitions', async t => {
  const { fixture, harness } = await setup(); t.after(() => fixture.close());
  const results = await Promise.allSettled([harness.begin(), harness.begin()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const failed = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.equal(failed.reason.status, 409);
});

it('enforces membership permissions over the actual HTTP interface', async t => {
  const { fixture, harness } = await setup(); t.after(() => fixture.close());
  const execution = await harness.begin();
  const alice = await login(fixture.appUrl); const bob = await login(fixture.appUrl, 'bob');
  const call = (cookie: string, path: string, method = 'GET', body?: unknown) => fetch(`${fixture.appUrl}${path}`, {
    method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const created = await call(alice.cookie, '/api/workspaces', 'POST', { name: 'HTTP workspace' });
  assert.equal(created.status, 201);
  const { workspace, document } = await created.json();
  assert.equal((await call(bob.cookie, `/api/documents/${document.id}`)).status, 403);
  const invited = await call(alice.cookie, `/api/workspaces/${workspace.id}/invitations`, 'POST', { recipient: 'bob' });
  assert.equal(invited.status, 201);
  assert.equal((await call(bob.cookie, `/api/invitations/${(await invited.json()).id}/accept`, 'POST', {})).status, 200);
  assert.equal((await call(bob.cookie, `/api/workspaces/${workspace.id}/members/alice`, 'DELETE')).status, 403);
  assert.equal((await call(bob.cookie, `/api/workspaces/${workspace.id}/invitations`, 'POST', { recipient: 'alice' })).status, 403);
  assert.equal((await call(bob.cookie, `/api/documents/${document.id}`)).status, 200);
  assert.equal((await call(alice.cookie, `/api/workspaces/${workspace.id}/members/bob`, 'DELETE')).status, 204);
  const before = await harness.inspect(execution);
  assert.equal((await call(bob.cookie, `/api/documents/${document.id}`, 'PATCH', { body: 'forbidden', expectedRevision: 1 })).status, 403);
  assert.equal((await call(bob.cookie, '/api/session')).status, 200);
  assert.deepEqual(await harness.inspect(execution), before);
  await harness.end(execution);
  const next = await harness.begin();
  assert.equal((await call(alice.cookie, '/api/session')).status, 401);
  await assert.rejects(harness.end(execution), (e: unknown) => e instanceof HarnessError && e.status === 403);
  assert.equal((await harness.inspect(next)).documents.length, 0);
});

it('fences an in-flight login body across an execution reset', async t => {
  const { fixture, harness } = await setup(); t.after(() => fixture.close());
  const execution = await harness.begin();
  const body = JSON.stringify({ actorKey: 'bob', password: credentials.bob });
  const req = request(`${fixture.appUrl}/api/session`, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Expect: '100-continue',
  } });
  t.after(() => req.destroy());
  const response = new Promise<number>(resolve => req.once('response', res => { res.resume(); resolve(res.statusCode!); }));
  const continued = new Promise<void>((resolve, reject) => { req.once('continue', resolve); req.once('error', reject); });
  req.flushHeaders(); await continued;
  await harness.end(execution); const next = await harness.begin();
  req.end(body);
  assert.equal(await response, 409);
  assert.equal((await harness.inspect(next)).memberships.length, 0);
});

it('closes the actor listener if the harness port cannot be bound', async t => {
  const { fixture } = await setup(); t.after(() => fixture.close());
  await assert.rejects(startFixture({ mode: 'baseline', credentials, harnessKey: randomBytes(32).toString('hex'),
    harnessPort: Number(new URL(fixture.harnessUrl).port) }), /EADDRINUSE/);
});
