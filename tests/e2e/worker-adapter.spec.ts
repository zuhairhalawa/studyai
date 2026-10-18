import { readFileSync } from 'node:fs';
import { ORIGINS } from './ports';
import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * The REAL Gemini adapter running inside workerd (real fetch, real HTTP), talking to a local stub of Google's endpoint instead
 * of Google. The other worker tests use a scripted fake that never calls fetch, so they cannot notice options the Workers
 * runtime rejects. This file exists because the first live request failed exactly that way (redirect: 'error' is not
 * implemented in Workers). Serial, and it leaves the owner's state clean for the next file.
 */
test.describe.configure({ mode: 'serial' });

const ORIGIN = ORIGINS.worker;
const STUB = ORIGINS.stub;
const ownerKey = () => readFileSync('.scratch/e2e-owner-key.txt', 'utf8').trim();
const tutorBody = (question: string) => ({ task: 'tutor', mode: 'explain', question, excerpts: [{ ref: 'S1', lectureTitle: 'Lecture 4', slide: 2, title: 'Turing machines', text: 'A Turing machine has an infinite tape.' }], history: [] });

let cookie = '';
const api = (request: APIRequestContext) => ({
  post: (path: string, data: unknown) => request.post(path, { headers: { cookie, origin: ORIGIN }, data }),
  get: (path: string) => request.get(path, { headers: { cookie } }),
});

test.beforeAll(async ({ playwright }) => {
  const ctx = await playwright.request.newContext({ baseURL: ORIGIN });
  expect((await ctx.post('/api/test/reset-ledger')).status()).toBe(200);
  expect((await ctx.post('/api/test/provider', { data: { stub: true } })).status()).toBe(200);
  const login = await ctx.post('/api/auth/login', { headers: { origin: ORIGIN, 'cf-connecting-ip': `198.51.100.${20 + Math.floor(Math.random() * 200)}` }, data: { key: ownerKey() } });
  cookie = login.headers()['set-cookie']!.split(';')[0]!;
  const o = api(ctx);
  for (const name of ['projectHasNoBilling', 'modelsFreeOfCharge', 'acceptsFreeTierDataUse', 'observedFreeLimits', 'firstRequestApproved']) await o.post('/api/owner/revoke', { name });
  await o.post('/api/owner/reset-pause', {});
  await o.post('/api/owner/config', { models: ['gemini-3.1-flash-lite'], budgets: { dailyUsd: 0.5, monthlyUsd: 3 }, limits: { maxConcurrent: 2, maxInputTokens: 60_000, maxRequestsPerDay: 100, maxOutputTokens: 4_000 } });
  for (const name of ['projectHasNoBilling', 'modelsFreeOfCharge', 'acceptsFreeTierDataUse']) expect((await o.post('/api/owner/attest', { name, acknowledged: true })).status()).toBe(200);
  expect((await o.post('/api/owner/attest', { name: 'observedFreeLimits', acknowledged: true, requestsPerDay: 500, requestsPerMinute: 15, tokensPerMinute: 250_000 })).status()).toBe(200);
  expect((await o.post('/api/owner/attest', { name: 'firstRequestApproved', acknowledged: true })).status()).toBe(200);
  expect((await o.post('/api/owner/config', { enabled: true })).status()).toBe(200);
  await ctx.dispose();
});

test.afterAll(async ({ playwright }) => {
  const ctx = await playwright.request.newContext({ baseURL: ORIGIN });
  const o = api(ctx);
  for (const name of ['projectHasNoBilling', 'modelsFreeOfCharge', 'acceptsFreeTierDataUse', 'observedFreeLimits', 'firstRequestApproved']) await o.post('/api/owner/revoke', { name });
  await ctx.post('/api/test/provider', { data: { stub: false } });
  await ctx.post('/api/test/reset-ledger');
  await ctx.dispose();
});

test('the real adapter sends the right request from inside workerd and reads the answer', async ({ request }) => {
  await request.post(`${STUB}/__clear`);
  const r = await api(request).post('/api/ai/ask', tutorBody('What is a tape?'));
  expect(r.status(), await r.text()).toBe(200);
  const reply = await r.json();
  expect(reply).toMatchObject({ ok: true, costIsEstimate: false });
  expect(reply.text).toMatch(/unbounded memory .* \[S1\]/);
  expect(reply.text).toMatch(/BASIS: lecture/);
  expect(reply.shadowCostUsd).toBeGreaterThan(0); // priced from the usage Google reported (120 in, 25 out)

  const log = (await (await request.get(`${STUB}/__log`)).json()) as { method: string; url: string; key: string | null; contentType: string | null; body: string }[];
  expect(log).toHaveLength(1);
  const sent = log[0]!;
  expect(sent.method).toBe('POST');
  expect(sent.url).toBe('/v1beta/models/gemini-3.1-flash-lite:generateContent'); // one fixed path; the key is never in the URL
  expect(sent.key).toBe('stub-key-for-local-tests'); // the secret travels only in this header
  expect(sent.contentType).toBe('application/json');
  const body = JSON.parse(sent.body) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(['contents', 'generationConfig', 'systemInstruction']); // an allowlist: no tools, no cached content, no labels
  expect(sent.body).not.toContain('stub-key-for-local-tests');
  expect(sent.body).toContain('What is a tape?');
  expect((body['generationConfig'] as Record<string, unknown>)['candidateCount']).toBe(1);
});

test('a redirect from the far end is not followed and the call stays charged as unclear', async ({ request }) => {
  await request.post(`${STUB}/__clear`);
  const before = (await (await api(request).get('/api/owner/status')).json()).spentDayUsd as number;
  const r = await api(request).post('/api/ai/ask', tutorBody('STUB-REDIRECT please'));
  expect(r.status()).toBe(502);
  expect(await r.json()).toMatchObject({ ok: false, code: 'outcome-unknown' });
  const log = (await (await request.get(`${STUB}/__log`)).json()) as { url: string }[];
  expect(log.map((l) => l.url)).toEqual(['/v1beta/models/gemini-3.1-flash-lite:generateContent']); // the redirect target was never requested
  const s = await (await api(request).get('/api/owner/status')).json();
  expect(s.unresolved).toHaveLength(1);
  expect(s.spentDayUsd).toBeGreaterThan(before + 0.001); // the full reservation, until the owner reconciles it
  expect((await api(request).post('/api/owner/reconcile', { id: s.unresolved[0].id, usd: 0 })).status()).toBe(200);
});
