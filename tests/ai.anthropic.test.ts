import { describe, expect, it } from 'vitest';
import { ANTHROPIC_URL, ANTHROPIC_VERSION, AnthropicProvider, buildBody, classifyError } from '../src/core/ai/anthropic';
import { parseUsage } from '../src/core/ai/provider';

const KEY = 'sk-ant-test-0123456789';
const REQ = { model: 'claude-haiku-5-5', maxOutputTokens: 100, messages: [{ role: 'user' as const, content: 'hi' }] };

type Reply = { status: number; headers?: Record<string, string>; body: string };
function fakeFetch(reply: Reply | (() => Reply) | Error) {
  const seen: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = [];
  const doFetch = async (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => {
    seen.push({ url, init });
    if (reply instanceof Error) throw reply;
    const r = typeof reply === 'function' ? reply() : reply;
    return { status: r.status, headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null }, text: async () => r.body };
  };
  return { doFetch, seen };
}
const signal = () => new AbortController().signal;

// Error bodies exactly as Anthropic documents them (https://platform.claude.com/docs/en/api/rate-limits).
const SPEND_CAP_429 = JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'You have reached your API usage limits: your organization has crossed its monthly API usage threshold, set based on your organization\'s API tier. You will regain access on 2026-11-01 at 00:00 UTC.', details: { error_code: 'enforced_spend_limit_reached' } }, request_id: 'req_1' });
const OWN_LIMIT_400 = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'You have reached your specified workspace API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.' } });
const NO_CREDIT_400 = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } });

describe('request body: an allowlist, never anything that changes the price', () => {
  it('contains exactly the plain-text fields', () => {
    expect(Object.keys(buildBody(REQ)).sort()).toEqual(['max_tokens', 'messages', 'model']);
    expect(Object.keys(buildBody({ ...REQ, system: 's', temperature: 0.3 })).sort()).toEqual(['max_tokens', 'messages', 'model', 'system', 'temperature']);
    const banned = ['tools', 'tool_choice', 'thinking', 'stream', 'speed', 'inference_geo', 'service_tier', 'mcp_servers', 'container', 'cache_control', 'betas'];
    for (const k of banned) expect(buildBody({ ...REQ, system: 's', temperature: 0 }), k).not.toHaveProperty(k);
  });

  it('only ever talks to the one fixed API host, with the key in the header only', async () => {
    const { doFetch, seen } = fakeFetch({ status: 200, body: JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }) });
    await new AnthropicProvider(KEY, doFetch).complete(REQ, signal());
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(ANTHROPIC_URL).toBe(seen[0]!.url);
    expect(seen[0]!.init.method).toBe('POST');
    expect(seen[0]!.init.headers).toEqual({ 'content-type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION, 'x-api-key': KEY });
    expect(seen[0]!.init.body).not.toContain(KEY);
    expect(seen[0]!.url).not.toContain(KEY);
  });

  it('needs a key', () => {
    expect(() => new AnthropicProvider('', fakeFetch({ status: 200, body: '' }).doFetch)).toThrow();
    expect(() => new AnthropicProvider('short', fakeFetch({ status: 200, body: '' }).doFetch)).toThrow();
  });
});

