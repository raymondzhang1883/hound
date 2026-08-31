import type { Browser, BrowserContext, Page } from '@playwright/test';
import { reject, type HttpExchange } from './contracts.js';

/** Restricted transport for the controlled fixture, not an arbitrary-site security sandbox. */
export class ActorTransport {
  readonly context: BrowserContext;
  page!: Page;
  private active?: HttpExchange[];
  private pending = new Set<Promise<void>>();
  private bootstrapping = true;
  private failure?: string;
  private closing?: Promise<void>;
  private constructor(context: BrowserContext, private readonly origin: string) { this.context = context; }

  static async create(browser: Browser, origin: string) {
    const url = new URL(origin);
    if (url.origin !== origin || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) reject('invalid_app_origin');
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    const transport = new ActorTransport(context, origin);
    context.setDefaultTimeout(5_000);
    try {
      await context.routeWebSocket('**/*', socket => { transport.failure = 'websocket_blocked'; socket.close(); });
      await context.route('**/*', async route => {
        const request = route.request();
        const work = (async () => {
          try {
            const target = new URL(request.url());
            if (target.origin !== origin || target.username || target.password || (request.isNavigationRequest() && request.frame().parentFrame())) {
              transport.failure = 'network_target_blocked'; await route.abort(); return;
            }
            const destination = transport.active;
            if (target.pathname.startsWith('/api/') && !destination && !transport.bootstrapping) {
              transport.failure = 'unattributed_request'; await route.abort(); return;
            }
            // Follow no redirects, retry no requests, and preserve the real server response.
            const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 5_000 });
            if (response.status() >= 300 && response.status() < 400) {
              transport.failure = 'redirect_blocked'; await route.abort(); return;
            }
            if (target.pathname.startsWith('/api/') && destination) {
              let responseBody: unknown;
              if (response.status() !== 204) responseBody = await response.json();
              const exchange: HttpExchange = { method: request.method(), path: target.pathname, status: response.status() };
              // Authentication content is deliberately excluded from capture.
              if (target.pathname !== '/api/session') {
                exchange.responseBody = responseBody;
                if (request.postData()) exchange.requestBody = request.postDataJSON();
              }
              destination.push(exchange);
            }
            await route.fulfill({ response });
          } catch {
            transport.failure ??= 'request_incomplete';
            await route.abort().catch(() => {});
          }
        })();
        transport.pending.add(work);
        try { await work; } finally { transport.pending.delete(work); }
      });
      let pages = 0;
      context.on('page', page => {
        if (++pages > 1) { transport.failure = 'popup_blocked'; void page.close(); }
        page.on('download', download => { transport.failure = 'download_blocked'; void download.cancel(); });
      });
      transport.page = await context.newPage();
      return transport;
    } catch (error) { await context.close(); throw error; }
  }

  check() { if (this.failure) reject(this.failure); }
  async drain() { while (this.pending.size) await Promise.all([...this.pending]); this.check(); }
  async ready() { await this.drain(); this.bootstrapping = false; }
  begin() { this.check(); if (this.active) reject('concurrent_dispatch'); this.active = []; }
  async end() { await this.drain(); const exchanges = this.active ?? reject('missing_dispatch'); this.active = undefined; return exchanges; }
  async identity() {
    // Separate runtime-owned request, exact URL, no redirects/retries; never warms document access.
    const response = await this.context.request.get(`${this.origin}/api/session`, { maxRedirects: 0, maxRetries: 0, timeout: 5_000 });
    if (response.status() !== 200) return null;
    const body = await response.json();
    return body.actorKey === 'alice' || body.actorKey === 'bob' ? body.actorKey as 'alice' | 'bob' : null;
  }
  close(): Promise<void> {
    // Playwright can return early on a duplicate close. All owners must await the original
    // context teardown before the experiment releases its fixture execution.
    this.closing ??= (async () => { await this.context.close(); await Promise.allSettled([...this.pending]); })();
    return this.closing;
  }
}
