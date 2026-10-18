import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AI_CONFIG } from '../src/core/ai/config';
import { buildGeminiBody, classifyGeminiError, GeminiProvider, geminiUrl, normaliseGeminiUsage } from '../src/core/ai/gemini';
import { DEFAULT_GEMINI_CONFIG, GEMINI_CEILINGS, GEMINI_PRICE_TABLE, geminiGate, type GeminiConfig } from '../src/core/ai/gemini-config';
import { nextPacificMidnight } from '../src/core/ai/time';
import type { ProviderOutcome } from '../src/core/ai/provider';
import { attestedConfig, deferred, FakeProvider, NOW, setup } from './ai-helpers';

const DAY = 86_400_000;
// Built from pieces so no key-shaped literal sits in the repository (secret scanners rightly flag those).
const KEY = ['AI', 'za', 'SyFAKEFAKEFAKEFAKE', '-test-key-0123456789'].join('');
afterEach(() => vi.useRealTimers());

function geminiConfig(over: Omit<Partial<GeminiConfig>, 'budgets' | 'limits'> & { budgets?: Partial<GeminiConfig['budgets']>; limits?: Partial<GeminiConfig['limits']> } = {}): GeminiConfig {
  const a = { confirmedAt: '2026-10-15', by: 'owner' as const };
  return {
    ...DEFAULT_GEMINI_CONFIG,
    enabled: true,
    models: ['gemini-2.5-flash-lite'],
    // generous test limits so the arithmetic below stays simple
    attestations: { projectHasNoBilling: a, modelsFreeOfCharge: a, acceptsFreeTierDataUse: a, firstRequestApproved: a, observedFreeLimits: { ...a, requestsPerDay: 1000, requestsPerMinute: 15, tokensPerMinute: 250_000 } },
    ...over,
    budgets: { ...DEFAULT_GEMINI_CONFIG.budgets, ...over.budgets },
    limits: { ...DEFAULT_GEMINI_CONFIG.limits, maxInputTokens: 20_000, maxOutputTokens: 1_500, maxRequestsPerDay: 50, maxRequestsPerMonth: 500, requestTimeoutMs: 30_000, ...over.limits },
  };
}

const GREQ = { model: 'gemini-2.5-flash-lite', purpose: 'tutor', messages: [{ role: 'user' as const, content: 'hi' }], maxOutputTokens: 100 };
const GRESERVE = 60_250; // ((82 × 100) + (100 × 400)) × 5/4
const GACTUAL = 20 * 100 + 30 * 400; // 14 000
const gok = (usage: unknown = { input_tokens: 20, output_tokens: 30 }, extra: Partial<Extract<ProviderOutcome, { kind: 'ok' }>> = {}): ProviderOutcome => ({ kind: 'ok', text: 'an answer', usage, requestId: 'resp_1', ...extra });
const gsetup = (o: Parameters<typeof setup>[0] & { cfg?: unknown } = {}) => setup({ ...o, gate: geminiGate(o.cfg ?? geminiConfig()), provider: o.provider ?? new FakeProvider(() => gok()) });

describe('a cut-off answer through the guard', () => {
  it('hands the flag to the caller, charges the real usage, and leaves it out for a finished answer', async () => {
    const cut = gsetup({ provider: new FakeProvider(() => gok(undefined, { truncated: true })) });
    expect(await cut.ai.ask(GREQ)).toMatchObject({ ok: true, truncated: true, costNanos: GACTUAL });
    const whole = gsetup();
    expect(await whole.ai.ask(GREQ)).not.toHaveProperty('truncated');
  });
});