describe('answers', () => {
  it('returns the text, the raw usage, and the workspace and request ids', async () => {
    const { doFetch } = fakeFetch({
      status: 200,
      headers: { 'anthropic-workspace-id': 'wrkspc_abc', 'request-id': 'req_9' },
      body: JSON.stringify({ content: [{ type: 'text', text: 'Hello ' }, { type: 'tool_use', id: 'x' }, { type: 'text', text: 'world' }], usage: { input_tokens: 12, output_tokens: 5 } }),
    });
    const r = await new AnthropicProvider(KEY, doFetch).complete(REQ, signal());
    expect(r).toEqual({ kind: 'ok', text: 'Hello world', usage: { input_tokens: 12, output_tokens: 5 }, workspaceId: 'wrkspc_abc', requestId: 'req_9' });
  });

  it('treats an unreadable success body as unknown (it may have been billed)', async () => {
    const r = await new AnthropicProvider(KEY, fakeFetch({ status: 200, body: '<html>' }).doFetch).complete(REQ, signal());
    expect(r.kind).toBe('unknown');
  });

  it('parseUsage accepts real shapes and rejects anything unsafe', () => {
    expect(parseUsage({ input_tokens: 3, output_tokens: 4 })).toEqual({ inputTokens: 3, outputTokens: 4, cacheWriteTokens: 0, cacheReadTokens: 0, webSearches: 0 });
    expect(parseUsage({ input_tokens: 3, output_tokens: 4, cache_creation_input_tokens: 5, cache_read_input_tokens: 6, server_tool_use: { web_search_requests: 2 } })).toEqual({ inputTokens: 3, outputTokens: 4, cacheWriteTokens: 5, cacheReadTokens: 6, webSearches: 2 });
    for (const bad of [null, undefined, 5, 'x', {}, { input_tokens: 1 }, { output_tokens: 1 }, { input_tokens: -1, output_tokens: 1 }, { input_tokens: 1, output_tokens: 1.2 }, { input_tokens: 1, output_tokens: 1, server_tool_use: 'many' }, { input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: -1 } }, { input_tokens: Infinity, output_tokens: 1 }]) {
      expect(parseUsage(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe('failures are classified for money, not for convenience', () => {
  it('the documented spend-cap 429 is a definite refusal that pauses AI', () => {
    expect(classifyError(429, SPEND_CAP_429, KEY)).toMatchObject({ kind: 'rejected', status: 429, limit: 'spend-limit' });
  });

  it('your own spend limit (400) is a definite refusal that pauses AI', () => {
    expect(classifyError(400, OWN_LIMIT_400, KEY)).toMatchObject({ kind: 'rejected', limit: 'spend-limit' });
  });

  it('an empty credit balance is a definite refusal that pauses AI until you lift it', () => {
    expect(classifyError(400, NO_CREDIT_400, KEY)).toMatchObject({ kind: 'rejected', limit: 'credits' });
  });

  it('ordinary client errors and rate limits are refusals without a pause reason', () => {
    for (const [status, type] of [[400, 'invalid_request_error'], [401, 'authentication_error'], [403, 'permission_error'], [404, 'not_found_error'], [413, 'request_too_large'], [429, 'rate_limit_error']] as const) {
      const r = classifyError(status, JSON.stringify({ type: 'error', error: { type, message: 'nope' } }), KEY);
      expect(r, String(status)).toMatchObject({ kind: 'rejected', status });
      expect(r).not.toHaveProperty('limit');
    }
  });

  it('server errors, overload, odd statuses and unreadable bodies are UNKNOWN (kept charged)', () => {
    for (const status of [500, 502, 503, 504, 529]) expect(classifyError(status, JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }), KEY).kind, String(status)).toBe('unknown');
    expect(classifyError(400, 'not json', KEY).kind).toBe('unknown');
    expect(classifyError(400, JSON.stringify({ hello: 'world' }), KEY).kind).toBe('unknown');
    expect(classifyError(418, JSON.stringify({ type: 'error', error: { type: 'x', message: 'y' } }), KEY).kind).toBe('unknown');
    expect(classifyError(302, '', KEY).kind).toBe('unknown');
  });

  it('network failures and timeouts are unknown and never expose the key', async () => {
    const boom = new Error(`connect failed for x-api-key ${KEY}`);
    const r = await new AnthropicProvider(KEY, fakeFetch(boom).doFetch).complete(REQ, signal());
    expect(r.kind).toBe('unknown');
    expect(JSON.stringify(r)).not.toContain(KEY);
    const ctl = new AbortController();
    ctl.abort();
    const t = await new AnthropicProvider(KEY, fakeFetch(new Error('aborted')).doFetch).complete(REQ, ctl.signal);
    expect(t).toMatchObject({ kind: 'unknown', message: expect.stringContaining('timed out') });
  });

  it('removes the key from any error text the API sends back', () => {
    const r = classifyError(401, JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key: ${KEY}` } }), KEY);
    expect(r).toMatchObject({ kind: 'rejected' });
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(JSON.stringify(r)).toContain('[key]');
  });
});
