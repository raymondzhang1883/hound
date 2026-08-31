import { randomUUID } from 'node:crypto';
import type { Page, Locator } from '@playwright/test';
import { Bindings } from './bindings.js';
import { reject, type Actor, type Control, type LocatorRecipe, type Observation } from './contracts.js';

export function locate(page: Page, recipe: LocatorRecipe, bindings: Bindings): Locator {
  const scope = recipe.scope ? page.getByRole(recipe.scope.role).filter({ hasText: bindings.render(recipe.scope.name) }) : page;
  const name = bindings.render(recipe.name);
  return recipe.by === 'label' ? scope.getByLabel(name, { exact: true }) : scope.getByRole(recipe.role!, { name, exact: true });
}

export class ActorView {
  private current?: Observation;
  private recipes = new Map<string, LocatorRecipe>();
  private known = new Set(['home']);
  constructor(readonly actor: Actor, private readonly page: Page, private readonly origin: string, private readonly bindings: Bindings, private readonly secrets: string[]) {}

  private safe(text: string) { return this.secrets.filter(Boolean).reduce((value, secret) => value.replaceAll(secret, '[redacted]'), this.bindings.display(text)); }
  private route() {
    const url = new URL(this.page.url());
    if (url.origin !== this.origin || url.search) reject('unsupported_page_route');
    return this.bindings.routeRef(url.pathname + url.hash);
  }
  canNavigate(ref: string) { if (!this.known.has(ref)) reject('unobserved_route'); }
  get latest() { return this.current ? structuredClone(this.current) : reject('missing_observation'); }

  async snapshot(): Promise<Observation> {
    const routeRef = this.route(); this.known.add(routeRef);
    const observationId = `obs_${randomUUID()}`;
    const controls: Control[] = []; this.recipes.clear(); let truncated = false;
    const body = await this.page.locator('body').innerText();
    for (const role of ['button', 'link', 'textbox', 'combobox'] as const) {
      for (const element of await this.page.getByRole(role).all()) {
        if (!await element.isVisible() || await element.getAttribute('type') === 'password') continue;
        const snapshot = await element.ariaSnapshot();
        const match = /^\s*- (?:button|link|textbox|combobox) ("(?:[^"\\]|\\.)*")/u.exec(snapshot);
        if (!match) { truncated = true; continue; }
        let name: string;
        try { name = JSON.parse(match[1]!); } catch { truncated = true; continue; }
        if (name.length > 512 || this.secrets.some(secret => secret && name.includes(secret))) { truncated = true; continue; }
        const recipe: LocatorRecipe = { by: 'role', role, name: this.bindings.template(name) };
        let locator = locate(this.page, recipe, this.bindings);
        if (await locator.count() !== 1) {
          const article = await element.evaluate(el => el.closest('article')?.innerText ?? null);
          if (!article || article.length > 1000 || this.secrets.some(secret => secret && article.includes(secret))) { truncated = true; continue; }
          recipe.scope = { role: 'article', name: this.bindings.template(article) };
          locator = locate(this.page, recipe, this.bindings);
        }
        if (await locator.count() !== 1) { truncated = true; continue; }
        if (role === 'link') {
          const href = await element.getAttribute('href');
          if (!href) continue;
          try {
            const link = new URL(href, this.page.url());
            if (link.origin !== this.origin || link.search) continue;
            this.known.add(this.bindings.routeRef(link.pathname + link.hash));
          } catch { continue; }
        }
        if (controls.length >= 40) { truncated = true; continue; }
        const control: Control = { id: `${observationId}_c${controls.length}`, role, name: this.safe(name), enabled: await element.isEnabled() };
        if (role === 'textbox' || role === 'combobox') control.value = this.safe(await element.inputValue()).slice(0, 1000);
        if (role === 'combobox') {
          control.options = await element.locator('option').evaluateAll(options => options.filter(el => !(el as HTMLOptionElement).disabled).map(el => (el as HTMLOptionElement).value));
          if (control.options.length > 30 || control.options.some(value => value.length > 256 || this.secrets.some(secret => secret && value.includes(secret)))) { truncated = true; continue; }
        }
        this.recipes.set(control.id, recipe); controls.push(control);
      }
    }
    this.current = { version: 1, actor: this.actor, session: 'primary', observationId, routeRef,
      text: this.safe(body).slice(0, 12_000), controls, knownRoutes: [...this.known], truncated: truncated || body.length > 12_000 };
    return this.latest;
  }

  async resolve(observationId: string, targetId: string) {
    if (!this.current || this.current.observationId !== observationId || this.current.routeRef !== this.route()) reject('stale_observation');
    const control = this.current.controls.find(control => control.id === targetId);
    const recipe = this.recipes.get(targetId);
    if (!control || !recipe) reject('unknown_control');
    const locator = locate(this.page, recipe, this.bindings);
    if (await locator.count() !== 1 || !await locator.isVisible() || !await locator.isEnabled() || !control.enabled) reject('control_changed');
    return { control: structuredClone(control), recipe: structuredClone(recipe), locator };
  }

  findRecipe(recipe: LocatorRecipe) {
    const target = [...this.recipes].find(([, value]) => JSON.stringify(value) === JSON.stringify(recipe));
    return target?.[0] ?? reject('replay_control_missing');
  }
}
