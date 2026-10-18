import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AI_CONFIG } from '../src/core/ai/config';
import { CLOCK_TOLERANCE_MS, LOG_MAX, STALE_OPEN_MS } from '../src/core/ai/ledger';
import { MemoryBudgetStore } from '../src/core/ai/store';
import { attestedConfig, deferred, FakeProvider, NOW, ok, okUsage, REQ, REQ_RESERVATION, setup } from './ai-helpers';

const DAY = 86_400_000;
const ACTUAL = 20 * 100 + 30 * 500; // okUsage() on Haiku: 17 000 nano-dollars

afterEach(() => vi.useRealTimers());

/** Tiny artificial budget: $0.0003 a day (300 000 nano-dollars) — room for a handful of calls. */
const tiny = (over: Parameters<typeof attestedConfig>[0] = {}) => attestedConfig({ budgets: { dailyUsd: 0.0003, monthlyUsd: 1 }, ...over });

describe('nothing happens unless the gate is open', () => {
  it('the shipped default never calls the provider', async () => {
    const { ai, provider } = setup({ config: DEFAULT_AI_CONFIG });
    const r = await ai.ask(REQ);
    expect(r).toMatchObject({ ok: false, code: 'disabled' });
    expect(provider.calls).toBe(0);
  });

  it('a stored key or an "enabled" flag alone is not enough', async () => {
    const { ai, provider } = setup({ config: { ...DEFAULT_AI_CONFIG, enabled: true } });
    expect(await ai.ask(REQ)).toMatchObject({ ok: false, code: 'disabled' });
    expect(provider.calls).toBe(0);
  });

  it('confirmations that go stale switch AI off again', async () => {
    const { ai, provider, clock } = setup();
    expect((await ai.ask(REQ)).ok).toBe(true);
    clock.t = NOW + 40 * DAY;
    expect(await ai.ask(REQ)).toMatchObject({ ok: false, code: 'disabled' });
    expect(provider.calls).toBe(1);
  });

  it('rejects requests outside the allowlist before anything is reserved', async () => {
    const { ai, provider, store } = setup();
    const bad: [unknown, string][] = [
      [{ ...REQ, tools: [{ name: 'web_search' }] }, 'invalid-request'],
      [{ ...REQ, stream: true }, 'invalid-request'],
      [{ ...REQ, model: 'claude-opus-5-5' }, 'model-not-allowed'], // priced, but not on the owner's list
      [{ ...REQ, model: 'claude-unknown' }, 'model-not-allowed'],
      [{ ...REQ, maxOutputTokens: 5000 }, 'too-large'],
      [{ ...REQ, messages: [{ role: 'user', content: 'x'.repeat(40_000) }] }, 'too-large'],
      [null, 'invalid-request'],
    ];
    for (const [r, code] of bad) expect(await ai.ask(r), JSON.stringify(r)?.slice(0, 60)).toMatchObject({ ok: false, code });
    expect(provider.calls).toBe(0);
    expect((await store.read(NOW)).requestsDay).toBe(0);
  });
});

describe('accounting for a normal call', () => {
  it('charges exactly the reported usage and logs it per request', async () => {
    const { ai, store } = setup();
    const r = await ai.ask(REQ);
    expect(r).toMatchObject({ ok: true, text: 'an answer', costNanos: ACTUAL, costIsEstimate: false, requestId: 'req_fake' });
    const l = await store.read(NOW);
    expect(l.spentDay).toBe(ACTUAL);
    expect(l.spentMonth).toBe(ACTUAL);
    expect(l.requestsDay).toBe(1);
    expect(Object.keys(l.open)).toHaveLength(0);
    expect(l.log).toHaveLength(1);
    expect(l.log[0]).toMatchObject({ model: 'claude-haiku-5-5', purpose: 'tutor', outcome: 'ok', inputTokens: 20, outputTokens: 30, costNanos: ACTUAL, reservedNanos: REQ_RESERVATION, providerRequestId: 'req_fake' });
    // the provider got only the allowlisted, clamped request
    // (checked in the Anthropic adapter tests for the wire format)
  });

  it('sends the provider the owner-capped output length and nothing extra', async () => {
    const { ai, provider } = setup();
    await ai.ask({ ...REQ, system: 'be brief', temperature: 0.2 });
    expect(provider.last).toEqual({ model: 'claude-haiku-5-5', maxOutputTokens: 100, messages: REQ.messages, system: 'be brief', temperature: 0.2 });
  });

  it('keeps only the most recent log entries', async () => {
    const { ai, store } = setup({ config: attestedConfig({ budgets: { dailyUsd: 1, monthlyUsd: 10 }, limits: { maxRequestsPerDay: 2000, maxRequestsPerMonth: 30_000 } }) });
    for (let i = 0; i < LOG_MAX + 20; i++) await ai.ask(REQ);
    const l = await store.read(NOW);
    expect(l.log).toHaveLength(LOG_MAX);
    expect(l.requestsDay).toBe(LOG_MAX + 20);
  });
});

