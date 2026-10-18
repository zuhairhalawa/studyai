import { z } from 'zod';
import { addSafe } from './money';

/**
 * The budget ledger: what has been spent, what is set aside for calls in flight, and what is unknown.
 *
 * Rules that make it safe:
 *  - A call must first *reserve* its worst-case cost. If the reservation does not fit in the remaining daily AND monthly
 *    budget (counting every call already in flight), the call never happens.
 *  - After the call the reservation is settled to the real, provider-reported usage. Only a definitely-rejected call
 *    (the API refused it before running the model) gives the money back.
 *  - A call whose outcome is unknown (timeout, dropped connection, a worker that died mid-call, a response without usage)
 *    stays charged at its full reservation until the owner reconciles it against the Console. Delayed or missing
 *    reporting therefore can only make the app more cautious.
 *  - Anything that looks wrong (cost above its reservation, wrong workspace, many unknown outcomes, the API saying a limit
 *    was reached) trips a breaker that pauses AI until the owner resets it (or the month turns, for a spend limit).
 *
 * These functions are pure bookkeeping on a plain object; atomicity comes from the store that runs them (store.ts).
 */

export const LEDGER_VERSION = 1;
export const LOG_MAX = 500;
/** How far the clock may appear to go backwards before the ledger refuses to run (a reset day would hide spending). */
export const CLOCK_TOLERANCE_MS = 5 * 60_000;
/** A call still open after this long belonged to a worker that died; it is moved to "unknown", never refunded. */
export const STALE_OPEN_MS = 10 * 60_000;

const Nanos = z.number().int().nonnegative();
const Count = z.number().int().nonnegative();
const Key = z.string().min(1).max(80);

const Reservation = z
  .object({ id: Key, amount: Nanos, startedAt: Count, model: z.string(), purpose: z.string(), inputBound: Count, maxOutput: Count })
  .strict();

const Unresolved = z.object({ id: Key, amount: Nanos, startedAt: Count, day: z.string(), month: z.string(), model: z.string(), purpose: z.string(), reason: z.string() }).strict();

export const OUTCOMES = ['ok', 'released', 'unresolved', 'overrun', 'reconciled'] as const;
const LogEntry = z
  .object({
    id: Key,
    at: Count,
    model: z.string(),
    purpose: z.string(),
    outcome: z.enum(OUTCOMES),
    inputTokens: Count,
    outputTokens: Count,
    cacheWriteTokens: Count,
    cacheReadTokens: Count,
    /** What was charged to the budget for this call. */
    costNanos: Nanos,
    reservedNanos: Nanos,
    reason: z.string().optional(),
    providerRequestId: z.string().max(200).optional(),
  })
  .strict();

const Breaker = z
  .object({
    /** 'limit' = the provider said a limit was reached; 'anomaly' = something did not add up. */
    kind: z.enum(['limit', 'anomaly']),
    reason: z.string(),
    at: Count,
    /** Automatically lifted at this time (start of next month for a spend cap); null = only the owner can lift it. */
    until: Count.nullable(),
  })
  .strict();

export const LedgerSchema = z
  .object({
    v: z.literal(LEDGER_VERSION),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    month: z.string().regex(/^\d{4}-\d{2}$/),
    spentDay: Nanos,
    spentMonth: Nanos,
    requestsDay: Count,
    requestsMonth: Count,
    open: z.record(z.string(), Reservation),
    unresolved: z.record(z.string(), Unresolved),
    breaker: Breaker.nullable(),
    lastSeenAt: Count,
    log: z.array(LogEntry).max(LOG_MAX),
    totals: z.object({ spent: Nanos, requests: Count }).strict(),
  })
  .strict();

export type Ledger = z.infer<typeof LedgerSchema>;
export type LogEntryT = z.infer<typeof LogEntry>;
export type Breaker = z.infer<typeof Breaker>;

