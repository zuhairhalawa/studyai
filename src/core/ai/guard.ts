import type { GateFn, Policy } from './config';
import { advanceClock, commit, markUnresolved, reconcile, release, reserve, resetBreaker, startOfNextMonthUtc, trip, type Ledger, type Limits, type RejectCode, type Reserved } from './ledger';
import { addSafe, usdToNanos } from './money';
import { costOfUsage, worstCaseCost, type ModelPricing, type Usage } from './pricing';
import { parseUsage, type LimitKind, type Provider, type ProviderOutcome } from './provider';
import { AiRequestSchema, inputTokenBound, type AiRequest } from './request';
import { BudgetUnknownError, type BudgetStore } from './store';
import { nextPacificMidnight } from './time';

/**
 * The only way the app may call an AI model. Every call goes through the same fixed sequence and fails closed:
 *
 *   gate (owner confirmations, switch, limits) → validate the request → reserve worst-case cost atomically
 *   → call the provider (with a timeout) → settle to the real usage, refund only a definite refusal.
 *
 * If any step cannot be completed or its result cannot be trusted, the call does not happen (or stays charged).
 * Offline study features never import this module; when AI is paused they are unaffected.
 */

export type AskCode = 'disabled' | 'invalid-request' | 'model-not-allowed' | 'too-large' | 'budget-unknown' | RejectCode | 'provider-rejected' | 'outcome-unknown';

export type AskResult =
  | { ok: true; text: string; costNanos: number; usage?: Usage; /** True when the cost is the full reservation because usage could not be read. */ costIsEstimate: boolean; remainingDayNanos: number; remainingMonthNanos: number; requestId?: string; /** The model stopped at the output cap, so the text is cut off. */ truncated?: boolean }
  | { ok: false; code: AskCode; message: string; reasons?: string[] };

export interface GuardDeps {
  store: BudgetStore;
  provider: Provider;
  /** The provider's gate (claudeGate / geminiGate): evaluated on every call; anything but ok means off. */
  gate: GateFn;
  now?: () => number;
  newId?: () => string;
}

export function toLimits(p: Policy): Limits {
  return {
    dailyNanos: usdToNanos(p.budgets.dailyUsd),
    monthlyNanos: usdToNanos(p.budgets.monthlyUsd),
    maxRequestsPerDay: p.limits.maxRequestsPerDay,
    maxRequestsPerMonth: p.limits.maxRequestsPerMonth,
    maxConcurrent: p.limits.maxConcurrent,
    maxUnresolved: p.limits.maxUnresolved,
  };
}

/** How a refusal that talks about limits pauses AI, and what the owner is told. */
function applyLimit(l: Ledger, limit: LimitKind | undefined, t: number): void {
  switch (limit) {
    case 'spend-limit':
      return trip(l, 'limit', 'the Console spend limit was reached. It resumes when the limit resets (start of next month, UTC) or you raise it.', t, startOfNextMonthUtc(t));
    case 'credits':
      return trip(l, 'limit', 'the Console credit balance is used up. Credits arrive again with your next billing cycle; then reset the pause.', t);
    case 'quota-day':
      return trip(l, 'limit', 'the free daily quota is used up. AI resumes at midnight Pacific time.', t, nextPacificMidnight(t));
    case 'quota-minute':
      return trip(l, 'limit', 'a per-minute limit was reached. AI resumes in a minute.', t, t + 60_000);
    case 'billing-signal':
      return trip(l, 'anomaly', 'the provider mentioned billing or prepaid credit, so a billing account may be linked to this project. Check AI Studio → Projects; AI stays off until you reset it.', t);
    case 'no-free-tier':
      return trip(l, 'anomaly', 'the provider says the free tier is not available here. Do not enable billing to fix this; AI stays off until you reset it.', t);
    default:
      return;
  }
}

const OFF_MESSAGE = 'AI is off. Everything else in the app still works.';

