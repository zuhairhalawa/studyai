import { AiTaskSchema, ATTEST_NAMES, type AiReply, type AiTask, type OwnerStatus } from '../../src/core/tutor/contract';
import { gateHeaders, gatePage, type GateMessage } from './gate';
import { clearCookie, COOKIE_NAME, hostAllowed, originAllowed, parseCookies, secretIsUsable, SESSION_MAX_AGE_S, sessionCookie, signSession, verifyOwnerKey, verifySession } from './auth';

/**
 * Request handling for /api/*, free of any Cloudflare runtime import so it can be tested in Node with a fake backend.
 * The Durable Object (do.ts) implements `Backend`; everything stateful and everything that can spend lives there.
 */

export type Ok = { ok: true };
export type Err = { ok: false; error: string };

export interface Backend {
  /** Counts one wrong key from this address, atomically, and says whether that address is now locked. */
  loginFailed(ip: string): Promise<{ locked: boolean; retryAfterSec: number }>;
  /** A correct key clears that address's failures. */
  loginSucceeded(ip: string): Promise<void>;
  epoch(): Promise<number>;
  bumpEpoch(): Promise<void>;
  askTask(task: AiTask): Promise<AiReply>;
  status(): Promise<OwnerStatus>;
  setConfig(patch: unknown): Promise<Ok | Err>;
  attest(name: string, data: unknown): Promise<Ok | Err>;
  revoke(name: string): Promise<Ok | Err>;
  reconcile(id: string, usd: number): Promise<Ok | Err>;
  resetPause(): Promise<Ok>;
}

export interface AppEnv {
  backend: Backend;
  /** SHA-256 hex of the owner key (secret OWNER_KEY_HASH). */
  ownerKeyHash: string | undefined;
  /** HMAC key for session cookies (secret SESSION_SECRET, ≥ 32 characters). */
  sessionSecret: string | undefined;
  /** Hosts this site may be served on, e.g. "study.example.com". Empty = nothing is allowed. */
  allowedHosts: string[];
  now: () => number;
}

const MAX_BODY = 262_144;

const API_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'cross-origin-resource-policy': 'same-origin',
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...API_HEADERS, ...extra } });
}

const unauthorized = () => json({ error: 'unauthorized' }, 401);

/** Maps the guard's refusal codes onto honest HTTP statuses. */
export function statusForCode(code: string): number {
  switch (code) {
    case 'disabled':
      return 403;
    case 'invalid-request':
    case 'model-not-allowed':
    case 'too-large':
      return 400;
    case 'budget-day':
    case 'budget-month':
    case 'requests-day':
    case 'requests-month':
    case 'concurrency':
    case 'provider-limit':
    case 'breaker':
    case 'too-many-unresolved':
    case 'clock-backwards':
      return 429;
    case 'provider-rejected':
    case 'outcome-unknown':
      return 502;
    case 'budget-unknown':
      return 503;
    default:
      return 500;
  }
}

/** Reads the body as a stream and stops as soon as it exceeds the cap, whatever Content-Length claims (or omits). */
async function readCapped(request: Request, max = MAX_BODY): Promise<Uint8Array | undefined> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

async function readJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/json(;|$)/i.test(type)) return { ok: false, response: json({ error: 'expected-json' }, 415) };
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY) return { ok: false, response: json({ error: 'too-large' }, 413) };
  const bytes = await readCapped(request);
  if (!bytes) return { ok: false, response: json({ error: 'too-large' }, 413) };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, response: json({ error: 'invalid-json' }, 400) };
  }
}

async function isOwner(request: Request, env: AppEnv): Promise<boolean> {
  const token = parseCookies(request.headers.get('cookie'))[COOKIE_NAME];
  const session = await verifySession(env.sessionSecret, token, env.now());
  if (!session) return false;
  try {
    return session.epoch === (await env.backend.epoch());
  } catch {
    return false; // cannot confirm the session: not signed in
  }
}

