import { createHash } from 'node:crypto';
import type { Browser } from '@playwright/test';
import { FixtureHarness, type Execution, type FixtureSnapshot } from '../../../apps/fixture/src/harness-client.js';
import type { Credentials } from '../../../apps/fixture/src/store.js';
import { Bindings } from './bindings.js';
import { ActorTransport } from './transport.js';
import { ActorView } from './observation.js';
import { waitForFixtureView, prepareClickCompletion } from './completion.js';
import { parseDecision, reject, ContractError, type Actor, type Decision, type LocatorRecipe, type TextValue, type TextTemplate } from './contracts.js';
import { RemovedMemberWriteOracle, canonical, type Verdict, type ReplayConclusion } from './oracle.js';

export interface ExperimentConfig {
  appUrl: string; harnessUrl: string; harnessKey: string; credentials: Credentials;
  maxDecisions?: number; deadlineMs?: number; trialText?: string;
}
export type RecordedAction =
  | { actor: Actor; kind: 'click'; recipe: LocatorRecipe }
  | { actor: Actor; kind: 'fill'; recipe: LocatorRecipe; value: TextValue }
  | { actor: Actor; kind: 'select'; recipe: LocatorRecipe; option: string }
  | { actor: Actor; kind: 'observe' }
  | { actor: Actor; kind: 'navigate'; routeRef: string };
export interface RecordedStep { action: RecordedAction; before: TextTemplate; after: TextTemplate; http: TextTemplate }
export interface ReplayPlan { version: 1; id: string; steps: RecordedStep[]; probeActor: Actor; probeResource: string }
export type StepResult = { status: 'executed'; verdict: Verdict } | { status: 'rejected' | 'inconclusive' | 'stopped'; code: string };
const actors = ['alice', 'bob'] as const;
const planHash = (plan: Omit<ReplayPlan, 'id'>) => createHash('sha256').update(canonical(plan)).digest('hex');
const rejectedTargets = new Set(['stale_observation', 'unknown_control', 'control_changed', 'incompatible_control',
  'invalid_link_target', 'unobserved_route', 'unobserved_option']);

/** Hosts deterministic execution only. A policy may see observations(), never this object's evidence. */
export class BrowserExperiment {
  private transports = new Map<Actor, ActorTransport>();
  private views = new Map<Actor, ActorView>();
  private bindings: Bindings;
  private oracle: RemovedMemberWriteOracle;
  private records: RecordedStep[] = [];
  private lastVerdict: Verdict = { kind: 'not_applicable' };
  private terminal?: string;
  private locked = false;
  private decisions = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private closing?: Promise<void>;
  private constructor(private readonly config: ExperimentConfig, private readonly harness: FixtureHarness, private readonly execution: Execution) {
    this.bindings = new Bindings(config.trialText);
    this.oracle = new RemovedMemberWriteOracle(execution.id);
  }

  static async open(browser: Browser, config: ExperimentConfig) {
    if (config.appUrl === config.harnessUrl) reject('shared_app_harness_origin');
    if (!Number.isInteger(config.maxDecisions ?? 40) || (config.maxDecisions ?? 40) < 1 || (config.maxDecisions ?? 40) > 120) reject('invalid_budget');
    if (!Number.isFinite(config.deadlineMs ?? 600_000) || (config.deadlineMs ?? 600_000) < 1 || (config.deadlineMs ?? 600_000) > 600_000) reject('invalid_deadline');
    // Validate before acquiring state; an invalid marker must not leak an execution handle.
    new Bindings(config.trialText);
    const harness = new FixtureHarness(config.harnessUrl, config.harnessKey);
    if ((await harness.health()).contractVersion !== 1) reject('unsupported_fixture_contract');
    const execution = await harness.begin();
    const experiment = new BrowserExperiment(config, harness, execution);
    try {
      const initial = await harness.inspect(execution);
      if (initial.workspaces.length || initial.memberships.length || initial.documents.length || initial.invitations.length) reject('dirty_fixture');
      const secrets = [config.harnessKey, execution.token, ...Object.values(config.credentials)];
      for (const actor of actors) {
        const transport = await ActorTransport.create(browser, config.appUrl);
        experiment.transports.set(actor, transport);
        const page = transport.page;
        await page.goto(config.appUrl);
        await page.getByLabel('Account', { exact: true }).selectOption(actor);
        await page.getByLabel('Password', { exact: true }).fill(config.credentials[actor]);
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        await page.getByRole('heading', { name: 'A place for the work.', exact: true }).waitFor();
        if (await transport.identity() !== actor) reject('bootstrap_identity_mismatch');
        await transport.ready();
        const view = new ActorView(actor, page, config.appUrl, experiment.bindings, secrets);
        experiment.views.set(actor, view); await view.snapshot();
      }
      experiment.timer = setTimeout(() => {
        experiment.terminal = 'trial_deadline';
        void experiment.closeBrowsers().catch(() => {});
      }, config.deadlineMs ?? 600_000);
      return experiment;
    } catch (error) { await experiment.close(); throw error; }
  }