describe('the Gemini gate', () => {
  const day = DAY;
  it('ships switched off with nothing confirmed', () => {
    const g = geminiGate(DEFAULT_GEMINI_CONFIG)(NOW);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reasons.length).toBeGreaterThanOrEqual(5);
  });

  it('opens only with every confirmation, fresh and consistent', () => {
    expect(geminiGate(geminiConfig())(NOW).ok).toBe(true);
    for (const key of ['projectHasNoBilling', 'modelsFreeOfCharge', 'acceptsFreeTierDataUse', 'firstRequestApproved', 'observedFreeLimits'] as const) {
      const c = geminiConfig();
      delete c.attestations[key];
      expect(geminiGate(c)(NOW).ok, key).toBe(false);
    }
    expect(geminiGate(geminiConfig({ enabled: false }))(NOW).ok).toBe(false);
    expect(geminiGate(geminiConfig())(NOW + 40 * day).ok).toBe(false); // stale
    expect(geminiGate(geminiConfig())(NOW - 10 * day).ok).toBe(false); // from the future
  });

  it('keeps the app’s own limits below the free quotas the owner entered', () => {
    expect(geminiGate(geminiConfig({ limits: { maxRequestsPerDay: 500 } }))(NOW).ok).toBe(true);
    expect(geminiGate(geminiConfig({ limits: { maxRequestsPerDay: 501, maxRequestsPerMonth: 5000 } }))(NOW).ok).toBe(false); // more than half of 1000
    expect(geminiGate(geminiConfig({ limits: { maxInputTokens: 70_000, maxConcurrent: 2 } }))(NOW).ok).toBe(false); // 70k × 2 × 2 > 250k
  });

  it('caps the shadow budget so a wrongly linked billing account could never cost more than a few dollars', () => {
    expect(geminiGate(geminiConfig({ budgets: { dailyUsd: GEMINI_CEILINGS.dailyUsd, monthlyUsd: GEMINI_CEILINGS.monthlyUsd } }))(NOW).ok).toBe(true);
    expect(geminiGate(geminiConfig({ budgets: { dailyUsd: 2, monthlyUsd: 5 } }))(NOW).ok).toBe(false);
    expect(geminiGate(geminiConfig({ budgets: { dailyUsd: 1, monthlyUsd: 6 } }))(NOW).ok).toBe(false);
    expect(geminiGate(geminiConfig({ budgets: { dailyUsd: 0.5, monthlyUsd: 0.1 } }))(NOW).ok).toBe(false);
  });

  it('allows only models with a known free tier and price, and rejects other providers’ settings', () => {
    expect(geminiGate(geminiConfig({ models: ['gemini-3.1-pro-preview'] }))(NOW).ok).toBe(false); // no free tier
    expect(geminiGate(geminiConfig({ models: ['gemini-2.5-flash-lite', 'made-up'] }))(NOW).ok).toBe(false);
    expect(geminiGate(DEFAULT_AI_CONFIG)(NOW).ok).toBe(false);
    expect(geminiGate(attestedConfig())(NOW).ok).toBe(false);
    expect(geminiGate(null)(NOW).ok).toBe(false);
    expect(geminiGate({ ...geminiConfig(), extra: 1 })(NOW).ok).toBe(false);
    for (const m of Object.keys(GEMINI_PRICE_TABLE)) expect(geminiGate(geminiConfig({ models: [m] }))(NOW).ok, m).toBe(true);
  });
});

type Reply = { status: number; headers?: Record<string, string>; body: string };
function fakeFetch(reply: Reply | Error) {
  const seen: { url: string; init: { method: string; headers: Record<string, string>; body: string; redirect: 'manual' } }[] = [];
  const doFetch = async (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'manual' }) => {
    seen.push({ url, init });
    if (reply instanceof Error) throw reply;
    return { status: reply.status, headers: { get: (n: string) => reply.headers?.[n.toLowerCase()] ?? null }, text: async () => reply.body };
  };
  return { doFetch, seen };
}
const REQ = { model: 'gemini-2.5-flash-lite', maxOutputTokens: 100, messages: [{ role: 'user' as const, content: 'hi' }] };
const signal = () => new AbortController().signal;
const err = (status: number, message: string, details?: unknown, code = status) => JSON.stringify({ error: { code, message, status: 'X', ...(details ? { details } : {}) } });