type LoginAttempt = { ok: true; cookie: string } | { ok: false; status: 401 | 429 | 503; retryAfterSec: number };

/**
 * The one place a key is checked, for both the app's sign-in box (JSON) and the private-site gate (a plain form).
 * The key is checked first (cheap, constant time). A wrong key is counted atomically BEFORE any answer is given, so a burst
 * of parallel guesses cannot slip past the limit; the correct key is never refused, so nobody can lock the owner out.
 */
async function attemptLogin(request: Request, env: AppEnv, key: unknown): Promise<LoginAttempt> {
  if (!secretIsUsable(env.sessionSecret) || !env.ownerKeyHash) return { ok: false, status: 503, retryAfterSec: 0 };
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  if (!(await verifyOwnerKey(key, env.ownerKeyHash))) {
    const f = await env.backend.loginFailed(ip);
    return f.locked ? { ok: false, status: 429, retryAfterSec: f.retryAfterSec } : { ok: false, status: 401, retryAfterSec: 0 };
  }
  await env.backend.loginSucceeded(ip);
  const token = await signSession(env.sessionSecret, { v: 1, exp: env.now() + SESSION_MAX_AGE_S * 1000, epoch: await env.backend.epoch() });
  return { ok: true, cookie: sessionCookie(token) };
}

async function gateResponse(message: GateMessage, status: number, retryAfterSec = 0): Promise<Response> {
  return new Response(gatePage(message), { status, headers: { ...(await gateHeaders()), ...(retryAfterSec > 0 ? { 'retry-after': String(retryAfterSec) } : {}) } });
}

/**
 * Everything that is not /api/*, while the site is private: a visitor without a valid owner session gets only the sign-in
 * page. The cookie is checked for signature and expiry only (no storage round trip per file); the API itself checks the
 * session fully, including "sign out everywhere". The files served here contain no private data: the library lives in the
 * owner's browser. What the gate prevents is anyone else using, probing or even seeing the app.
 */