describe('a tiny budget runs out and AI stops; nothing is spent past it', () => {
  it('daily budget: exactly as many calls as fit, then a clean refusal that lifts tomorrow', async () => {
    const { ai, provider, store, clock } = setup({ config: tiny() });
    let admitted = 0;
    let refusal;
    for (let i = 0; i < 60; i++) {
      const r = await ai.ask(REQ);
      if (r.ok) admitted += 1;
      else {
        refusal = r;
        break;
      }
    }
    // After n settled calls the ledger holds n × 17 000; the next fits while spent + 83 000 ≤ 300 000 → n ≤ 12.
    expect(admitted).toBe(13);
    expect(refusal).toMatchObject({ ok: false, code: 'budget-day' });
    expect(provider.calls).toBe(13);
    expect((await store.read(NOW)).spentDay).toBe(13 * ACTUAL);
    expect((await store.read(NOW)).spentDay).toBeLessThanOrEqual(300_000);

    // what is left ($0.000079) is below the worst case of a maximum-size request, so the screen says so
    const s = await ai.status();
    expect(s.state).toBe('low');
    expect(s.remainingDayNanos).toBe(300_000 - 13 * ACTUAL);
    expect(s.reasons.join(' ')).toMatch(/left of today/i);

    // still refused later the same day, no provider call
    expect(await ai.ask(REQ)).toMatchObject({ ok: false, code: 'budget-day' });
    expect(provider.calls).toBe(13);

    // the next UTC day starts a fresh daily allowance
    clock.t = NOW + DAY;
    expect((await ai.ask(REQ)).ok).toBe(true);
    expect((await store.read(clock.t)).spentDay).toBe(ACTUAL);
    expect((await store.read(clock.t)).spentMonth).toBe(14 * ACTUAL);
  });

  it('monthly budget: stays paused for the rest of the month, resumes next month', async () => {
    // $0.0004 a month = 400 000 nano-dollars; daily budget is the same so only the monthly cap binds across days.
    const cfg = attestedConfig({ budgets: { dailyUsd: 0.0004, monthlyUsd: 0.0004 } });
    const { ai, provider, clock } = setup({ config: cfg });
    let n = 0;
    while ((await ai.ask(REQ)).ok) n += 1;
    expect(n).toBeGreaterThan(5);
    const calls = provider.calls;
    clock.t = NOW + 2 * DAY; // new day, same month
    expect(await ai.ask(REQ)).toMatchObject({ ok: false, code: 'budget-month' });
    expect(provider.calls).toBe(calls);
    clock.t = Date.UTC(2026, 10, 2, 8, 0, 0); // November (confirmations are still fresh)
    expect((await ai.ask(REQ)).ok).toBe(true);
  });

  it('request-count caps hold even when each call is cheap', async () => {
    const { ai, provider } = setup({ config: attestedConfig({ limits: { maxRequestsPerDay: 3 } }) });
    for (let i = 0; i < 3; i++) expect((await ai.ask(REQ)).ok).toBe(true);
    expect(await ai.ask(REQ)).toMatchObject({ ok: false, code: 'requests-day' });
    expect(provider.calls).toBe(3);
  });

  it('a call that is refused still uses up one request of the daily count (no hammering)', async () => {
    const { ai, store } = setup({ provider: new FakeProvider(() => ({ kind: 'rejected', status: 400, message: 'bad' })) });
    await ai.ask(REQ);
    expect((await store.read(NOW)).requestsDay).toBe(1);
  });
});