export class GuardedAi {
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: GuardDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
  }

  async ask(raw: unknown): Promise<AskResult> {
    const now = this.now();
    let gate: ReturnType<GateFn>;
    try {
      gate = this.deps.gate(now);
    } catch {
      return { ok: false, code: 'disabled', message: OFF_MESSAGE, reasons: ['The AI settings could not be evaluated, so AI stays off.'] };
    }
    if (!gate.ok) return { ok: false, code: 'disabled', message: OFF_MESSAGE, reasons: gate.reasons };
    const { policy } = gate;

    const parsed = AiRequestSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: 'invalid-request', message: 'The request is not in an allowed form (plain text only; no tools, images or extra options).' };
    const req = parsed.data;
    if (!policy.models.includes(req.model)) return { ok: false, code: 'model-not-allowed', message: `The model "${req.model}" is not on your allowed list.` };
    const pricing = policy.prices[req.model];
    if (!pricing) return { ok: false, code: 'model-not-allowed', message: `No price is known for "${req.model}".` };

    const bound = inputTokenBound(req);
    if (bound > policy.limits.maxInputTokens) return { ok: false, code: 'too-large', message: 'The question is too long for the input limit. Ask about a smaller part.' };
    if (req.maxOutputTokens > policy.limits.maxOutputTokens) return { ok: false, code: 'too-large', message: 'The requested answer length is above the output limit.' };

    let amount: number;
    let limits: Limits;
    try {
      amount = worstCaseCost(pricing, bound, req.maxOutputTokens);
      limits = toLimits(policy);
    } catch {
      return unknown();
    }

    const id = this.newId();
    let reserved: Reserved;
    try {
      reserved = await this.deps.store.transact(now, (l) => reserve(l, { id, now, amount, model: req.model, purpose: req.purpose, inputBound: bound, maxOutput: req.maxOutputTokens }, limits));
    } catch {
      return unknown();
    }
    if (!reserved.ok) return { ok: false, code: reserved.code, message: reserved.message };

    // From here on the money is set aside; every exit path below settles or deliberately keeps it charged.
    const outcome = await this.callProvider(policy, req);
    return this.settle({ id, policy, limits, pricing, amount, outcome });
  }

  private async callProvider(policy: Policy, req: AiRequest): Promise<ProviderOutcome> {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ProviderOutcome>((resolve) => {
      timer = setTimeout(() => {
        ctl.abort();
        resolve({ kind: 'unknown', message: 'The request timed out. It may or may not have been billed.' });
      }, policy.limits.requestTimeoutMs);
    });
    try {
      const call = this.deps.provider
        .complete({ model: req.model, maxOutputTokens: req.maxOutputTokens, messages: req.messages, ...(req.system ? { system: req.system } : {}), ...(req.temperature !== undefined ? { temperature: req.temperature } : {}) }, ctl.signal)
        .catch((): ProviderOutcome => ({ kind: 'unknown', message: 'The provider call failed unexpectedly. It may or may not have been billed.' }));
      return await Promise.race([call, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async settle(a: { id: string; policy: Policy; limits: Limits; pricing: ModelPricing; amount: number; outcome: ProviderOutcome }): Promise<AskResult> {
    const { id, policy, limits, pricing, amount, outcome } = a;
    const t = this.now();
    try {
      if (outcome.kind === 'ok') {
        const usage = parseUsage(outcome.usage);
        let cost: number | undefined;
        if (usage) {
          try {
            cost = addSafe(costOfUsage(pricing, usage), outcome.extraCostNanos ?? 0);
          } catch {
            cost = undefined;
          }
        }
        const expected = policy.expectedWorkspaceId;
        const wrongWorkspace = expected !== undefined && outcome.workspaceId !== expected;
        return await this.deps.store.transact(t, (l): AskResult => {
          advanceClock(l, t);
          let costNanos: number;
          let estimate = false;
          if (usage && cost !== undefined) {
            costNanos = cost;
            commit(l, { id, now: t, costNanos, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheWriteTokens: usage.cacheWriteTokens, cacheReadTokens: usage.cacheReadTokens, ...(outcome.requestId ? { providerRequestId: outcome.requestId } : {}) });
          } else {
            // The call ran and was billed, but we cannot read what it cost: keep the full reservation charged.
            costNanos = amount;
            estimate = true;
            markUnresolved(l, id, 'The answer did not report usable token counts, so its cost is unknown.', t, limits.maxUnresolved);
          }
          if (wrongWorkspace) trip(l, 'anomaly', 'a response came from a different Console workspace than the one with the spend limit, or did not say which.', t);
          if (outcome.anomaly) trip(l, 'anomaly', outcome.anomaly, t);
          return {
            ok: true,
            text: outcome.text,
            costNanos,
            costIsEstimate: estimate,
            ...(usage ? { usage } : {}),
            remainingDayNanos: Math.max(0, limits.dailyNanos - l.spentDay),
            remainingMonthNanos: Math.max(0, limits.monthlyNanos - l.spentMonth),
            ...(outcome.requestId ? { requestId: outcome.requestId } : {}),
            ...(outcome.truncated ? { truncated: true } : {}),
          };
        });
      }

      if (outcome.kind === 'rejected') {
        await this.deps.store.transact(t, (l) => {
          advanceClock(l, t);
          release(l, id, outcome.message, t);
          applyLimit(l, outcome.limit, t);
        });
        return { ok: false, code: 'provider-rejected', message: outcome.limit ? 'AI is paused: the provider says a limit was reached or flagged a billing problem. Study features still work.' : `The AI service refused the request: ${outcome.message}` };
      }

      await this.deps.store.transact(t, (l) => {
        advanceClock(l, t);
        markUnresolved(l, id, outcome.message, t, limits.maxUnresolved);
      });
      return { ok: false, code: 'outcome-unknown', message: 'The AI request did not finish cleanly. To be safe it is counted as spent until you check the Console usage page.' };
    } catch {
      // Could not record the result. The reservation stays open (still counted), so no budget is freed.
      return { ok: false, code: 'budget-unknown', message: 'The result could not be recorded, so it was discarded and AI is paused until the budget store recovers.' };
    }
  }

  /** What the settings screen shows. Read-only; never used to decide whether a call may run. */
  async status(): Promise<AiStatus> {
    const now = this.now();
    let gate: ReturnType<GateFn>;
    try {
      gate = this.deps.gate(now);
    } catch {
      return { state: 'off', reasons: ['The AI settings could not be evaluated, so AI stays off.'], billing: 'owner-attestation-required' };
    }
    if (!gate.ok) return { state: 'off', reasons: gate.reasons, billing: 'owner-attestation-required' };
    const policy = gate.policy;
    let l: Ledger;
    try {
      l = await this.deps.store.read(now);
    } catch (e) {
      return { state: 'unknown', reasons: [e instanceof BudgetUnknownError ? e.message : 'The budget could not be read.'], billing: 'owner-attested-not-verified' };
    }
    const lim = toLimits(policy);
    const clock = advanceClock(l, now);
    const reasons: string[] = [];
    if (!clock.ok) reasons.push(clock.message);
    if (l.breaker) reasons.push(l.breaker.reason);
    const remainingDay = Math.max(0, lim.dailyNanos - l.spentDay);
    const remainingMonth = Math.max(0, lim.monthlyNanos - l.spentMonth);
    if (remainingDay === 0) reasons.push('Today’s AI budget is used up.');
    if (remainingMonth === 0) reasons.push('This month’s AI budget is used up.');
    if (Object.keys(l.unresolved).length >= lim.maxUnresolved) reasons.push('Too many calls have an unknown outcome.');
    let state: AiStatus['state'] = reasons.length ? 'paused' : 'ready';
    if (state === 'ready') {
      // Is there still room for a maximum-size request on the cheapest allowed model? If not, say so before it is refused.
      const cheapest = Math.min(...Object.values(policy.prices).map((p) => worstCaseCost(p, policy.limits.maxInputTokens, policy.limits.maxOutputTokens)));
      if (remainingDay < cheapest) reasons.push('Only a small amount is left of today’s AI budget; large questions may be refused.');
      else if (remainingMonth < cheapest) reasons.push('Only a small amount is left of this month’s AI budget; large questions may be refused.');
      if (reasons.length) state = 'low';
    }
    return {
      state,
      reasons,
      billing: 'owner-attested-not-verified',
      spentDayNanos: l.spentDay,
      spentMonthNanos: l.spentMonth,
      remainingDayNanos: remainingDay,
      remainingMonthNanos: remainingMonth,
      requestsToday: l.requestsDay,
      unresolved: Object.values(l.unresolved).map((u) => ({ id: u.id, amountNanos: u.amount, reason: u.reason })),
    };
  }

  /** Owner action (the Worker authenticates the owner before calling this): replace a pessimistic charge with the Console's figure. */
  async reconcileUnresolved(id: string, actualUsd: number): Promise<void> {
    const t = this.now();
    const actual = usdToNanos(actualUsd);
    await this.deps.store.transact(t, (l) => {
      advanceClock(l, t);
      reconcile(l, id, actual, t);
    });
  }

  /** Owner action: lift a pause after checking the Console. */
  async resetPause(): Promise<void> {
    const t = this.now();
    await this.deps.store.transact(t, (l) => {
      advanceClock(l, t);
      resetBreaker(l);
    });
  }
}

export interface AiStatus {
  /** off: not allowed to run · ready · low: little budget left · paused: budget/limit/breaker stops calls · unknown: budget unreadable. */
  state: 'off' | 'ready' | 'low' | 'paused' | 'unknown';
  reasons: string[];
  /** The app cannot read Console billing; this is always "attested by the owner", never "verified". */
  billing: 'owner-attestation-required' | 'owner-attested-not-verified';
  spentDayNanos?: number;
  spentMonthNanos?: number;
  remainingDayNanos?: number;
  remainingMonthNanos?: number;
  requestsToday?: number;
  unresolved?: { id: string; amountNanos: number; reason: string }[];
}

function unknown(): AskResult {
  return { ok: false, code: 'budget-unknown', message: 'AI is paused: the remaining budget cannot be determined safely.' };
}
