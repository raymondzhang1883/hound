import { DECISION_SCHEMA, POLICY_INSTRUCTIONS, PROMPT_VERSION, PolicyError, type Policy, type PolicyInput } from './policy.js';

export const MODEL = 'gpt-5.4-mini-2026-03-17';
export const RATE_CARD = { checkedAt: '2026-08-31', inputPerMillionUsd: 0.75, outputPerMillionUsd: 4.50,
  source: 'https://developers.openai.com/api/docs/models/gpt-5.4-mini', cachedDiscountApplied: false } as const;
const MAX_OUTPUT_TOKENS = 4096;
const MAX_REQUEST_BYTES = 96 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const costMicros = (input: number, output: number) => Math.ceil(input * RATE_CARD.inputPerMillionUsd + output * RATE_CARD.outputPerMillionUsd);
interface TokenUsage { inputTokens: number; outputTokens: number }
interface OpenAIConfig { apiKey: string; maxCostUsd: number; maxCalls?: number; timeoutMs?: number; transport?: typeof fetch }

/** Fixed endpoint and model. The injectable transport is only for credential-free protocol tests. */
export class OpenAIPolicy implements Policy {
  readonly metadata = { provider: 'openai', model: MODEL, reasoning: 'medium', promptVersion: PROMPT_VERSION, simulated: false } as const;
  private spentMicros = 0;
  private calls = 0;
  private unknownCalls = 0;
  private tokens: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  private stopped?: string;
  private busy = false;
  constructor(private readonly config: OpenAIConfig) {
    if (!config.apiKey.trim()) throw new PolicyError('missing_api_key');
    if (!Number.isFinite(config.maxCostUsd) || config.maxCostUsd <= 0 || config.maxCostUsd > 10) throw new PolicyError('invalid_cost_budget');
    if (!Number.isInteger(config.maxCalls ?? 120) || (config.maxCalls ?? 120) < 1 || (config.maxCalls ?? 120) > 120) throw new PolicyError('invalid_call_budget');
    if (!Number.isInteger(config.timeoutMs ?? 30_000) || (config.timeoutMs ?? 30_000) < 1 || (config.timeoutMs ?? 30_000) > 30_000) throw new PolicyError('invalid_provider_timeout');
  }
  accounting() {
    return { calls: this.calls, unknownUsageCalls: this.unknownCalls, reportedTokens: { ...this.tokens },
      estimatedCostUsd: this.spentMicros / 1_000_000, maxCostUsd: this.config.maxCostUsd, maxCalls: this.config.maxCalls ?? 120,
      maxOutputTokens: MAX_OUTPUT_TOKENS, rateCard: RATE_CARD };
  }
  async decide(input: PolicyInput, signal: AbortSignal): Promise<unknown> {
    if (this.stopped) throw new PolicyError(this.stopped);
    if (this.busy) throw new PolicyError('concurrent_provider_call');
    if (signal.aborted) throw new PolicyError('cancelled');
    if (this.calls >= (this.config.maxCalls ?? 120)) throw new PolicyError('provider_call_budget');
    const body = JSON.stringify({ model: MODEL, instructions: POLICY_INSTRUCTIONS,
      input: [{ role: 'user', content: JSON.stringify(input) }],
      text: { format: { type: 'json_schema', name: 'hound_browser_decision_v1', strict: true, schema: DECISION_SCHEMA } },
      reasoning: { effort: 'medium' }, max_output_tokens: MAX_OUTPUT_TOKENS, tools: [], store: false, service_tier: 'default',
    });
    const bytes = Buffer.byteLength(body);
    if (bytes > MAX_REQUEST_BYTES) throw new PolicyError('policy_input_too_large');
    if (body.includes(this.config.apiKey)) throw new PolicyError('secret_in_policy_input');
    // UTF-8 bytes plus framing is a conservative estimate, not a provider-side billing limit.
    const reservation = costMicros(bytes + 2048, MAX_OUTPUT_TOKENS);
    if (this.spentMicros + reservation > Math.floor(this.config.maxCostUsd * 1_000_000)) throw new PolicyError('cost_budget');
    this.spentMicros += reservation; this.calls++; this.busy = true;
    let accounted = false;
    const timeout = AbortSignal.timeout(this.config.timeoutMs ?? 30_000);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      const response = await (this.config.transport ?? fetch)('https://api.openai.com/v1/responses', {
        method: 'POST', redirect: 'error', signal: combined,
        headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' }, body,
      });
      if (!response.ok) { await response.body?.cancel(); throw new PolicyError(`provider_http_${response.status}`); }
      const reader = response.body?.getReader();
      if (!reader) throw new PolicyError('provider_empty_response');
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_RESPONSE_BYTES) throw new PolicyError('provider_response_too_large');
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      let data: any;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new PolicyError('provider_invalid_response'); }
      const usage = data?.usage;
      if (usage && Number.isSafeInteger(usage.input_tokens) && usage.input_tokens >= 0 && Number.isSafeInteger(usage.output_tokens) && usage.output_tokens >= 0) {
        const actual = costMicros(usage.input_tokens, usage.output_tokens);
        this.spentMicros += actual - reservation;
        this.tokens.inputTokens += usage.input_tokens; this.tokens.outputTokens += usage.output_tokens;
        accounted = true;
        if (actual > reservation || this.spentMicros > Math.floor(this.config.maxCostUsd * 1_000_000)) throw new PolicyError('cost_estimate_exceeded');
      }
      if (!accounted) throw new PolicyError('provider_usage_unknown');
      if (data.model !== MODEL || (data.service_tier && data.service_tier !== 'default')) throw new PolicyError('provider_configuration_mismatch');
      if (!Array.isArray(data.output)) throw new PolicyError('provider_invalid_response');
      const content = data.output.filter((item: any) => item?.type === 'message').flatMap((item: any) => Array.isArray(item.content) ? item.content : []);
      if (content.some((item: any) => item?.type === 'refusal') || data.incomplete_details?.reason === 'content_filter') throw new PolicyError('provider_refused');
      if (data.status !== 'completed') throw new PolicyError('provider_incomplete');
      const texts = content.filter((item: any) => item?.type === 'output_text');
      if (texts.length !== 1 || typeof texts[0].text !== 'string' || Buffer.byteLength(texts[0].text) > 16_384) throw new PolicyError('provider_invalid_decision');
      let envelope: any;
      try { envelope = JSON.parse(texts[0].text); } catch { throw new PolicyError('provider_invalid_decision'); }
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).length !== 1 || !Object.hasOwn(envelope, 'decision')) throw new PolicyError('provider_invalid_decision');
      // The runtime still validates the untrusted decision and counts invalid proposals.
      return envelope.decision;
    } catch (error) {
      if (!accounted) this.unknownCalls++;
      this.stopped = signal.aborted ? 'cancelled' : timeout.aborted ? 'provider_timeout' : error instanceof PolicyError ? error.code : 'provider_transport_error';
      throw new PolicyError(this.stopped);
    } finally { this.busy = false; }
  }
}
