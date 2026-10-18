import { DurableObject } from 'cloudflare:workers';
import type { GateFn } from '../../src/core/ai/config';
import { GeminiProvider } from '../../src/core/ai/gemini';
import { DEFAULT_GEMINI_CONFIG, GEMINI_PRICE_TABLE, GeminiConfigSchema, geminiConfigProblems, geminiGate, type GeminiConfig } from '../../src/core/ai/gemini-config';
import { GuardedAi, type AskResult } from '../../src/core/ai/guard';
import { advanceClock } from '../../src/core/ai/ledger';
import { nanosToUsd, usdToNanos } from '../../src/core/ai/money';
import type { Provider } from '../../src/core/ai/provider';
import { SyncBudgetStore } from '../../src/core/ai/store';
import { ATTEST_NAMES, type AiReply, type AiTask, type AttestName, type OwnerStatus } from '../../src/core/tutor/contract';
import { buildAiRequest } from '../../src/core/tutor/prompts';
import { sha256Hex } from './auth';
import { ledgerStorage } from './ledger-storage';
import type { Err, Ok } from './app';
import { FORGIVE_AFTER_MS, ipBucket, isLocked, parseThrottle, registerFailure, retryAfterSeconds } from './throttle';

/**
 * The single, private brain of the site: one Durable Object instance ("owner") holds the spend ledger, the owner's AI
 * settings and confirmations, the login throttle and the session epoch. Being single-threaded with synchronous SQLite
 * storage, a budget reservation here is atomic: no two requests can both see the same remaining budget.
 *
 * It stores NO lecture text, prompts or answers — only counters, costs, settings and dates.
 */

const NO_PROVIDER: Provider = { complete: async () => ({ kind: 'unknown', message: 'No provider is configured.' }) };

const today = (now: number): string => new Date(now).toISOString().slice(0, 10);
const err = (error: string): Err => ({ ok: false, error });

