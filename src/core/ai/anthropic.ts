import type { Provider, ProviderOutcome, ProviderRequest } from './provider';

/**
 * Thin adapter for the Claude Messages API. It is only ever called by the guard (guard.ts), runs only in the Worker
 * (the browser never sees a key and the CSP forbids connecting to any other origin), and does exactly three things:
 * builds an allowlisted request body, sends it to the one fixed API host, and classifies the answer for the guard.
 *
 * What it will never send: tools (web search is billed per search), extended thinking, streaming, fast mode,
 * data-residency routing, service-tier or caching options — every one of those can change the price.
 */
export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'manual' }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export function buildBody(req: ProviderRequest): Record<string, unknown> {
  return {
    model: req.model,
    max_tokens: req.maxOutputTokens,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    ...(req.system ? { system: req.system } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
  };
}

/** Statuses for which the API refuses a request before running the model, so nothing is billed. */
const NOT_PROCESSED = new Set([400, 401, 403, 404, 413, 422, 429]);

export function classifyError(status: number, bodyText: string, secret: string): ProviderOutcome {
  let type: string | undefined;
  let message = '';
  let code: string | undefined;
  try {
    const j = JSON.parse(bodyText) as { type?: unknown; error?: { type?: unknown; message?: unknown; details?: { error_code?: unknown } } };
    if (j && j.type === 'error' && j.error && typeof j.error === 'object') {
      type = typeof j.error.type === 'string' ? j.error.type : undefined;
      message = typeof j.error.message === 'string' ? j.error.message : '';
      code = typeof j.error.details?.error_code === 'string' ? j.error.details.error_code : undefined;
    }
  } catch {
    /* not JSON: outcome unknown below */
  }
  const clean = scrub(message, secret).slice(0, 300);
  if (!type || !NOT_PROCESSED.has(status)) {
    return { kind: 'unknown', message: `The API answered with status ${status} that does not say whether the call was billed.` };
  }
  let limit: 'spend-limit' | 'credits' | undefined;
  if (code === 'enforced_spend_limit_reached' || /(specified|your) (workspace )?API usage limits?|monthly API usage threshold/i.test(message)) limit = 'spend-limit';
  else if (/credit balance is too low/i.test(message)) limit = 'credits';
  return { kind: 'rejected', status, message: clean || `The API refused the request (status ${status}).`, ...(limit ? { limit } : {}) };
}

function scrub(text: string, secret: string): string {
  return secret ? text.split(secret).join('[key]') : text;
}

export class AnthropicProvider implements Provider {
  constructor(
    private readonly apiKey: string,
    private readonly doFetch: FetchLike,
  ) {
    if (typeof apiKey !== 'string' || apiKey.length < 8) throw new Error('An API key is required.');
  }

  async complete(req: ProviderRequest, signal: AbortSignal): Promise<ProviderOutcome> {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.doFetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION, 'x-api-key': this.apiKey },
        body: JSON.stringify(buildBody(req)),
        signal,
        redirect: 'manual',
      });
    } catch {
      // The error object is deliberately not included: it can carry request details.
      const why = signal.aborted ? 'The request timed out.' : 'The connection failed.';
      return { kind: 'unknown', message: `${why} It may or may not have been billed.` };
    }

    let text: string;
    try {
      text = await res.text();
    } catch {
      return { kind: 'unknown', message: 'The answer could not be read. It may or may not have been billed.' };
    }

    if (res.status < 200 || res.status >= 300) return classifyError(res.status, text, this.apiKey);

    let json: { content?: unknown; usage?: unknown };
    try {
      json = JSON.parse(text) as { content?: unknown; usage?: unknown };
    } catch {
      return { kind: 'unknown', message: 'The answer was not valid JSON. It may have been billed.' };
    }
    const blocks = Array.isArray(json.content) ? json.content : [];
    const out = blocks
      .filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
      .map((b) => b.text)
      .join('');
    const workspaceId = res.headers.get('anthropic-workspace-id');
    const requestId = res.headers.get('request-id');
    return { kind: 'ok', text: out, usage: json.usage, ...(workspaceId ? { workspaceId } : {}), ...(requestId ? { requestId } : {}) };
  }
}