  observations() { return { alice: this.views.get('alice')!.latest, bob: this.views.get('bob')!.latest }; }
  get usage() { return { proposed: this.decisions, executed: this.records.length }; }
  private state(snapshot: FixtureSnapshot) {
    const { executionId: _, ...data } = snapshot;
    return this.bindings.template(canonical(data));
  }
  private async closeBrowsers() { await Promise.all([...this.transports.values()].map(transport => transport.close())); }

  async step(input: unknown): Promise<StepResult> {
    if (this.terminal) return { status: 'stopped', code: this.terminal };
    if (this.locked) return { status: 'rejected', code: 'concurrent_dispatch' };
    if (++this.decisions > (this.config.maxDecisions ?? 40)) { this.terminal = 'decision_budget'; return { status: 'stopped', code: this.terminal }; }
    this.locked = true;
    let dispatched = false;
    let parsing = true;
    let actionTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const decision = parseDecision(input);
      parsing = false;
      if (decision.kind === 'stop') { this.terminal = 'policy_stopped'; return { status: 'stopped', code: this.terminal }; }
      const transport = this.transports.get(decision.actor)!;
      const view = this.views.get(decision.actor)!;
      for (const other of this.transports.values()) await other.drain();
      let action: RecordedAction;
      let dispatch: () => Promise<void>;
      if (decision.kind === 'navigate') {
        view.canNavigate(decision.routeRef);
        action = { actor: decision.actor, kind: 'navigate', routeRef: decision.routeRef };
        dispatch = async () => { await transport.page.goto(this.config.appUrl + this.bindings.route(decision.routeRef)); await waitForFixtureView(transport.page); };
      } else if (decision.kind === 'observe') {
        action = { actor: decision.actor, kind: 'observe' }; dispatch = async () => {};
      } else {
        const { recipe, control, locator } = await view.resolve(decision.observationId, decision.targetId);
        if (decision.kind === 'click') {
          if (!['button', 'link'].includes(control.role)) reject('incompatible_control');
          if (control.role === 'link') {
            const target = new URL((await locator.getAttribute('href'))!, transport.page.url());
            if (target.origin !== this.config.appUrl || target.search || target.username || target.password) reject('invalid_link_target');
            view.canNavigate(this.bindings.routeRef(target.pathname + target.hash));
          }
          action = { actor: decision.actor, kind: 'click', recipe };
          dispatch = async () => {
            const finish = await prepareClickCompletion(transport.page, locator);
            await locator.click(); await finish();
          };
        } else if (decision.kind === 'fill') {
          if (control.role !== 'textbox') reject('incompatible_control');
          action = { actor: decision.actor, kind: 'fill', recipe, value: decision.value };
          dispatch = () => locator.fill(this.bindings.text(decision.value));
        } else {
          if (control.role !== 'combobox' || !control.options?.includes(decision.option)) reject('unobserved_option');
          action = { actor: decision.actor, kind: 'select', recipe, option: decision.option };
          dispatch = async () => { await locator.selectOption(decision.option); };
        }
      }
      const before = await this.harness.inspect(this.execution);
      const verifiedActor = await transport.identity();
      if (verifiedActor !== decision.actor) reject('authentication_lost');
      transport.begin(); dispatched = true;
      actionTimer = setTimeout(() => { this.terminal = 'action_timeout'; void this.closeBrowsers().catch(() => {}); }, 5_000);
      await dispatch();
      const exchanges = await transport.end();
      for (const other of this.transports.values()) other.check();
      const after = await this.harness.inspect(this.execution);
      const stillAuthenticated = await transport.identity();
      if (this.terminal) reject(this.terminal);
      if (stillAuthenticated !== decision.actor) reject('authentication_lost');
      const index = this.records.length;
      for (const exchange of exchanges) this.bindings.capture(exchange, index);
      const verdict = this.oracle.observe({ step: index, actor: decision.actor, session: `${decision.actor}/primary`,
        verifiedActor: stillAuthenticated, complete: true, before, after, exchanges });
      if (verdict.kind === 'inconclusive') reject(verdict.reason);
      this.records.push({ action, before: this.state(before), after: this.state(after),
        http: this.bindings.template(canonical(exchanges.map(e => ({ method: e.method, path: e.path, status: e.status })).sort((a, b) => canonical(a).localeCompare(canonical(b))))) });
      this.lastVerdict = verdict;
      await view.snapshot();
      return { status: 'executed', verdict };
    } catch (error) {
      const code = error instanceof ContractError ? error.code : 'execution_failed';
      // Only known proposal errors are recoverable. Broken browsers, transport, or inspection
      // are inconclusive even if they fail before dispatching an application interaction.
      if (!dispatched && !this.terminal && error instanceof ContractError && (parsing || rejectedTargets.has(code))) return { status: 'rejected', code };
      this.terminal ??= code; await this.closeBrowsers();
      return { status: 'inconclusive', code: this.terminal };
    } finally { if (actionTimer) clearTimeout(actionTimer); this.locked = false; }
  }

  plan(): ReplayPlan {
    if (!['violation', 'denied'].includes(this.lastVerdict.kind) || this.terminal) reject('no_valid_probe');
    const verdict = this.lastVerdict as Extract<Verdict, { documentId: string }>;
    const data = { version: 1 as const, steps: structuredClone(this.records), probeActor: verdict.actor, probeResource: this.bindings.ref(verdict.documentId) };
    return { ...data, id: planHash(data) };
  }

  async replay(plan: ReplayPlan): Promise<ReplayConclusion> {
    const conclusion: ReplayConclusion = { planId: plan.id, probeStep: plan.steps.length - 1, actor: plan.probeActor,
      resourceRef: plan.probeResource, setupEquivalent: false, result: 'inconclusive' };
    const { id, ...data } = plan;
    if (plan.version !== 1 || planHash(data) !== id || !plan.steps.length || this.records.length || plan.steps.length > 120) return conclusion;
    for (let index = 0; index < plan.steps.length; index++) {
      const record = plan.steps[index]!;
      const action = record.action;
      const view = this.views.get(action.actor);
      if (!view) return conclusion;
      let decision: Decision;
      try {
        if ('recipe' in action) {
          const observation = await view.snapshot();
          const targetId = view.findRecipe(action.recipe);
          decision = { version: 1, ...action, observationId: observation.observationId, targetId } as Decision;
          // Recipes are trusted runtime records, never part of a policy action's schema.
          delete (decision as unknown as Record<string, unknown>).recipe;
        } else decision = { version: 1, ...action };
      } catch { return conclusion; }
      const result = await this.step(decision);
      if (result.status !== 'executed') return conclusion;
      const actual = this.records[index]!;
      if (canonical(actual.before) !== canonical(record.before)) return conclusion;
      if (index < plan.steps.length - 1) {
        if (canonical(actual.after) !== canonical(record.after) || canonical(actual.http) !== canonical(record.http)) return conclusion;
      } else {
        if (result.verdict.kind !== 'denied' && result.verdict.kind !== 'violation') return conclusion;
        if (this.bindings.ref(result.verdict.documentId) !== plan.probeResource || result.verdict.actor !== plan.probeActor) return conclusion;
        return { ...conclusion, setupEquivalent: true, result: result.verdict.kind };
      }
    }
    return conclusion;
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      if (this.timer) clearTimeout(this.timer);
      this.terminal ??= 'closed';
      // Release only after browser activity has been stopped. Surface cleanup failure to the owner.
      await this.closeBrowsers();
      await this.harness.end(this.execution);
    })();
    return this.closing;
  }
}