export class StudyAiDO extends DurableObject<Env> {
  private readonly store: SyncBudgetStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    this.store = new SyncBudgetStore(ledgerStorage({ get: (k) => this.get(k), put: (k, v) => this.put(k, v) }));
  }

  // ---- synchronous storage ---------------------------------------------------
  private get(k: string): string | undefined {
    return this.ctx.storage.sql.exec<{ v: string }>('SELECT v FROM kv WHERE k = ?', k).toArray()[0]?.v;
  }
  private put(k: string, v: string): void {
    this.ctx.storage.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v);
  }
  private del(k: string): void {
    this.ctx.storage.sql.exec('DELETE FROM kv WHERE k = ?', k);
  }

  /** Overridden by the local test entry; production always talks to Google with the secret key. */
  protected createProvider(): Provider | undefined {
    const key = this.env.GEMINI_API_KEY;
    return typeof key === 'string' && key.length >= 8 ? new GeminiProvider(key, (url, init) => fetch(url, init)) : undefined;
  }

  // ---- configuration ---------------------------------------------------------
  /** The stored settings, or the shipped defaults (switched off) if nothing valid is stored. */
  private loadConfig(): GeminiConfig {
    const raw = this.get('config');
    if (raw !== undefined) {
      try {
        const parsed = GeminiConfigSchema.safeParse(JSON.parse(raw));
        if (parsed.success) return parsed.data;
      } catch {
        /* fall through to the safe default */
      }
    }
    return DEFAULT_GEMINI_CONFIG;
  }
  private saveConfig(c: GeminiConfig): void {
    this.put('config', JSON.stringify(c));
  }

  private guard(): { ai: GuardedAi; config: GeminiConfig; hasKey: boolean } {
    const config = this.loadConfig();
    const provider = this.createProvider();
    const base = geminiGate(config);
    const gate: GateFn = (now) => {
      const g = base(now);
      if (provider) return g;
      return { ok: false, reasons: ['No Gemini key is configured on the server.', ...(g.ok ? [] : g.reasons)] };
    };
    return { ai: new GuardedAi({ store: this.store, provider: provider ?? NO_PROVIDER, gate }), config, hasKey: !!provider };
  }

  // ---- AI ----------------------------------------------------------------------
  async askTask(task: AiTask): Promise<AiReply> {
    const { ai, config } = this.guard();
    const model = config.models[0] ?? DEFAULT_GEMINI_CONFIG.models[0]!;
    const built = buildAiRequest(task, model, config.limits.maxOutputTokens);
    return toReply(await ai.ask(built.request));
  }

  async status(): Promise<OwnerStatus> {
    const { ai, config, hasKey } = this.guard();
    const s = await ai.status();
    // Usage is shown in every state (also when AI is off), read straight from the ledger.
    if (s.spentDayNanos === undefined) {
      try {
        const now = Date.now();
        const l = await this.store.read(now);
        advanceClock(l, now);
        const dayCap = usdToNanos(config.budgets.dailyUsd);
        const monthCap = usdToNanos(config.budgets.monthlyUsd);
        s.spentDayNanos = l.spentDay;
        s.spentMonthNanos = l.spentMonth;
        s.remainingDayNanos = Math.max(0, dayCap - l.spentDay);
        s.remainingMonthNanos = Math.max(0, monthCap - l.spentMonth);
        s.requestsToday = l.requestsDay;
        s.unresolved = Object.values(l.unresolved).map((u) => ({ id: u.id, amountNanos: u.amount, reason: u.reason }));
      } catch {
        /* an unreadable ledger is reported by the guard's own status when AI is on; here the numbers are simply omitted */
      }
    }
    const usd = (n: number | undefined) => (n === undefined ? undefined : nanosToUsd(n));
    const a = config.attestations;
    const attestations: OwnerStatus['attestations'] = {};
    for (const name of ATTEST_NAMES) {
      const v = a[name];
      if (v) attestations[name] = { confirmedAt: v.confirmedAt };
    }
    return {
      state: s.state,
      reasons: hasKey ? s.reasons : ['No Gemini key is configured on the server.', ...s.reasons],
      enabled: config.enabled,
      keyPresent: hasKey,
      model: config.models[0] ?? '',
      models: config.models,
      budgets: config.budgets,
      limits: config.limits,
      attestations,
      ...(a.observedFreeLimits ? { observedFreeLimits: { requestsPerDay: a.observedFreeLimits.requestsPerDay, requestsPerMinute: a.observedFreeLimits.requestsPerMinute, tokensPerMinute: a.observedFreeLimits.tokensPerMinute } } : {}),
      ...(s.spentDayNanos !== undefined ? { spentDayUsd: usd(s.spentDayNanos)!, spentMonthUsd: usd(s.spentMonthNanos)!, remainingDayUsd: usd(s.remainingDayNanos)!, remainingMonthUsd: usd(s.remainingMonthNanos)!, requestsToday: s.requestsToday ?? 0 } : {}),
      ...(s.unresolved ? { unresolved: s.unresolved.map((u) => ({ id: u.id, amountUsd: nanosToUsd(u.amountNanos), reason: u.reason })) } : {}),
      billing: s.billing,
    };
  }

  async setConfig(patch: unknown): Promise<Ok | Err> {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return err('Invalid settings.');
    const p = patch as Record<string, unknown>;
    const allowed = new Set(['enabled', 'models', 'budgets', 'limits']);
    for (const k of Object.keys(p)) if (!allowed.has(k)) return err(`"${k}" cannot be changed here.`);

    const cur = this.loadConfig();
    const next: GeminiConfig = { ...cur, attestations: { ...cur.attestations } };
    if (p['enabled'] !== undefined) {
      if (typeof p['enabled'] !== 'boolean') return err('"enabled" must be true or false.');
      next.enabled = p['enabled'];
    }
    if (p['models'] !== undefined) {
      if (!Array.isArray(p['models']) || p['models'].some((m) => typeof m !== 'string')) return err('"models" must be a list of model names.');
      const models = p['models'] as string[];
      if (models.some((m) => !(m in GEMINI_PRICE_TABLE))) return err('Only models with a known free tier and price can be used.');
      if (JSON.stringify(models) !== JSON.stringify(cur.models)) {
        // Free quotas differ per model, so a different model needs the quotas re-entered and the first request re-approved.
        next.models = models;
        delete next.attestations.observedFreeLimits;
        delete next.attestations.firstRequestApproved;
        delete next.attestations.modelsFreeOfCharge; // "free of charge" is a fact about one model
        next.enabled = false;
      }
    }
    for (const group of ['budgets', 'limits'] as const) {
      const v = p[group];
      if (v === undefined) continue;
      if (!v || typeof v !== 'object' || Array.isArray(v)) return err(`"${group}" must be an object.`);
      next[group] = { ...cur[group], ...(v as object) } as never;
    }
    const parsed = GeminiConfigSchema.safeParse(next);
    if (!parsed.success) return err(`Invalid value for ${parsed.error.issues[0]?.path.join('.') || 'settings'}.`);

    const problems = geminiConfigProblems(parsed.data);
    if (problems.length > 0) return err(problems[0]!);
    if (parsed.data.enabled) {
      const g = geminiGate(parsed.data)(Date.now());
      if (!g.ok) return err(`Cannot switch AI on yet: ${g.reasons[0]}`);
    }
    this.saveConfig(parsed.data);
    return { ok: true };
  }

  async attest(name: string, data: unknown): Promise<Ok | Err> {
    if (!(ATTEST_NAMES as readonly string[]).includes(name)) return err('Unknown confirmation.');
    const d = (data ?? {}) as Record<string, unknown>;
    if (d['acknowledged'] !== true) return err('You must tick the box to confirm.');
    const key = name as AttestName;
    const cfg = this.loadConfig();
    const confirmedAt = today(Date.now());
    const stamp = { confirmedAt, by: 'owner' as const };
    const a = { ...cfg.attestations };

    if (key === 'observedFreeLimits') {
      const n = (v: unknown, max: number): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= max ? v : undefined);
      const rpd = n(d['requestsPerDay'], 20_000);
      const rpm = n(d['requestsPerMinute'], 100);
      const tpm = n(d['tokensPerMinute'], 1_000_000);
      if (!rpd || !rpm || !tpm) return err('Enter the three free quotas exactly as AI Studio shows them (positive whole numbers).');
      a.observedFreeLimits = { ...stamp, requestsPerDay: rpd, requestsPerMinute: rpm, tokensPerMinute: tpm };
    } else if (key === 'firstRequestApproved') {
      for (const need of ['projectHasNoBilling', 'modelsFreeOfCharge', 'acceptsFreeTierDataUse', 'observedFreeLimits'] as const) if (!a[need]) return err('Confirm the four checks above before approving the first request.');
      if (!this.createProvider()) return err('The Gemini key is not set on the server yet.');
      const problems = geminiConfigProblems({ ...cfg, attestations: a });
      if (problems.length > 0) return err(problems[0]!);
      a.firstRequestApproved = stamp;
    } else {
      a[key] = stamp;
    }
    this.saveConfig({ ...cfg, attestations: a });
    return { ok: true };
  }

  async revoke(name: string): Promise<Ok | Err> {
    if (!(ATTEST_NAMES as readonly string[]).includes(name)) return err('Unknown confirmation.');
    const cfg = this.loadConfig();
    const a = { ...cfg.attestations };
    delete a[name as AttestName];
    // Withdrawing any confirmation also withdraws the first-request approval and switches AI off.
    if (name !== 'firstRequestApproved') delete a.firstRequestApproved;
    this.saveConfig({ ...cfg, attestations: a, enabled: false });
    return { ok: true };
  }

  async reconcile(id: string, usd: number): Promise<Ok | Err> {
    try {
      await this.guard().ai.reconcileUnresolved(id, usd);
      return { ok: true };
    } catch {
      return err('That call could not be found or the amount is not valid.');
    }
  }

  async resetPause(): Promise<Ok> {
    await this.guard().ai.resetPause();
    return { ok: true };
  }

  // ---- sessions and login throttle --------------------------------------------
  async epoch(): Promise<number> {
    return Number(this.get('epoch') ?? '1');
  }
  async bumpEpoch(): Promise<void> {
    this.put('epoch', String((await this.epoch()) + 1));
  }

  /**
   * Counts one wrong key from this address (an IPv6 address counts by its /64 network) and locks it after repeated failures,
   * with growing delays. One synchronous step, so parallel guesses are counted exactly. There is deliberately no global lock:
   * that would let anyone lock the owner out, and the key (256 random bits) is not guessable anyway.
   */
  async loginFailed(ip: string): Promise<{ locked: boolean; retryAfterSec: number }> {
    const now = Date.now();
    const key = await this.throttleKey(ip);
    const next = registerFailure(parseThrottle(this.get(key), now), now);
    this.put(key, JSON.stringify(next));
    this.forgetOldThrottles(now);
    return { locked: isLocked(next, now), retryAfterSec: retryAfterSeconds(next, now) };
  }

  async loginSucceeded(ip: string): Promise<void> {
    this.del(await this.throttleKey(ip));
  }

  private async throttleKey(ip: string): Promise<string> {
    return `throttle:${(await sha256Hex(ipBucket(ip))).slice(0, 16)}`;
  }

  /** Keeps the table small however many addresses an attacker uses: expired, long-quiet records are dropped. */
  private forgetOldThrottles(now: number): void {
    try {
      this.ctx.storage.sql.exec("DELETE FROM kv WHERE k LIKE 'throttle:%' AND json_extract(v, '$.lockedUntil') <= ? AND json_extract(v, '$.at') < ?", now, now - FORGIVE_AFTER_MS);
    } catch {
      /* housekeeping only: never let it break a login */
    }
  }
}

function toReply(r: AskResult): AiReply {
  if (!r.ok) return { ok: false, code: r.code, message: r.message, ...(r.reasons ? { reasons: r.reasons } : {}) };
  return { ok: true, text: r.text, costIsEstimate: r.costIsEstimate, shadowCostUsd: nanosToUsd(r.costNanos), remainingDayUsd: nanosToUsd(r.remainingDayNanos), remainingMonthUsd: nanosToUsd(r.remainingMonthNanos), ...(r.truncated ? { truncated: true } : {}) };
}
