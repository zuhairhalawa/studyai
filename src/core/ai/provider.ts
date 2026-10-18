import type { Usage } from './pricing';
import { isNonNegativeInt } from './money';

/** What the guard hands to a provider: already validated, already within the owner's limits. */
export interface ProviderRequest {
  model: string;
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxOutputTokens: number;
  temperature?: number;
}

/**
 * What a provider tells the guard. The distinction that matters for money:
 *  - `rejected`: the API answered with an error that means the model was NOT run (so nothing was billed);
 *  - `unknown`: anything else that is not a clean success (timeout, dropped connection, 5xx, unreadable answer) —
 *    the call may or may not have been billed, so the guard keeps it charged.
 */
export type ProviderOutcome =
  | {
      kind: 'ok';
      text: string;
      /** Provider-neutral usage shape (see parseUsage). Anything unreadable makes the guard charge the full reservation. */
      usage: unknown;
      workspaceId?: string;
      requestId?: string;
      /** True when the model stopped because it hit the output cap: the text is cut off and may be unfinished. */
      truncated?: boolean;
      /** Cost the token counts do not capture (for example a billed search). Added to the call's cost. */
      extraCostNanos?: number;
      /** Something happened that must never happen with the allowed request shape; the guard pauses AI. */
      anomaly?: string;
    }
  | { kind: 'rejected'; status: number; message: string; limit?: LimitKind }
  | { kind: 'unknown'; message: string };

/**
 * What a refusal says about limits, and therefore how long AI stays paused:
 *  spend-limit   – a Console spend limit (Claude): until the next month starts (UTC)
 *  credits       – the credit balance is empty (Claude): until the owner lifts the pause
 *  quota-day     – the daily free quota is used up (Gemini): until the next Pacific midnight
 *  quota-minute  – a per-minute limit (Gemini): one minute
 *  billing-signal – the provider talks about prepay/billing/payment, so a billing account may be linked (Gemini): owner only
 *  no-free-tier  – the provider says the free tier is not available here (Gemini): owner only; never "fix" it by enabling billing
 */
export type LimitKind = 'spend-limit' | 'credits' | 'quota-day' | 'quota-minute' | 'billing-signal' | 'no-free-tier';

export interface Provider {
  complete(req: ProviderRequest, signal: AbortSignal): Promise<ProviderOutcome>;
}

/**
 * Reads the usage block of a successful response. Returns undefined unless every figure that is present is a sane
 * non-negative integer and the two core counters exist — a response we cannot price is charged at its full reservation.
 */
export function parseUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const optional = (v: unknown): number | undefined => (v === undefined || v === null ? 0 : isNonNegativeInt(v) ? v : undefined);
  if (!isNonNegativeInt(u['input_tokens']) || !isNonNegativeInt(u['output_tokens'])) return undefined;
  const cacheWrite = optional(u['cache_creation_input_tokens']);
  const cacheRead = optional(u['cache_read_input_tokens']);
  if (cacheWrite === undefined || cacheRead === undefined) return undefined;
  let webSearches = 0;
  const tool = u['server_tool_use'];
  if (tool !== undefined && tool !== null) {
    if (typeof tool !== 'object') return undefined;
    const n = optional((tool as Record<string, unknown>)['web_search_requests']);
    if (n === undefined) return undefined;
    webSearches = n;
  }
  return { inputTokens: u['input_tokens'], outputTokens: u['output_tokens'], cacheWriteTokens: cacheWrite, cacheReadTokens: cacheRead, webSearches };
}