export const dayKey = (t: number): string => new Date(t).toISOString().slice(0, 10);
export const monthKey = (t: number): string => new Date(t).toISOString().slice(0, 7);
export function startOfNextMonthUtc(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

export function newLedger(now: number): Ledger {
  return { v: LEDGER_VERSION, day: dayKey(now), month: monthKey(now), spentDay: 0, spentMonth: 0, requestsDay: 0, requestsMonth: 0, open: {}, unresolved: {}, breaker: null, lastSeenAt: now, log: [], totals: { spent: 0, requests: 0 } };
}

export type RejectCode = 'clock-backwards' | 'provider-limit' | 'breaker' | 'concurrency' | 'requests-day' | 'requests-month' | 'budget-day' | 'budget-month' | 'too-many-unresolved';

export interface Limits {
  dailyNanos: number;
  monthlyNanos: number;
  maxRequestsPerDay: number;
  maxRequestsPerMonth: number;
  maxConcurrent: number;
  maxUnresolved: number;
}

export type Reserved = { ok: true } | { ok: false; code: RejectCode; message: string };

function pushLog(s: Ledger, e: LogEntryT): void {
  s.log.push(e);
  if (s.log.length > LOG_MAX) s.log.splice(0, s.log.length - LOG_MAX);
}

/** Moves the ledger to `now`: new day/month counters, expired breaker cleared. Returns a rejection if time looks wrong. */
export function advanceClock(s: Ledger, now: number): Reserved {
  if (!Number.isFinite(now) || now < s.lastSeenAt - CLOCK_TOLERANCE_MS) {
    return { ok: false, code: 'clock-backwards', message: 'The server clock moved backwards, so spending cannot be tracked safely. AI is paused.' };
  }
  const d = dayKey(now);
  const m = monthKey(now);
  // Only ever forward: a small step back across midnight (within the clock tolerance) must not forget what was already spent.
  if (d > s.day) {
    s.day = d;
    s.spentDay = 0;
    s.requestsDay = 0;
  }
  if (m > s.month) {
    s.month = m;
    s.spentMonth = 0;
    s.requestsMonth = 0;
  }
  if (now > s.lastSeenAt) s.lastSeenAt = now;
  if (s.breaker && s.breaker.until !== null && now >= s.breaker.until) s.breaker = null;
  return { ok: true };
}

/** Money spent is always added to the *current* day and month, even for a call that started in an earlier one (cautious). */
function charge(s: Ledger, nanos: number): void {
  s.spentDay = addSafe(s.spentDay, nanos);
  s.spentMonth = addSafe(s.spentMonth, nanos);
  s.totals.spent = addSafe(s.totals.spent, nanos);
}

export function trip(s: Ledger, kind: Breaker['kind'], reason: string, now: number, until: number | null = null): void {
  // Keep the first, most specific reason; a later trip never shortens an owner-only pause.
  if (s.breaker && (s.breaker.until === null || (until !== null && s.breaker.until >= until))) return;
  s.breaker = { kind, reason, at: now, until };
}

/** Owner action: lift the breaker after checking the Console. */
export function resetBreaker(s: Ledger): void {
  s.breaker = null;
}

/** Calls left open by a worker that died are charged in full and listed as unknown. Never refunded automatically. */
function sweepStale(s: Ledger, now: number, maxUnresolved: number): void {
  for (const r of Object.values(s.open)) {
    if (now - r.startedAt >= STALE_OPEN_MS) markUnresolved(s, r.id, 'The worker stopped before this call finished; its outcome is unknown.', now, maxUnresolved);
  }
}

export interface ReserveArgs {
  id: string;
  now: number;
  amount: number;
  model: string;
  purpose: string;
  inputBound: number;
  maxOutput: number;
}

export function reserve(s: Ledger, a: ReserveArgs, lim: Limits): Reserved {
  const clock = advanceClock(s, a.now);
  if (!clock.ok) return clock;
  sweepStale(s, a.now, lim.maxUnresolved);

  if (s.breaker) {
    return s.breaker.kind === 'limit'
      ? { ok: false, code: 'provider-limit', message: `AI is paused: ${s.breaker.reason}` }
      : { ok: false, code: 'breaker', message: `AI is paused until you review it: ${s.breaker.reason}` };
  }
  if (Object.keys(s.unresolved).length >= lim.maxUnresolved) {
    trip(s, 'anomaly', `${Object.keys(s.unresolved).length} calls have an unknown outcome. Check the Console usage page, then reconcile them.`, a.now);
    return { ok: false, code: 'too-many-unresolved', message: 'AI is paused: several earlier calls have an unknown outcome and need your review.' };
  }
  const open = Object.values(s.open);
  if (open.length >= lim.maxConcurrent) return { ok: false, code: 'concurrency', message: 'AI is busy with other requests. Try again in a moment.' };
  if (s.requestsDay + 1 > lim.maxRequestsPerDay) return { ok: false, code: 'requests-day', message: 'AI is paused: the daily request limit is reached. It resumes tomorrow (UTC).' };
  if (s.requestsMonth + 1 > lim.maxRequestsPerMonth) return { ok: false, code: 'requests-month', message: 'AI is paused: the monthly request limit is reached.' };

  const inFlight = open.reduce((n, r) => addSafe(n, r.amount), 0);
  if (addSafe(s.spentDay, inFlight, a.amount) > lim.dailyNanos) return { ok: false, code: 'budget-day', message: 'AI is paused: today’s AI budget would be exceeded. It resumes tomorrow (UTC).' };
  if (addSafe(s.spentMonth, inFlight, a.amount) > lim.monthlyNanos) return { ok: false, code: 'budget-month', message: 'AI is paused: this month’s AI budget would be exceeded.' };

  s.open[a.id] = { id: a.id, amount: a.amount, startedAt: a.now, model: a.model, purpose: a.purpose, inputBound: a.inputBound, maxOutput: a.maxOutput };
  s.requestsDay += 1;
  s.requestsMonth += 1;
  s.totals.requests += 1;
  return { ok: true };
}

export interface Settlement {
  id: string;
  now: number;
  costNanos: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  providerRequestId?: string;
}

/** The call finished and reported usage: charge what it really cost. A cost above the reservation trips the breaker. */
export function commit(s: Ledger, c: Settlement): { overrun: boolean } {
  const r = s.open[c.id];
  if (!r) throw new Error(`no open reservation ${c.id}`);
  delete s.open[c.id];
  charge(s, c.costNanos);
  const overrun = c.costNanos > r.amount;
  if (overrun) trip(s, 'anomaly', 'a call cost more than the amount set aside for it, so the price table or limits may be wrong.', c.now);
  pushLog(s, {
    id: c.id,
    at: c.now,
    model: r.model,
    purpose: r.purpose,
    outcome: overrun ? 'overrun' : 'ok',
    inputTokens: c.inputTokens,
    outputTokens: c.outputTokens,
    cacheWriteTokens: c.cacheWriteTokens,
    cacheReadTokens: c.cacheReadTokens,
    costNanos: c.costNanos,
    reservedNanos: r.amount,
    ...(c.providerRequestId ? { providerRequestId: c.providerRequestId } : {}),
  });
  return { overrun };
}

/** The provider refused the call before running the model (definitely not billed): the reservation is given back. */
export function release(s: Ledger, id: string, reason: string, now: number): void {
  const r = s.open[id];
  if (!r) throw new Error(`no open reservation ${id}`);
  delete s.open[id];
  pushLog(s, { id, at: now, model: r.model, purpose: r.purpose, outcome: 'released', inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, costNanos: 0, reservedNanos: r.amount, reason });
}

/** Outcome unknown: stays charged at the full reservation until the owner reconciles it. */
export function markUnresolved(s: Ledger, id: string, reason: string, now: number, maxUnresolved: number): void {
  const r = s.open[id];
  if (!r) throw new Error(`no open reservation ${id}`);
  delete s.open[id];
  s.unresolved[id] = { id, amount: r.amount, startedAt: r.startedAt, day: s.day, month: s.month, model: r.model, purpose: r.purpose, reason };
  charge(s, r.amount);
  pushLog(s, { id, at: now, model: r.model, purpose: r.purpose, outcome: 'unresolved', inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, costNanos: r.amount, reservedNanos: r.amount, reason });
  if (Object.keys(s.unresolved).length >= maxUnresolved) trip(s, 'anomaly', `${Object.keys(s.unresolved).length} calls have an unknown outcome. Check the Console usage page, then reconcile them.`, now);
}

/**
 * Owner action, after checking Console → Usage: replace the pessimistic charge for an unknown call with its real cost
 * (0 if the Console shows it was not billed). Only adjusts a period that is still the current one.
 */
export function reconcile(s: Ledger, id: string, actualNanos: number, now: number): void {
  const u = s.unresolved[id];
  if (!u) throw new Error(`no unresolved call ${id}`);
  delete s.unresolved[id];
  const delta = actualNanos - u.amount;
  const apply = (v: number): number => Math.max(0, v + delta);
  if (u.day === s.day) s.spentDay = apply(s.spentDay);
  if (u.month === s.month) s.spentMonth = apply(s.spentMonth);
  s.totals.spent = apply(s.totals.spent);
  pushLog(s, { id, at: now, model: u.model, purpose: u.purpose, outcome: 'reconciled', inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, costNanos: actualNanos, reservedNanos: u.amount, reason: 'Reconciled by the owner against the Console.' });
}