describe('concurrent requests cannot overspend (reservations are atomic)', () => {
  it('ten simultaneous calls against a budget that fits two: exactly two reach the provider', async () => {
    const gate = deferred<void>();
    const provider = new FakeProvider(async () => {
      await gate.promise;
      return ok();
    });
    // room for exactly two worst-case reservations (2 × 83 000 = 166 000 ≤ 170 000 < 3 × 83 000)
    const cfg = attestedConfig({ budgets: { dailyUsd: 0.00017, monthlyUsd: 1 }, limits: { maxConcurrent: 4 } });
    const { ai, store } = setup({ config: cfg, provider });
    const all = Array.from({ length: 10 }, () => ai.ask(REQ));
    await vi.waitFor(() => expect(provider.calls).toBe(2));
    // everything else was refused while those two were still in flight (their reservations count)
    const mid = await store.read(NOW);
    expect(Object.keys(mid.open)).toHaveLength(2);
    gate.resolve();
    const results = await Promise.all(all);
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.ok && r.code === 'budget-day')).toHaveLength(8);
    expect(provider.calls).toBe(2);
    const end = await store.read(NOW);
    expect(end.spentDay).toBe(2 * ACTUAL);
    expect(Object.keys(end.open)).toHaveLength(0);
  });

  it('the concurrency limit holds with a large budget', async () => {
    const gate = deferred<void>();
    const provider = new FakeProvider(async () => {
      await gate.promise;
      return ok();
    });
    const { ai } = setup({ provider, config: attestedConfig({ limits: { maxConcurrent: 2 } }) });
    const all = Array.from({ length: 10 }, () => ai.ask(REQ));
    await vi.waitFor(() => expect(provider.calls).toBe(2));
    gate.resolve();
    const results = await Promise.all(all);
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.ok && r.code === 'concurrency')).toHaveLength(8);
  });
});

