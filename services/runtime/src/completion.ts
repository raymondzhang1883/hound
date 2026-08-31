import type { Page, Locator } from '@playwright/test';

/** Fieldnotes-specific completion: current UI route plus its existing async-handler state. */
export async function waitForFixtureView(page: Page) {
  await page.waitForFunction(() => {
    const main = document.querySelector('#main');
    if (!main) return false;
    if (main.querySelector('#login') || main.querySelector('h1')?.textContent === 'This space is unavailable.') return true;
    if (location.hash.startsWith('#workspace/')) return !!main.querySelector('#refresh-members');
    if (location.hash.startsWith('#document/')) return !!main.querySelector('#edit-document');
    return !!main.querySelector('#create-workspace');
  }, undefined, { timeout: 5_000 });
}

export async function prepareClickCompletion(page: Page, locator: Locator) {
  const element = await locator.elementHandle();
  if (!element) throw new Error('missing_control');
  const href = await locator.getAttribute('href');
  const original = new URL(page.url());
  let response: Promise<unknown> | undefined;
  if (href) {
    const next = new URL(href, original);
    if (next.href !== original.href) {
      const match = /^#(workspace|document)\/([^/]+)$/.exec(next.hash);
      const expected = match ? `/api/${match[1] === 'workspace' ? 'workspaces' : 'documents'}/${match[2]}` : '/api/workspaces';
      response = page.waitForResponse(r => new URL(r.url()).pathname === expected, { timeout: 5_000 });
      // Dispatch can fail before this promise is consumed. Attach a rejection handler immediately.
      void response.catch(() => {});
    }
  }
  return async () => {
    try {
      if (response) await response;
      // Fieldnotes' perform() disables the button synchronously and reenables it only after
      // all awaited API/UI work. Replaced nodes also require a completed current route below.
      await page.waitForFunction(el => !el.isConnected || !('disabled' in el) || !(el as HTMLButtonElement).disabled, element, { timeout: 5_000 });
      await waitForFixtureView(page);
    } finally { await element.dispose(); }
  };
}