describe('the Gemini adapter', () => {
  it('talks to one fixed host, with the key in a header and never in the URL or body', async () => {
    const { doFetch, seen } = fakeFetch({ status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } }) });
    await new GeminiProvider(KEY, doFetch).complete({ ...REQ, system: 'be brief', temperature: 0.2 }, signal());
    expect(seen[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent');
    expect(seen[0]!.init.headers).toEqual({ 'content-type': 'application/json', 'x-goog-api-key': KEY });
    expect(seen[0]!.init.redirect).toBe('manual'); // a redirect is never followed: it would carry the key header to another host
    expect(seen[0]!.url).not.toContain(KEY);
    expect(seen[0]!.url).not.toContain('key=');
    expect(seen[0]!.init.body).not.toContain(KEY);
  });

  it('sends only plain text and an output cap — nothing that can add a charge', () => {
    const body = buildGeminiBody({ ...REQ, system: 's', temperature: 0.3, messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'q2' }] });
    expect(Object.keys(body).sort()).toEqual(['contents', 'generationConfig', 'systemInstruction']);
    expect(body['generationConfig']).toEqual({ maxOutputTokens: 100, candidateCount: 1, temperature: 0.3 });
    expect((body['contents'] as { role: string }[]).map((c) => c.role)).toEqual(['user', 'model', 'user']);
    for (const k of ['tools', 'toolConfig', 'cachedContent', 'serviceTier', 'store', 'labels', 'safetySettings', 'continuationToken']) expect(body, k).not.toHaveProperty(k);
    expect(Object.keys(buildGeminiBody(REQ)).sort()).toEqual(['contents', 'generationConfig']);
  });

  it('refuses a model name that could alter the URL, without sending anything', async () => {
    for (const bad of ['../x', 'a b', 'models/x', 'Gemini', 'x?key=1', '', 'a:b']) {
      const { doFetch, seen } = fakeFetch({ status: 200, body: '{}' });
      const r = await new GeminiProvider(KEY, doFetch).complete({ ...REQ, model: bad }, signal());
      expect(r.kind, bad).toBe('rejected');
      expect(seen, bad).toHaveLength(0);
    }
    expect(() => geminiUrl('gemini-2.5-flash')).not.toThrow();
  });

  it('needs a key', () => {
    expect(() => new GeminiProvider('', fakeFetch({ status: 200, body: '' }).doFetch)).toThrow();
  });

  it('returns visible text only (not thought parts) and maps usage, counting thinking as output', async () => {
    const body = JSON.stringify({
      responseId: 'resp_9',
      candidates: [{ content: { parts: [{ text: 'secret reasoning', thought: true }, { text: 'Hello ' }, { text: 'world' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 40, candidatesTokenCount: 20, thoughtsTokenCount: 30, totalTokenCount: 150 },
    });
    const r = await new GeminiProvider(KEY, fakeFetch({ status: 200, body }).doFetch).complete(REQ, signal());
    expect(r).toEqual({ kind: 'ok', text: 'Hello world', usage: { input_tokens: 60, cache_read_input_tokens: 40, output_tokens: 50 }, requestId: 'resp_9' });
  });

  it('says so when the model stopped at the output cap, because the text is then cut off', async () => {
    const answer = (finishReason: string) =>
      JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"cards": [{"front": "a"' }] }, finishReason }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4000 } });
    const cut = await new GeminiProvider(KEY, fakeFetch({ status: 200, body: answer('MAX_TOKENS') }).doFetch).complete(REQ, signal());
    expect(cut).toMatchObject({ kind: 'ok', truncated: true });
    for (const reason of ['STOP', 'SAFETY', 'OTHER']) {
      const whole = await new GeminiProvider(KEY, fakeFetch({ status: 200, body: answer(reason) }).doFetch).complete(REQ, signal());
      expect(whole, reason).not.toHaveProperty('truncated');
    }
  });

  it('normalises usage strictly: anything missing or inconsistent becomes "unknown cost"', () => {
    expect(normaliseGeminiUsage({ promptTokenCount: 10 })).toEqual({ input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 0 });
    expect(normaliseGeminiUsage({ promptTokenCount: 10, toolUsePromptTokenCount: 5, candidatesTokenCount: 2 })).toEqual({ input_tokens: 15, cache_read_input_tokens: 0, output_tokens: 2 });
    for (const bad of [undefined, null, 5, {}, { candidatesTokenCount: 3 }, { promptTokenCount: -1 }, { promptTokenCount: 1.5 }, { promptTokenCount: 10, cachedContentTokenCount: 11 }, { promptTokenCount: 10, thoughtsTokenCount: 'x' }, { promptTokenCount: 10, candidatesTokenCount: NaN }]) {
      expect(normaliseGeminiUsage(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('bills tokens that the total reports but no field explains as output, and distrusts a garbage total', () => {
    const base = { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30 };
    expect(normaliseGeminiUsage({ ...base, totalTokenCount: 150 })).toEqual({ input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 50 });
    expect(normaliseGeminiUsage({ ...base, totalTokenCount: 400 })).toEqual({ input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 300 }); // 250 unexplained tokens
    expect(normaliseGeminiUsage({ ...base, toolUsePromptTokenCount: 10, totalTokenCount: 160 })).toEqual({ input_tokens: 110, cache_read_input_tokens: 0, output_tokens: 50 });
    expect(normaliseGeminiUsage({ ...base, totalTokenCount: 10 })).toEqual({ input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 50 }); // a low total never lowers the bill
    expect(normaliseGeminiUsage({ ...base, totalTokenCount: null })).toEqual({ input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 50 });
    for (const bad of ['150', -1, 1.5, NaN, {}]) expect(normaliseGeminiUsage({ ...base, totalTokenCount: bad }), String(bad)).toBeUndefined();
  });

  it('never follows a redirect: it counts as an unclear answer and nothing is retried', async () => {
    const { doFetch, seen } = fakeFetch({ status: 302, headers: { location: 'https://evil.example/steal' }, body: '' });
    const r = await new GeminiProvider(KEY, doFetch).complete(REQ, signal());
    expect(r).toMatchObject({ kind: 'unknown', message: expect.stringContaining('redirect') });
    expect(seen).toHaveLength(1);
  });

  it('flags a grounding/search result, which must never occur, and prices it at the dearest search rate', async () => {
    const body = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'x' }] }, groundingMetadata: { webSearchQueries: ['a', 'b'] } }], usageMetadata: { promptTokenCount: 5 } });
    const r = await new GeminiProvider(KEY, fakeFetch({ status: 200, body }).doFetch).complete(REQ, signal());
    expect(r).toMatchObject({ kind: 'ok', extraCostNanos: 70_000_000, anomaly: expect.stringContaining('grounding') });
  });

  it('treats an unreadable success body, a network error and a timeout as unknown, never exposing the key', async () => {
    expect((await new GeminiProvider(KEY, fakeFetch({ status: 200, body: '<html>' }).doFetch).complete(REQ, signal())).kind).toBe('unknown');
    const net = await new GeminiProvider(KEY, fakeFetch(new Error(`connect failed ${KEY}`)).doFetch).complete(REQ, signal());
    expect(net.kind).toBe('unknown');
    expect(JSON.stringify(net)).not.toContain(KEY);
    const ctl = new AbortController();
    ctl.abort();
    expect(await new GeminiProvider(KEY, fakeFetch(new Error('aborted')).doFetch).complete(REQ, ctl.signal)).toMatchObject({ kind: 'unknown', message: expect.stringContaining('timed out') });
  });
});

describe('Gemini errors are classified for money, not convenience', () => {
  it('an ordinary quota error mentions "billing details" but is NOT a billing signal', () => {
    const ordinary = err(429, 'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.');
    expect(classifyGeminiError(429, ordinary, KEY)).toMatchObject({ kind: 'rejected', limit: 'quota-minute' });
  });

  it('daily quota violations pause until Pacific midnight', () => {
    const daily = err(429, 'You exceeded your current quota.', [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }]);
    expect(classifyGeminiError(429, daily, KEY)).toMatchObject({ kind: 'rejected', limit: 'quota-day' });
    expect(classifyGeminiError(429, err(429, 'Quota exceeded for metric: requests per day'), KEY)).toMatchObject({ limit: 'quota-day' });
  });

  it('anything about prepay, payment or a depleted balance means a billing account may be linked', () => {
    expect(classifyGeminiError(402, 'whatever', KEY)).toMatchObject({ kind: 'rejected', limit: 'billing-signal' });
    expect(classifyGeminiError(400, err(400, 'Prepay credits are depleted. Add funds to continue.'), KEY)).toMatchObject({ limit: 'billing-signal' });
    expect(classifyGeminiError(429, err(429, 'Your prepay balance is depleted'), KEY)).toMatchObject({ limit: 'billing-signal' });
    expect(classifyGeminiError(400, err(400, 'Billing account is not active'), KEY)).toMatchObject({ limit: 'billing-signal' });
  });

  it('"free tier not available" is its own state and must never be "fixed" by enabling billing', () => {
    expect(classifyGeminiError(400, err(400, 'User location is not supported for the API use without a billing account linked. The free tier is not available in your country; please enable billing on your project.'), KEY)).toMatchObject({ kind: 'rejected', limit: 'no-free-tier' });
  });

  it('ordinary client errors are plain refusals', () => {
    for (const [status, msg] of [[400, 'Invalid JSON payload received'], [401, 'API key not valid'], [403, 'Your API key was reported as leaked. Please use another API key.'], [404, 'models/x is not found']] as const) {
      const r = classifyGeminiError(status, err(status, msg), KEY);
      expect(r, String(status)).toMatchObject({ kind: 'rejected', status });
      expect(r).not.toHaveProperty('limit');
    }
  });

  it('server errors, odd statuses and unreadable bodies are UNKNOWN (kept charged)', () => {
    for (const status of [500, 502, 503, 504]) expect(classifyGeminiError(status, err(status, 'overloaded'), KEY).kind, String(status)).toBe('unknown');
    expect(classifyGeminiError(400, 'not json', KEY).kind).toBe('unknown');
    expect(classifyGeminiError(429, JSON.stringify({ hello: 1 }), KEY).kind).toBe('unknown');
    expect(classifyGeminiError(418, err(418, 'teapot'), KEY).kind).toBe('unknown');
    expect(classifyGeminiError(302, '', KEY).kind).toBe('unknown');
  });

  it('removes the key from any text Google sends back', () => {
    const r = classifyGeminiError(400, err(400, `API key not valid: ${KEY}`), KEY);
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(JSON.stringify(r)).toContain('[key]');
  });
});

describe('the guard with the Gemini policy (fake provider only)', () => {
  it('prices at the paid-tier rate as a shadow cost and logs it per request', async () => {
    const { ai, store } = gsetup();
    const r = await ai.ask(GREQ);
    expect(r).toMatchObject({ ok: true, costNanos: GACTUAL, costIsEstimate: false, requestId: 'resp_1' });
    const l = await store.read(NOW);
    expect(l.spentDay).toBe(GACTUAL);
    expect(l.log[0]).toMatchObject({ model: 'gemini-2.5-flash-lite', outcome: 'ok', costNanos: GACTUAL, reservedNanos: GRESERVE });
  });

  it('is off until the gate opens, and goes off again when a confirmation goes stale', async () => {
    const off = gsetup({ cfg: DEFAULT_GEMINI_CONFIG });
    expect(await off.ai.ask(GREQ)).toMatchObject({ ok: false, code: 'disabled' });
    expect(off.provider.calls).toBe(0);
    const { ai, clock, provider } = gsetup();
    expect((await ai.ask(GREQ)).ok).toBe(true);
    clock.t = NOW + 40 * DAY;
    expect(await ai.ask(GREQ)).toMatchObject({ ok: false, code: 'disabled' });
    expect(provider.calls).toBe(1);
  });

  it('a tiny shadow budget runs out: exactly as many calls as fit, then a refusal', async () => {
    // $0.0002 a day = 200 000 nano-dollars. After n calls: 14 000·n + 60 250 ≤ 200 000 → n ≤ 9 → 10 calls fit.
    const { ai, provider } = gsetup({ cfg: geminiConfig({ budgets: { dailyUsd: 0.0002, monthlyUsd: 1 } }) });
    let n = 0;
    while ((await ai.ask(GREQ)).ok) n += 1;
    expect(n).toBe(10);
    expect(provider.calls).toBe(10);
    expect(await ai.ask(GREQ)).toMatchObject({ ok: false, code: 'budget-day' });
    expect(provider.calls).toBe(10);
  });

  it('the allowlist keeps tools and unknown models out before anything is reserved', async () => {
    const { ai, provider } = gsetup();
    expect(await ai.ask({ ...GREQ, tools: [{ googleSearch: {} }] })).toMatchObject({ code: 'invalid-request' });
    expect(await ai.ask({ ...GREQ, model: 'gemini-3.8-flash' })).toMatchObject({ code: 'model-not-allowed' });
    expect(await ai.ask({ ...GREQ, maxOutputTokens: 5_000 })).toMatchObject({ code: 'too-large' });
    expect(provider.calls).toBe(0);
  });

  it('the daily free quota being used up pauses AI until Pacific midnight, then resumes', async () => {
    const provider = new FakeProvider(() => ({ kind: 'rejected', status: 429, message: 'quota', limit: 'quota-day' }));
    const { ai, clock, store } = gsetup({ provider });
    expect(await ai.ask(GREQ)).toMatchObject({ ok: false, code: 'provider-rejected' });
    expect((await store.read(NOW)).spentDay).toBe(0); // refused before the model ran
    clock.t = NOW + 3_600_000;
    expect(await ai.ask(GREQ)).toMatchObject({ ok: false, code: 'provider-limit' });
    expect(provider.calls).toBe(1);
    expect((await ai.status()).reasons.join(' ')).toMatch(/Pacific/);
    // 2026-10-17 07:00 UTC is midnight Pacific (PDT)
    clock.t = Date.UTC(2026, 9, 17, 6, 59, 0);
    expect(await ai.ask(GREQ)).toMatchObject({ code: 'provider-limit' });
    clock.t = Date.UTC(2026, 9, 17, 7, 0, 1);
    provider.behavior = () => gok();
    expect((await ai.ask(GREQ)).ok).toBe(true);
  });

  it('a per-minute limit pauses for a minute only', async () => {
    const provider = new FakeProvider(() => ({ kind: 'rejected', status: 429, message: 'rpm', limit: 'quota-minute' }));
    const { ai, clock } = gsetup({ provider });
    await ai.ask(GREQ);
    clock.t = NOW + 30_000;
    expect(await ai.ask(GREQ)).toMatchObject({ code: 'provider-limit' });
    clock.t = NOW + 61_000;
    provider.behavior = () => gok();
    expect((await ai.ask(GREQ)).ok).toBe(true);
    expect(provider.calls).toBe(2);
  });

  it('a billing signal (402, prepay, depleted) pauses AI until you check AI Studio — even a week later', async () => {
    for (const limit of ['billing-signal', 'no-free-tier'] as const) {
      const provider = new FakeProvider(() => ({ kind: 'rejected', status: 402, message: 'payment', limit }));
      const { ai, clock } = gsetup({ provider });
      await ai.ask(GREQ);
      clock.t = NOW + 7 * DAY;
      expect(await ai.ask(GREQ), limit).toMatchObject({ ok: false, code: 'breaker' });
      expect(provider.calls).toBe(1);
      expect((await ai.status()).state).toBe('paused');
      await ai.resetPause();
      provider.behavior = () => gok();
      expect((await ai.ask(GREQ)).ok).toBe(true);
    }
  });

  it('server errors stay charged as shadow cost; five in a row pause AI', async () => {
    const provider = new FakeProvider(() => ({ kind: 'unknown', message: 'The API answered with status 503.' }));
    const { ai, store } = gsetup({ provider });
    for (let i = 0; i < 5; i++) expect(await ai.ask(GREQ)).toMatchObject({ code: 'outcome-unknown' });
    expect((await store.read(NOW)).spentDay).toBe(5 * GRESERVE);
    expect(await ai.ask(GREQ)).toMatchObject({ ok: false, code: 'breaker' });
    expect(provider.calls).toBe(5);
  });

  it('a result that came with grounding is delivered, charged including the search, and pauses AI', async () => {
    const provider = new FakeProvider(() => gok(undefined, { usage: { input_tokens: 20, output_tokens: 30 }, extraCostNanos: 35_000_000, anomaly: 'grounding came back' }));
    const { ai, store } = gsetup({ provider, cfg: geminiConfig({ budgets: { dailyUsd: 1, monthlyUsd: 5 } }) });
    const r = await ai.ask(GREQ);
    expect(r).toMatchObject({ ok: true, costNanos: GACTUAL + 35_000_000 });
    expect((await store.read(NOW)).log[0]).toMatchObject({ outcome: 'overrun' }); // cost above its reservation
    expect(await ai.ask(GREQ)).toMatchObject({ ok: false, code: 'breaker' });
  });

  it('thinking tokens are billed as output: a burst of them above the cap trips the overrun breaker', async () => {
    const provider = new FakeProvider(() => gok({ input_tokens: 20, output_tokens: 5_000 }));
    const { ai } = gsetup({ provider });
    expect((await ai.ask(GREQ)).ok).toBe(true);
    expect(await ai.ask(GREQ)).toMatchObject({ ok: false, code: 'breaker' });
  });

  it('missing usage is charged at the full reservation', async () => {
    const provider = new FakeProvider(() => gok(undefined, { usage: undefined }));
    const { ai, store } = gsetup({ provider });
    expect(await ai.ask(GREQ)).toMatchObject({ ok: true, costIsEstimate: true, costNanos: GRESERVE });
    expect((await store.read(NOW)).spentDay).toBe(GRESERVE);
  });

  it('concurrent calls cannot overspend the shadow budget', async () => {
    const gate = deferred<void>();
    const provider = new FakeProvider(async () => {
      await gate.promise;
      return gok();
    });
    // room for exactly two reservations: 2 × 60 250 = 120 500 ≤ 125 000 < 3 × 60 250
    const { ai } = gsetup({ provider, cfg: geminiConfig({ budgets: { dailyUsd: 0.000125, monthlyUsd: 1 }, limits: { maxConcurrent: 4 } }) });
    const all = Array.from({ length: 8 }, () => ai.ask(GREQ));
    await vi.waitFor(() => expect(provider.calls).toBe(2));
    gate.resolve();
    const results = await Promise.all(all);
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(provider.calls).toBe(2);
  });
});

describe('Pacific midnight (when Google resets the daily quota)', () => {
  it('is 07:00 UTC in summer time and 08:00 UTC in winter time', () => {
    expect(nextPacificMidnight(Date.UTC(2026, 9, 16, 12, 0, 0))).toBe(Date.UTC(2026, 9, 17, 7, 0, 0)); // PDT
    expect(nextPacificMidnight(Date.UTC(2026, 11, 20, 12, 0, 0))).toBe(Date.UTC(2026, 11, 21, 8, 0, 0)); // PST
  });

  it('is strictly after the given instant, including exactly at midnight', () => {
    const midnight = Date.UTC(2026, 9, 17, 7, 0, 0);
    expect(nextPacificMidnight(midnight)).toBe(Date.UTC(2026, 9, 18, 7, 0, 0));
    expect(nextPacificMidnight(midnight - 1)).toBe(midnight);
    expect(nextPacificMidnight(Date.UTC(2026, 9, 16, 12, 0, 0, 500))).toBe(Date.UTC(2026, 9, 17, 7, 0, 0));
  });

  it('handles the daylight-saving changes (23- and 25-hour days)', () => {
    // clocks go back on 2026-11-01: that Pacific day lasts 25 hours
    expect(nextPacificMidnight(Date.UTC(2026, 9, 31, 20, 0, 0))).toBe(Date.UTC(2026, 10, 1, 7, 0, 0));
    expect(nextPacificMidnight(Date.UTC(2026, 10, 1, 8, 0, 0))).toBe(Date.UTC(2026, 10, 2, 8, 0, 0));
    expect(nextPacificMidnight(Date.UTC(2026, 10, 1, 12, 0, 0))).toBe(Date.UTC(2026, 10, 2, 8, 0, 0));
    // clocks go forward on 2026-03-08: that day lasts 23 hours
    expect(nextPacificMidnight(Date.UTC(2026, 2, 7, 20, 0, 0))).toBe(Date.UTC(2026, 2, 8, 8, 0, 0));
    expect(nextPacificMidnight(Date.UTC(2026, 2, 8, 9, 0, 0))).toBe(Date.UTC(2026, 2, 9, 7, 0, 0));
  });

  it('refuses a nonsense time', () => {
    expect(() => nextPacificMidnight(NaN)).toThrow();
  });
});