describe('when the outcome is unknown, the money stays counted (delayed or missing reports)', () => {
  it('a timeout keeps the full reservation charged; a late answer cannot refund it; the owner can reconcile', async () => {
    vi.useFakeTimers();
    const late = deferred<ReturnType<typeof ok>>();
    const provider = new FakeProvider(() => late.promise);
    const { ai, store } = setup({ provider });
    const pending = ai.ask(REQ);
    await vi.advanceTimersByTimeAsync(30_001);
    const r = await pending;
    expect(r).toMatchObject({ ok: false, code: 'outcome-unknown' });
    let l = await store.read(NOW);
    expect(l.spentDay).toBe(REQ_RESERVATION);
    expect(Object.keys(l.unresolved)).toHaveLength(1);
    expect(l.log[0]).toMatchObject({ outcome: 'unresolved', costNanos: REQ_RESERVATION });

    late.resolve(ok()); // the provider finally answers; nothing changes
    await vi.advanceTimersByTimeAsync(10);
    l = await store.read(NOW);
    expect(l.spentDay).toBe(REQ_RESERVATION);

    expect((await ai.status()).unresolved).toHaveLength(1);
    // the owner checks Console → Usage, finds the call cost $0.000017, and reconciles
    const id = Object.keys(l.unresolved)[0]!;
    await ai.reconcileUnresolved(id, 0.000017);
    l = await store.read(NOW);
    expect(l.spentDay).toBe(ACTUAL);
    expect(Object.keys(l.unresolved)).toHaveLength(0);
    expect(l.log.at(-1)).toMatchObject({ outcome: 'reconciled', costNanos: ACTUAL });
  });

  it('5xx, dropped connections and unreadable answers all stay charged; enough of them pause AI', async () => {
    const provider = new FakeProvider(() => ({ kind: 'unknown', message: 'The connection failed.' }));
    const { ai, store } = setup({ provider, config: attestedConfig({ limits: { maxUnresolved: 2 } }) });
    expect(await ai.ask(REQ)).toMatchObject({ ok: false, code: 'outcome-unknown' });
    expect(await ai.ask(REQ)).toMatchObject({ ok: false, code: 'outcome-unknown' });
    expect((await store.read(NOW)).spentDay).toBe(2 * REQ_RESERVATION);
    // two unresolved calls = the limit → paused until the owner has looked
    expect(await ai.ask(REQ)).toMatchObject({ ok: false, code: 'breaker' });
    expect(provider.calls).toBe(2);
    expect((await ai.status()).state).toBe('paused');
    await ai.resetPause();
    // the pause is lifted but the unresolved calls still count, so it trips again until they are reconciled
    expect(await ai.ask(REQ)).toMatchObject({ ok: false, code: 'too-many-unresolved' });
    for (const u of (await ai.status()).unresolved ?? []) await ai.reconcileUnresolved(u.id, 0);
    await ai.resetPause();
    expect(await store.read(NOW).then((l) => l.spentDay)).toBe(0);
    provider.behavior = () => ok();
    expect((await ai.ask(REQ)).ok).toBe(true);
  });

  it('a provider that throws is treated as unknown, not as free', async () => {
    const provider = new FakeProvider(() => {
      throw new Error('boom');
    });
    const { ai, store } = setup({ provider });
    expect(await ai.ask(REQ)).toMatchObject({ ok: false, code: 'outcome-unknown' });
    expect((await store.read(NOW)).spentDay).toBe(REQ_RESERVATION);
  });

  it('a worker that died mid-call leaves a reservation that is charged, never refunded', async () => {
    const gate = deferred<void>();
    const provider = new FakeProvider(async () => {
      await gate.promise; // never settles in this test: simulates the worker disappearing
      return ok();
    });
    const { ai, store, clock } = setup({ provider });
    void ai.ask(REQ);
    await vi.waitFor(() => expect(provider.calls).toBe(1));
    expect(Object.keys((await store.read(NOW)).open)).toHaveLength(1);
    clock.t = NOW + STALE_OPEN_MS + 1_000;
    provider.behavior = () => ok();
    expect((await ai.ask(REQ)).ok).toBe(true); // the sweep runs inside the next reservation
    const l = await store.read(clock.t);
    expect(Object.keys(l.unresolved)).toHaveLength(1);
    expect(l.spentDay).toBe(REQ_RESERVATION + ACTUAL);
    gate.resolve();
  });

  it('an answer without readable usage is delivered but charged at the full reservation', async () => {
    for (const usage of [undefined, null, {}, { input_tokens: 'many', output_tokens: 3 }, { input_tokens: -5, output_tokens: 3 }, { input_tokens: 1.5, output_tokens: 3 }, { input_tokens: 1, output_tokens: NaN }, { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: -1 }]) {
      const { ai, store } = setup({ provider: new FakeProvider(() => ({ ...ok(), usage })) });
      const r = await ai.ask(REQ);
      expect(r, JSON.stringify(usage)).toMatchObject({ ok: true, costIsEstimate: true, costNanos: REQ_RESERVATION });
      const l = await store.read(NOW);
      expect(l.spentDay).toBe(REQ_RESERVATION);
      expect(Object.keys(l.unresolved)).toHaveLength(1);
    }
  });
});