export async function handleSite(request: Request, env: AppEnv, serveAsset: (request: Request) => Promise<Response>): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD', 'cache-control': 'no-store' } });
  if (!hostAllowed(request, env.allowedHosts)) return new Response('Misdirected request', { status: 421, headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' } });
  // Browsers ask for /favicon.ico on their own; the app ships a .svg icon, so answer "nothing here" quietly instead of with an error.
  if (new URL(request.url).pathname === '/favicon.ico') return new Response(null, { status: 204, headers: { 'cache-control': 'public, max-age=86400' } });
  if (!secretIsUsable(env.sessionSecret) || !env.ownerKeyHash) return gateResponse('not-configured', 503);
  const token = parseCookies(request.headers.get('cookie'))[COOKIE_NAME];
  if (!(await verifySession(env.sessionSecret, token, env.now()))) return gateResponse(undefined, 401);
  const asset = await serveAsset(request);
  const out = new Response(asset.body, asset); // a fresh Response so headers can be added
  out.headers.set('x-robots-tag', 'noindex, nofollow');
  return out;
}

export async function handle(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();

  if (method !== 'GET' && method !== 'POST') return json({ error: 'method-not-allowed' }, 405, { allow: 'GET, POST' });
  if (path === '/api/health' && method === 'GET') return json({ service: 'studyai', ok: true });
  if (!hostAllowed(request, env.allowedHosts)) return json({ error: 'wrong-host' }, 421);
  if (method === 'POST' && !originAllowed(request, env.allowedHosts)) return json({ error: 'bad-origin' }, 403);

  try {
    // ---- authentication ---------------------------------------------------
    if (path === '/api/auth/session' && method === 'GET') {
      return json({ authenticated: await isOwner(request, env), configured: secretIsUsable(env.sessionSecret) && !!env.ownerKeyHash });
    }

    if (path === '/api/auth/login' && method === 'POST') {
      if (!secretIsUsable(env.sessionSecret) || !env.ownerKeyHash) return json({ error: 'not-configured' }, 503);
      const body = await readJson(request);
      if (!body.ok) return body.response;
      const r = await attemptLogin(request, env, (body.value as { key?: unknown } | null)?.key);
      if (r.ok) return json({ authenticated: true }, 200, { 'set-cookie': r.cookie });
      if (r.status === 429) return json({ error: 'locked', retryAfterSec: r.retryAfterSec }, 429, { 'retry-after': String(r.retryAfterSec) });
      return r.status === 503 ? json({ error: 'not-configured' }, 503) : unauthorized();
    }

    // The sign-in form of the private-site gate (no script on that page, so it posts a plain form).
    if (path === '/api/auth/gate' && method === 'POST') {
      if (!/^application\/x-www-form-urlencoded(;|$)/i.test(request.headers.get('content-type') ?? '')) return json({ error: 'expected-form' }, 415);
      const bytes = await readCapped(request, 4_096);
      if (!bytes) return json({ error: 'too-large' }, 413);
      const r = await attemptLogin(request, env, new URLSearchParams(new TextDecoder().decode(bytes)).get('key'));
      if (r.ok) return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': r.cookie, 'cache-control': 'no-store' } });
      return gateResponse(r.status === 429 ? 'locked' : r.status === 503 ? 'not-configured' : 'wrong-key', r.status, r.retryAfterSec);
    }

    if (path === '/api/auth/logout' && method === 'POST') return json({ authenticated: false }, 200, { 'set-cookie': clearCookie() });

    // ---- everything below is owner-only -----------------------------------
    if (!(await isOwner(request, env))) return unauthorized();

    if (path === '/api/auth/logout-all' && method === 'POST') {
      await env.backend.bumpEpoch();
      return json({ authenticated: false }, 200, { 'set-cookie': clearCookie() });
    }

    if (path === '/api/owner/status' && method === 'GET') return json(await env.backend.status());

    if (path === '/api/ai/ask' && method === 'POST') {
      const body = await readJson(request);
      if (!body.ok) return body.response;
      const task = AiTaskSchema.safeParse(body.value);
      if (!task.success) return json({ ok: false, code: 'invalid-request', message: task.error.issues[0]?.message ?? 'The request is not in an allowed form.' } satisfies AiReply, 400);
      const reply = await env.backend.askTask(task.data);
      return json(reply, reply.ok ? 200 : statusForCode(reply.code));
    }

    if (method === 'POST' && path.startsWith('/api/owner/')) {
      const body = await readJson(request);
      if (!body.ok) return body.response;
      const v = (body.value ?? {}) as Record<string, unknown>;
      const finish = (r: Ok | Err) => json(r, r.ok ? 200 : 400);
      switch (path) {
        case '/api/owner/config':
          return finish(await env.backend.setConfig(v));
        case '/api/owner/attest': {
          if (typeof v['name'] !== 'string' || !(ATTEST_NAMES as readonly string[]).includes(v['name'])) return json({ ok: false, error: 'unknown confirmation' }, 400);
          return finish(await env.backend.attest(v['name'], v));
        }
        case '/api/owner/revoke': {
          if (typeof v['name'] !== 'string' || !(ATTEST_NAMES as readonly string[]).includes(v['name'])) return json({ ok: false, error: 'unknown confirmation' }, 400);
          return finish(await env.backend.revoke(v['name']));
        }
        case '/api/owner/reconcile': {
          if (typeof v['id'] !== 'string' || typeof v['usd'] !== 'number' || !Number.isFinite(v['usd']) || v['usd'] < 0) return json({ ok: false, error: 'invalid amount' }, 400);
          return finish(await env.backend.reconcile(v['id'], v['usd']));
        }
        case '/api/owner/reset-pause':
          return finish(await env.backend.resetPause());
        default:
          break;
      }
    }
    return json({ error: 'not-found' }, 404);
  } catch {
    // Never echo internals. The details are not logged either: they could contain request content.
    return json({ error: 'server-error' }, 500);
  }
}
