/**
 * Login throttling, as pure functions so the rules can be unit-tested without a Durable Object.
 * The Durable Object (do.ts) keeps one small record per client network and calls `registerFailure` on every wrong key.
 */

export const MINUTE = 60_000;
export const FAILS_BEFORE_LOCK = 5;
/** A quiet day forgives old failures, so a typo last week does not make today's first typo a long lock. */
export const FORGIVE_AFTER_MS = 24 * 60 * MINUTE;
const MAX_LOCK_MS = 24 * 60 * MINUTE;

export interface Throttle {
  fails: number;
  /** Epoch ms until which this network is locked (0 = not locked). */
  lockedUntil: number;
  /** Epoch ms of the latest failure. */
  at: number;
}

export const EMPTY_THROTTLE: Throttle = { fails: 0, lockedUntil: 0, at: 0 };

/**
 * IPv6 clients can pick any address in their /64, so the whole /64 shares one counter.
 * IPv4 (and anything unrecognised, including "unknown") is used as it is.
 */
export function ipBucket(ip: string): string {
  if (!ip.includes(':')) return ip;
  const groups = ip.toLowerCase().split(':');
  const gap = groups.indexOf('');
  const head = gap === -1 ? groups : groups.slice(0, gap);
  while (gap !== -1 && head.length < 4) head.push('0');
  return `v6:${head.slice(0, 4).join(':')}`;
}

/** Reads a stored record defensively. Anything unreadable counts as "locked for a while": fail closed, not open. */
export function parseThrottle(raw: string | undefined, now: number): Throttle {
  if (raw === undefined) return EMPTY_THROTTLE;
  try {
    const v = JSON.parse(raw) as Partial<Throttle>;
    const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0);
    return { fails: Math.floor(num(v.fails)), lockedUntil: num(v.lockedUntil), at: num(v.at) };
  } catch {
    return { fails: FAILS_BEFORE_LOCK, lockedUntil: now + 15 * MINUTE, at: now };
  }
}

/**
 * Counts one more wrong key. From the fifth failure on the network is locked for 15 minutes, doubling with every further
 * failure, up to one day. A lock that is already running is never shortened.
 */
export function registerFailure(prev: Throttle, now: number): Throttle {
  const stale = prev.lockedUntil <= now && now - prev.at > FORGIVE_AFTER_MS;
  const fails = (stale ? 0 : prev.fails) + 1;
  let lockedUntil = stale ? 0 : prev.lockedUntil;
  if (fails >= FAILS_BEFORE_LOCK) {
    const wait = Math.min(15 * MINUTE * 2 ** Math.min(fails - FAILS_BEFORE_LOCK, 12), MAX_LOCK_MS);
    lockedUntil = Math.max(lockedUntil, now + wait);
  }
  return { fails, lockedUntil, at: now };
}

export const isLocked = (t: Throttle, now: number): boolean => t.lockedUntil > now;
export const retryAfterSeconds = (t: Throttle, now: number): number => (isLocked(t, now) ? Math.max(1, Math.ceil((t.lockedUntil - now) / 1000)) : 0);