describe('definite refusals give the money back; limit messages pause AI', () => {
  it('a refusal before the model ran costs nothing', async () => {
    const { ai, store } = setup({ provider: new FakeProvider(() => ({ kind: 'rejected', status: 400, message: 'max_tokens too large' })) });
    expect(await ai.ask(REQ)).toMatchObject({ ok: false, code: 'provider-rejected' });
    const l = await store.read(NOW);
    expect(l.spentDay).toBe(0);
    expect(l.log[0]).toMatchObject({ outcome: 'released', costNanos: 0 });
    expect(Object.keys(l.open)).toHaveLength(0);
  });

  it('"spend limit reached" pauses AI until the limit resets next month; the provider is not called again', async () => {
    const provider = new FakeProvider(() => ({ kind: 'rejected', status: 429, message: 'You have reached your API usage limits', limit: 'spend-limit' }));
    const { ai, clock } = setup({ provider });
    expect(await ai.ask(REQ)).toMatchObject({ ok: false, code: 'provider-rejected' });
    expect(await ai.ask(REQ)).toMatchObject({ ok: false, code: 'provider-limit' });
    expect(await ai.ask(REQ)).toMatchObject({ ok: false, code: 'provider-limit' });
    expect(provider.calls).toBe(1);
    expect((await ai.status()).state).toBe('paused');
    clock.t = Date.UTC(2026, 10, 1, 0, 0, 1);
    provider.behavior = () => ok();
    expect((await ai.ask(REQ)).ok).toBe(true);
  });

  it('"credit balance too low" pauses AI until the owner lifts it, even in a new month', async () => {
    const provider = new FakeProvider(() => ({ kind: 'rejected', status: 400, message: 'Your credit balance is too low to access the Anthropic API.', limit: 'credits' }));
    const { ai, clock } = setup({ provider });
    await ai.ask(REQ);
    clock.t = Date.UTC(2026, 10, 3, 0, 0, 0);
    provider.behavior = () => ok();
    expect(await ai.ask(REQ)).toMatchObject({ ok: false, code: 'provider-limit' });
    expect(provider.calls).toBe(1);
    await ai.resetPause();
    expect((await ai.ask(REQ)).ok).toBe(true);
  });
});

describe('anything that does not add up trips a breaker (fail closed)', () => {
  it('a cost above its own reservation pauses AI', async () => {
    const { ai, store, provider } = setup({ provider: new FakeProvider(() => ok({ input_tokens: 20, output_tokens: 900_000 })) });
    const r = await ai.ask(REQ);
    expect(r.ok).toBe(true); // it ran and was billed; the cost is recorded in full
    const l = await store.read(NOW);
    expect(l.spentDay).toBe(20 * 100 + 900_000 * 500);
    expect(l.log[0]).toMatchObject({ outcome: 'overrun' });
    expect(await ai.ask(REQ)).toMatchObject({ ok: false, code: 'breaker' });
    expect(provider.calls).toBe(1);
  });

  it('a response from the wrong Console workspace, or one that does not say, pauses AI', async () => {
    for (const out of [ok(okUsage(), { workspaceId: 'wrkspc_someoneelse' }), (() => { const o = ok(); delete (o as { workspaceId?: string }).workspaceId; return o; })()]) {
      const { ai, provider } = setup({ provider: new FakeProvider(() => out) });
      expect((await ai.ask(REQ)).ok).toBe(true);
      expect(await ai.ask(REQ)).toMatchObject({ ok: false, code: 'breaker' });
      expect(provider.calls).toBe(1);
    }
  });
});

