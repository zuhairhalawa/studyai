import type { LimitKind, Provider, ProviderOutcome, ProviderRequest } from './provider';

/**
 * Adapter for the Gemini API (generateContent). Runs only in the Worker. Like the Claude adapter it builds an
 * allowlisted body, talks to one fixed host, and classifies answers for the guard.
 *
 * What it never sends: tools (Google Search / Maps grounding are billed per query beyond a small free allowance, code
 * execution), cached content, service tiers (priority/flex change the price), streaming, labels. The key goes in a header,
 * never in the URL (URLs end up in logs).
 */
export const GEMINI_HOST = 'https://generativelanguage.googleapis.com';
const MODEL_RE = /^[a-z0-9][a-z0-9.-]{0,60}$/;

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'manual' }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export function geminiUrl(model: string): string {
  if (!MODEL_RE.test(model)) throw new Error('invalid model name');
  return `${GEMINI_HOST}/v1beta/models/${model}:generateContent`;
}

export function buildGeminiBody(req: ProviderRequest): Record<string, unknown> {
  return {
    contents: req.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
    generationConfig: { maxOutputTokens: req.maxOutputTokens, candidateCount: 1, ...(req.temperature !== undefined ? { temperature: req.temperature } : {}) },
  };
}

/** Statuses where Google refuses a request before running the model. 5xx and anything else stay "unknown" (kept charged). */
const REFUSED = new Set([400, 401, 402, 403, 404, 413, 429]);

function scrub(text: string, secret: string): string {
  return secret ? text.split(secret).join('[key]') : text;
}

export function classifyGeminiError(status: number, bodyText: string, secret: string): ProviderOutcome {
  let message = '';
  let detail = '';
  let hasError = false;
  try {
    const j = JSON.parse(bodyText) as { error?: { message?: unknown; details?: unknown } };
    if (j && typeof j === 'object' && j.error && typeof j.error === 'object') {
      hasError = true;
      message = typeof j.error.message === 'string' ? j.error.message : '';
      detail = j.error.details === undefined ? '' : JSON.stringify(j.error.details).slice(0, 2000);
    }
  } catch {
    /* unreadable body */
  }
  // A 402 is a payment error by definition; other refusals need a readable Google error body.
  if (status !== 402 && (!REFUSED.has(status) || !hasError)) {
    return { kind: 'unknown', message: `The API answered with status ${status} that does not say whether the call was billed.` };
  }
  const text = `${message} ${detail}`;
  let limit: LimitKind | undefined;
  if (status === 402) limit = 'billing-signal';
  else if (status === 429) {
    // The ordinary quota message says "check your plan and billing details", so "billing" alone must not count here.
    if (/prepay|depleted/i.test(text)) limit = 'billing-signal';
    else if (/per ?day|daily|\bRPD\b/i.test(text)) limit = 'quota-day';
    else limit = 'quota-minute';
  } else if (status === 400) {
    if (/free tier[^.]{0,80}(not available|unavailable)|(not available|unavailable)[^.]{0,80}free tier/i.test(text)) limit = 'no-free-tier';
    else if (/prepay|prepaid|billing/i.test(text)) limit = 'billing-signal';
  }
  const clean = scrub(message, secret).slice(0, 300);
  return { kind: 'rejected', status, message: clean || `The API refused the request (status ${status}).`, ...(limit ? { limit } : {}) };
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/**
 * Maps Gemini's usageMetadata to the provider-neutral shape the guard prices. Thinking tokens are billed as output.
 * Returns undefined for anything missing or inconsistent, which makes the guard charge the full reservation.
 */
export function normaliseGeminiUsage(raw: unknown): { input_tokens: number; output_tokens: number; cache_read_input_tokens: number } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const opt = (v: unknown): number | undefined => (v === undefined || v === null ? 0 : isCount(v) ? v : undefined);
  if (!isCount(u['promptTokenCount'])) return undefined;
  const prompt = u['promptTokenCount'];
  const cached = opt(u['cachedContentTokenCount']);
  const candidates = opt(u['candidatesTokenCount']);
  const thoughts = opt(u['thoughtsTokenCount']);
  const toolUse = opt(u['toolUsePromptTokenCount']);
  if (cached === undefined || candidates === undefined || thoughts === undefined || toolUse === undefined) return undefined;
  if (cached > prompt) return undefined;
  // Cross-check against the total Google reports: tokens it counts that no field explains are billed as output (the dearest rate).
  let unexplained = 0;
  if (u['totalTokenCount'] !== undefined && u['totalTokenCount'] !== null) {
    if (!isCount(u['totalTokenCount'])) return undefined;
    unexplained = Math.max(0, u['totalTokenCount'] - (prompt + toolUse + candidates + thoughts));
  }
  return { input_tokens: prompt - cached + toolUse, cache_read_input_tokens: cached, output_tokens: candidates + thoughts + unexplained };
}

