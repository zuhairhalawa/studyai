import { describe, expect, it } from 'vitest';
import { EMPTY_THROTTLE, FAILS_BEFORE_LOCK, FORGIVE_AFTER_MS, MINUTE, ipBucket, isLocked, parseThrottle, registerFailure, retryAfterSeconds, type Throttle } from '../worker/src/throttle';

const T0 = Date.UTC(2026, 9, 16, 12, 0, 0);

function failTimes(n: number, start = T0, step = 1000): Throttle {
  let t: Throttle = EMPTY_THROTTLE;
  for (let i = 0; i < n; i++) t = registerFailure(t, start + i * step);
  return t;
}

describe('login throttle', () => {
  it('allows a few typos, then locks for 15 minutes, then doubles', () => {
    expect(isLocked(failTimes(FAILS_BEFORE_LOCK - 1), T0 + 10_000)).toBe(false);
    const five = failTimes(FAILS_BEFORE_LOCK);
    const at = T0 + (FAILS_BEFORE_LOCK - 1) * 1000;
    expect(isLocked(five, at)).toBe(true);
    expect(retryAfterSeconds(five, at)).toBe(15 * 60);
    expect(retryAfterSeconds(registerFailure(five, at), at)).toBe(30 * 60);
    expect(retryAfterSeconds(registerFailure(registerFailure(five, at), at), at)).toBe(60 * 60);
  });

  it('caps the lock at one day, however many guesses', () => {
    const many = failTimes(200, T0, 1);
    expect(retryAfterSeconds(many, T0 + 200)).toBeLessThanOrEqual(24 * 3600);
    expect(retryAfterSeconds(many, T0 + 200)).toBeGreaterThan(23 * 3600);
  });

  it('never shortens a lock that is already running', () => {
    const locked = failTimes(8);
    const later = registerFailure(locked, locked.at + 1);
    expect(later.lockedUntil).toBeGreaterThanOrEqual(locked.lockedUntil);
  });

  it('forgives failures after a quiet day, but only once any lock has run out', () => {
    const five = failTimes(FAILS_BEFORE_LOCK);
    const afterLock = five.lockedUntil + FORGIVE_AFTER_MS + MINUTE;
    const fresh = registerFailure(five, afterLock);
    expect(fresh.fails).toBe(1);
    expect(isLocked(fresh, afterLock)).toBe(false);
    // while still locked, a failure is never forgiven
    const during = registerFailure(five, five.at + 1000);
    expect(during.fails).toBe(FAILS_BEFORE_LOCK + 1);
  });

  it('reads stored records defensively and locks on garbage instead of opening', () => {
    expect(parseThrottle(undefined, T0)).toEqual(EMPTY_THROTTLE);
    expect(parseThrottle(JSON.stringify({ fails: 2, lockedUntil: 0, at: T0 }), T0)).toEqual({ fails: 2, lockedUntil: 0, at: T0 });
    expect(parseThrottle(JSON.stringify({ fails: 'x', lockedUntil: -5, at: null }), T0)).toEqual(EMPTY_THROTTLE);
    const broken = parseThrottle('{not json', T0);
    expect(isLocked(broken, T0)).toBe(true);
    expect(isLocked(broken, T0 + 16 * MINUTE)).toBe(false);
  });

  it('buckets IPv6 by /64 so an attacker cannot rotate addresses inside their own network', () => {
    expect(ipBucket('203.0.113.7')).toBe('203.0.113.7');
    expect(ipBucket('unknown')).toBe('unknown');
    expect(ipBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('v6:2001:db8:1:2');
    expect(ipBucket('2001:DB8:1:2::1')).toBe(ipBucket('2001:db8:1:2:ffff::9'));
    expect(ipBucket('2001:db8::1')).toBe('v6:2001:db8:0:0');
    expect(ipBucket('2001:db8:1:2:3::5')).toBe('v6:2001:db8:1:2');
    expect(ipBucket('::1')).toBe('v6:0:0:0:0');
    expect(ipBucket('2001:db8:1:3::1')).not.toBe(ipBucket('2001:db8:1:2::1'));
  });
});