describe('if the remaining budget cannot be determined, nothing is sent', () => {
  it('a failing store means no provider call', async () => {
    const { ai, provider, store } = setup();
    store.failNext = new Error('disk gone');
    expect(await ai.ask(REQ)).toMatchObject({ ok: false, code: 'budget-unknown' });
    expect(provider.calls).toBe(0);
    expect((await ai.ask(REQ)).ok).toBe(true); // recovers when the store does
  });

  it('a damaged ledger means no provider call', async () => {
    const garbage: unknown[] = [
      'not a ledger',
      { v: 1 },
      { v: 2 },
      { ...(await new MemoryBudgetStore().read(NOW)), spentDay: -1 },
      { ...(await new MemoryBudgetStore().read(NOW)), spentDay: Number.NaN },
      { ...(await new MemoryBudgetStore().read(NOW)), spentMonth: 1.5 },
      { ...(await new MemoryBudgetStore().read(NOW)), extra: true },
    ];
    for (const g of garbage) {
      const { ai, provider } = setup({ store: new MemoryBudgetStore(g) });
      expect(await ai.ask(REQ)).toMatchObject({ ok: false, code: 'budget-unknown' });
      expect(provider.calls).toBe(0);
      expect((await ai.status()).state).toBe('unknown');
    }
  });

  it('if the result cannot be recorded, the answer is discarded and the reservation stays counted', async () => {
    const store = new MemoryBudgetStore();
    const provider = new FakeProvider(() => {
      store.failNext = new Error('write failed'); // the settlement write will fail
      return ok();
    });
    const { ai, clock } = setup({ store, provider });
    expect(await ai.ask(REQ)).toMatchObject({ ok: false, code: 'budget-unknown' });
    let l = await store.read(NOW);
    expect(Object.keys(l.open)).toHaveLength(1); // still reserved, so still counted against the budget
    // later it is swept to "unknown" and charged in full — never refunded
    clock.t = NOW + STALE_OPEN_MS + 1;
    provider.behavior = () => ok();
    await ai.ask(REQ);
    l = await store.read(clock.t);
    expect(Object.keys(l.unresolved)).toHaveLength(1);
  });

  it('a clock that jumps backwards stops AI; small drift is tolerated', async () => {
    const { ai, provider, clock } = setup();
    expect((await ai.ask(REQ)).ok).toBe(true);
    clock.t = NOW - CLOCK_TOLERANCE_MS / 2;
    expect((await ai.ask(REQ)).ok).toBe(true);
    clock.t = NOW - 2 * CLOCK_TOLERANCE_MS;
    expect(await ai.ask(REQ)).toMatchObject({ ok: false, code: 'clock-backwards' });
    expect(provider.calls).toBe(2);
  });

  it('a small step back across midnight or a month end never forgets what was already spent', async () => {
    const { ai, store, clock } = setup();
    clock.t = Date.UTC(2026, 9, 31, 23, 59, 59);
    expect((await ai.ask(REQ)).ok).toBe(true);
    clock.t = Date.UTC(2026, 10, 1, 0, 0, 5); // new day and new month
    expect((await ai.ask(REQ)).ok).toBe(true);
    clock.t = Date.UTC(2026, 9, 31, 23, 59, 58); // the clock steps back a few seconds, inside the tolerance
    expect((await ai.ask(REQ)).ok).toBe(true);
    const l = await store.read(clock.t);
    expect(l.day).toBe('2026-11-01');
    expect(l.month).toBe('2026-11');
    expect(l.spentDay).toBe(2 * ACTUAL); // the old code moved back to October and reset the counters to this call alone
    expect(l.spentMonth).toBe(2 * ACTUAL);
    expect(l.requestsDay).toBe(2);
  });

  it('a call that straddles midnight is charged to the new day (cautious)', async () => {
    const gate = deferred<void>();
    const provider = new FakeProvider(async () => {
      await gate.promise;
      return ok();
    });
    const { ai, store, clock } = setup({ provider });
    clock.t = Date.UTC(2026, 9, 16, 23, 59, 50);
    const p = ai.ask(REQ);
    await vi.waitFor(() => expect(provider.calls).toBe(1));
    clock.t = Date.UTC(2026, 9, 17, 0, 0, 10);
    gate.resolve();
    expect((await p).ok).toBe(true);
    const l = await store.read(clock.t);
    expect(l.day).toBe('2026-10-17');
    expect(l.spentDay).toBe(ACTUAL);
    expect(l.spentMonth).toBe(ACTUAL);
  });
});

describe('status for the settings screen', () => {
  it('never claims billing is verified', async () => {
    const off = await setup({ config: DEFAULT_AI_CONFIG }).ai.status();
    expect(off).toMatchObject({ state: 'off', billing: 'owner-attestation-required' });
    expect(off.reasons.length).toBeGreaterThan(3);
    const on = await setup().ai.status();
    expect(on).toMatchObject({ state: 'ready', billing: 'owner-attested-not-verified', spentDayNanos: 0 });
    // the only place the word appears is "not-verified"
    expect(JSON.stringify([off, on])).not.toMatch(/(?<!not-)verified|billing is safe/i);
  });

  it('shows what is left', async () => {
    const { ai } = setup({ config: tiny() });
    await ai.ask(REQ);
    const s = await ai.status();
    expect(s.remainingDayNanos).toBe(300_000 - ACTUAL);
    expect(s.spentMonthNanos).toBe(ACTUAL);
    expect(s.requestsToday).toBe(1);
  });
});