/** $35 per 1 000 grounded prompts is the dearest search price listed; one query is charged at that if grounding ever appears. */
const SEARCH_NANOS = 35_000_000;

export class GeminiProvider implements Provider {
  constructor(
    private readonly apiKey: string,
    private readonly doFetch: FetchLike,
  ) {
    if (typeof apiKey !== 'string' || apiKey.length < 8) throw new Error('An API key is required.');
  }

  async complete(req: ProviderRequest, signal: AbortSignal): Promise<ProviderOutcome> {
    let url: string;
    try {
      url = geminiUrl(req.model);
    } catch {
      return { kind: 'rejected', status: 400, message: 'The model name is not valid. Nothing was sent.' };
    }
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.doFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey }, body: JSON.stringify(buildGeminiBody(req)), signal, redirect: 'manual' });
    } catch {
      // The error object is deliberately not included: it can carry request details.
      return { kind: 'unknown', message: `${signal.aborted ? 'The request timed out.' : 'The connection failed.'} It may or may not have been billed.` };
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      return { kind: 'unknown', message: 'The answer could not be read. It may or may not have been billed.' };
    }
    // A redirect is never followed (the key header must not travel to another host; Workers only offer follow or manual).
    // The model did not run, but nothing here proves it, so it is treated like any unclear answer: kept charged until the owner checks.
    if (res.status >= 300 && res.status < 400) return { kind: 'unknown', message: 'The API answered with a redirect, which is never followed. It may or may not have been billed.' };
    if (res.status < 200 || res.status >= 300) return classifyGeminiError(res.status, text, this.apiKey);

    let json: { candidates?: unknown; usageMetadata?: unknown; responseId?: unknown };
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      return { kind: 'unknown', message: 'The answer was not valid JSON. It may have been billed.' };
    }
    const candidates = Array.isArray(json.candidates) ? (json.candidates as unknown[]) : [];
    const first = (candidates[0] ?? {}) as { content?: { parts?: unknown }; finishReason?: unknown; groundingMetadata?: { webSearchQueries?: unknown } };
    const parts = Array.isArray(first.content?.parts) ? (first.content!.parts as unknown[]) : [];
    const out = parts
      .filter((p): p is { text: string; thought?: boolean } => !!p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' && (p as { thought?: unknown }).thought !== true)
      .map((p) => p.text)
      .join('');
    const grounded = candidates.some((c) => !!c && typeof c === 'object' && (c as { groundingMetadata?: unknown }).groundingMetadata !== undefined);
    let extra = 0;
    if (grounded) {
      const q = first.groundingMetadata?.webSearchQueries;
      extra = SEARCH_NANOS * Math.max(1, Array.isArray(q) ? q.length : 1);
    }
    const requestId = typeof json.responseId === 'string' && json.responseId.length <= 200 ? json.responseId : undefined;
    return {
      kind: 'ok',
      text: out,
      usage: normaliseGeminiUsage(json.usageMetadata),
      ...(requestId ? { requestId } : {}),
      ...(first.finishReason === 'MAX_TOKENS' ? { truncated: true } : {}),
      ...(grounded ? { extraCostNanos: extra, anomaly: 'a search/grounding result came back although tools are never enabled, so the request shape may have changed.' } : {}),
    };
  }
}
