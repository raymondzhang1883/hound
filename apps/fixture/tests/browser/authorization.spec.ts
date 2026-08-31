import { test, expect, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { startFixture } from '../../src/server.js';
import { FixtureHarness } from '../../src/harness-client.js';

const credentials = { alice: 'browser-test-alice', bob: 'browser-test-bob' };
async function signIn(page: Page, appUrl: string, actor: 'alice' | 'bob') {
  await page.goto(appUrl);
  await page.getByLabel('Account', { exact: true }).selectOption(actor);
  await page.getByLabel('Password', { exact: true }).fill(credentials[actor]);
  await page.getByRole('button', { name: 'Sign in', exact: false }).click();
  await expect(page.getByRole('heading', { name: 'A place for the work.' })).toBeVisible();
}

for (const mode of ['baseline', 'stale-write'] as const) {
  test(`${mode}: the same Alice/Bob browser sequence checks persisted authorization`, async ({ browser }, testInfo) => {
    const harnessKey = randomBytes(32).toString('hex');
    const fixture = await startFixture({ mode, credentials, harnessKey });
    const harness = new FixtureHarness(fixture.harnessUrl, harnessKey);
    const execution = await harness.begin();
    const aliceContext = await browser.newContext();
    const bobContext = await browser.newContext();
    const freshContext = await browser.newContext();
    try {
      const alice = await aliceContext.newPage(); const bob = await bobContext.newPage();
      const browserErrors: string[] = [];
      for (const page of [alice, bob]) page.on('pageerror', error => browserErrors.push(error.message));
      await signIn(alice, fixture.appUrl, 'alice');
      await signIn(bob, fixture.appUrl, 'bob');
      await alice.getByLabel('Workspace name').fill('Studio notes');
      await alice.getByRole('button', { name: 'Create workspace' }).click();
      await expect(alice.getByRole('heading', { name: 'Studio notes' })).toBeVisible();
      await alice.getByLabel('Invite a teammate').selectOption('bob');
      await alice.getByRole('button', { name: 'Send invitation' }).click();
      await expect(alice.getByRole('status')).toContainText('Invitation sent');
      await bob.getByRole('button', { name: 'Refresh', exact: true }).click();
      await bob.getByRole('button', { name: 'Accept invitation' }).click();
      await expect(bob.getByRole('status')).toContainText('Invitation accepted');
      await bob.getByRole('link', { name: /Studio notes.*Open workspace/ }).click();
      await bob.getByRole('link', { name: /Shared document/ }).click();
      await expect(bob.getByLabel('Document body')).toHaveValue('A shared place for the next big idea.');

      // A real pre-removal write rules out an always-denying or broken baseline.
      await bob.getByLabel('Document body').fill('Legitimate team edit');
      await bob.getByRole('button', { name: 'Save document' }).click();
      await expect(bob.getByRole('status')).toContainText('200 · Document saved. Revision 2.');
      const authorized = await harness.inspect(execution);
      expect(authorized.memberships.some(m => m.actorKey === 'bob')).toBe(true);
      expect(authorized.documents[0]?.body).toBe('Legitimate team edit');

      await alice.getByRole('button', { name: 'Refresh members' }).click();
      await alice.getByRole('button', { name: 'Remove Bob', exact: true }).click();
      await expect(alice.getByRole('status')).toContainText('Bob removed');
      const before = await harness.inspect(execution);
      expect(before.memberships.some(m => m.actorKey === 'bob')).toBe(false);
      const document = before.documents[0]!;
      const marker = `Post-removal write ${execution.id}`;
      await bob.getByLabel('Document body').fill(marker);
      const responsePromise = bob.waitForResponse(response => response.request().method() === 'PATCH');
      await bob.getByRole('button', { name: 'Save document' }).click();
      const response = await responsePromise;
      const expectedStatus = mode === 'baseline' ? 403 : 200;
      expect(response.status()).toBe(expectedStatus);
      await expect(bob.getByRole('status')).toContainText(String(expectedStatus));
      const after = await harness.inspect(execution);
      expect(after.documents[0]?.body).toBe(mode === 'baseline' ? document.body : marker);
      expect(after.documents[0]?.revision).toBe(mode === 'baseline' ? 2 : 3);
      expect((await bobContext.request.get(`${fixture.appUrl}/api/session`)).status()).toBe(200);
      expect((await bobContext.request.get(`${fixture.appUrl}/api/documents/${document.id}`)).status()).toBe(403);
      expect(browserErrors).toEqual([]);

      // Capture only post-login evidence. No raw headers, cookies, credentials, or harness tokens.
      const screenshotPath = testInfo.outputPath(`${mode}-post-removal.png`);
      await bob.screenshot({ path: screenshotPath, fullPage: true });
      await testInfo.attach('post-removal editor', { path: screenshotPath, contentType: 'image/png' });
      const evidencePath = testInfo.outputPath('evidence.json');
      await writeFile(evidencePath, JSON.stringify({ mode, actor: 'bob', membershipRemoved: true,
        request: { method: 'PATCH', path: `/api/documents/${document.id}` }, responseStatus: response.status(),
        before: { body: document.body, revision: document.revision },
        after: { body: after.documents[0]!.body, revision: after.documents[0]!.revision },
      }, null, 2));
      await testInfo.attach('fixture evidence', { path: evidencePath, contentType: 'application/json' });

      const freshBob = await freshContext.newPage();
      await signIn(freshBob, fixture.appUrl, 'bob');
      expect((await freshContext.request.patch(`${fixture.appUrl}/api/documents/${document.id}`, {
        data: { body: 'fresh session must be denied', expectedRevision: after.documents[0]!.revision },
      })).status()).toBe(403);
      expect(await harness.inspect(execution)).toEqual(after);
      await bob.reload();
      await expect(bob.getByRole('heading', { name: 'This space is unavailable.' })).toBeVisible();
      await expect(bob.getByLabel('Document body')).toHaveCount(0);
    } finally {
      await Promise.all([aliceContext.close(), bobContext.close(), freshContext.close()]);
      try { await harness.end(execution); } finally { await fixture.close(); }
    }
  });
}

test('small-screen login has no horizontal overflow', async ({ browser }) => {
  const harnessKey = randomBytes(32).toString('hex');
  const fixture = await startFixture({ mode: 'baseline', credentials, harnessKey });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const harness = new FixtureHarness(fixture.harnessUrl, harnessKey);
  const execution = await harness.begin();
  try {
    const page = await context.newPage();
    await page.goto(fixture.appUrl);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await signIn(page, fixture.appUrl, 'alice');
    await expect(page.getByRole('button', { name: 'Create workspace' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await context.close();
    try { await harness.end(execution); } finally { await fixture.close(); }
  }
});
