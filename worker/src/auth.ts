/**
 * Private owner authentication. Pure Web Crypto, no dependencies, runs in Workers and Node.
 *
 * Why an owner KEY instead of a passphrase: password stretching (PBKDF2/scrypt) would burn more CPU than the free Workers
 * plan allows per request, and it is unnecessary for a 256-bit random key. The owner generates the key once with
 * `pnpm owner:keygen`; only its SHA-256 hash is stored server-side (as a Cloudflare secret), so the key itself is never at
 * rest on the server and cannot be recovered from it. A session is an HMAC-signed, expiring cookie.
 */

const enc = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    const bin = atob(padded);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compares two strings without leaking, through timing, where they first differ. */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export const OWNER_KEY_PREFIX = 'sak_';
/** The shape of a key `owner:keygen` creates: prefix + 43 base64url characters (256 bits). */
export const OWNER_KEY_RE = /^sak_[A-Za-z0-9_-]{43}$/;

/** True when `provided` is the owner key whose SHA-256 is `expectedHashHex`. Always hashes, so timing does not depend on the guess. */
export async function verifyOwnerKey(provided: unknown, expectedHashHex: string | undefined): Promise<boolean> {
  const candidate = typeof provided === 'string' && provided.length <= 200 ? provided : '';
  const hash = await sha256Hex(candidate);
  const valid = typeof expectedHashHex === 'string' && /^[0-9a-f]{64}$/.test(expectedHashHex);
  const same = constantTimeEqual(hash, valid ? expectedHashHex : '0'.repeat(64));
  return valid && OWNER_KEY_RE.test(candidate) && same;
}

export interface SessionPayload {
  v: 1;
  /** Expiry, ms since epoch. */
  exp: number;
  /** Server-side counter; bumping it signs every session out. */
  epoch: number;
}

export const SESSION_MAX_AGE_S = 12 * 3600;
export const COOKIE_NAME = '__Host-studyai_session';

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

export function secretIsUsable(secret: string | undefined): secret is string {
  return typeof secret === 'string' && secret.length >= 32;
}

export async function signSession(secret: string, payload: SessionPayload): Promise<string> {
  const body = toBase64Url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), enc.encode(body)));
  return `${body}.${toBase64Url(sig)}`;
}

/** Returns the payload only for an untampered, unexpired token. WebCrypto verify is constant-time. */
export async function verifySession(secret: string | undefined, token: string | undefined, now: number): Promise<SessionPayload | undefined> {
  if (!secretIsUsable(secret) || !token || token.length > 1_000) return undefined;
  const [body, sig, ...rest] = token.split('.');
  if (!body || !sig || rest.length > 0) return undefined;
  const sigBytes = fromBase64Url(sig);
  if (!sigBytes || sigBytes.length !== 32) return undefined; // exactly one canonical HMAC-SHA256 signature
  const bodyBytes = fromBase64Url(body);
  if (!sigBytes || !bodyBytes) return undefined;
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), sigBytes, enc.encode(body));
  if (!ok) return undefined;
  try {
    const p = JSON.parse(new TextDecoder().decode(bodyBytes)) as Partial<SessionPayload>;
    if (p.v !== 1 || typeof p.exp !== 'number' || typeof p.epoch !== 'number' || !Number.isFinite(p.exp) || p.exp <= now) return undefined;
    return { v: 1, exp: p.exp, epoch: p.epoch };
  } catch {
    return undefined;
  }
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of (header ?? '').split(';')) {
    const part = raw.trim();
    const i = part.indexOf('=');
    if (i < 1) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function sessionCookie(token: string): string {
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE_S}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearCookie(): string {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

/** "localhost:8787" / "study.example.com" — lower-cased, no scheme, no path. Empty entries are dropped. */
export function parseAllowedHosts(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => /^[a-z0-9.-]+(:\d{1,5})?$/.test(h));
}

const isLocal = (host: string): boolean => /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);

/** The request must be addressed to a host the owner listed. An empty list allows nothing (fail closed). */
export function hostAllowed(request: Request, allowed: readonly string[]): boolean {
  const host = (request.headers.get('host') ?? new URL(request.url).host).toLowerCase();
  return allowed.length > 0 && allowed.includes(host);
}

/**
 * CSRF defence for state-changing requests, on top of SameSite=Strict: the browser-supplied Origin must be exactly this
 * site (https, or http only for localhost development), and if Fetch Metadata says the request is cross-site, it is refused.
 */
export function originAllowed(request: Request, allowed: readonly string[]): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') return false;
  // A real Origin is exactly scheme://host[:port]: no user info, no path, nothing else.
  if (origin.toLowerCase() !== u.origin.toLowerCase()) return false;
  const host = u.host.toLowerCase();
  const requestHost = (request.headers.get('host') ?? new URL(request.url).host).toLowerCase();
  if (host !== requestHost || !allowed.includes(host)) return false; // it must be THIS site, not just any allowed site
  return u.protocol === 'https:' || (u.protocol === 'http:' && isLocal(host));
}
