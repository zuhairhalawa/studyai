/**
 * Money is kept as integer nano-dollars (1 USD = 1 000 000 000) so that no budget decision ever depends on
 * floating-point rounding. Every price Anthropic lists per million tokens is a whole number of nano-dollars
 * per token ($0.10 / MTok = 100 n$ per token), so token costs are exact integers.
 */

export const NANOS_PER_USD = 1_000_000_000;

/** Dollars (as typed by the owner) to nano-dollars, rounded to the nearest nano-dollar. Throws on anything unusable. */
export function usdToNanos(usd: number): number {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) throw new RangeError(`not a valid dollar amount: ${String(usd)}`);
  const n = Math.round(usd * NANOS_PER_USD);
  if (!Number.isSafeInteger(n)) throw new RangeError('dollar amount is too large');
  return n;
}

export function nanosToUsd(nanos: number): number {
  return nanos / NANOS_PER_USD;
}

/** "$0.0035" style text for people. Never used for decisions. */
export function formatUsd(nanos: number): string {
  const usd = nanosToUsd(nanos);
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
  return `$${usd.toFixed(2)}`;
}

/** True for a non-negative integer that is safe to add and multiply with other such values in this module. */
export function isNonNegativeInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

/** Adds non-negative integers and throws instead of silently losing precision. */
export function addSafe(...xs: number[]): number {
  let sum = 0;
  for (const x of xs) {
    if (!isNonNegativeInt(x)) throw new RangeError(`not a non-negative integer: ${String(x)}`);
    sum += x;
    if (!Number.isSafeInteger(sum)) throw new RangeError('amount overflow');
  }
  return sum;
}

export function mulSafe(a: number, b: number): number {
  if (!isNonNegativeInt(a) || !isNonNegativeInt(b)) throw new RangeError(`not a non-negative integer: ${String(a)} × ${String(b)}`);
  const p = a * b;
  if (!Number.isSafeInteger(p)) throw new RangeError('amount overflow');
  return p;
}
