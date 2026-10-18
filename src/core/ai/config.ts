import { z } from 'zod';
import { pricingFor, type ModelPricing } from './pricing';

/**
 * Owner configuration for the (optional) Claude provider, and the gate that decides whether any AI call may happen.
 *
 * The gate fails closed: a missing, stale, malformed or inconsistent setting means "AI is off", never "use a default".
 * Facts about the Anthropic Console (prepaid, no auto-reload, no invoicing…) cannot be read by this program, so they are
 * *attestations* typed in by the owner with a date. They are shown as "owner-attested, not verified by the app".
 */

export const ATTESTATION_MAX_AGE_DAYS = 30;

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Attestation = z.object({ confirmedAt: IsoDate, by: z.literal('owner') }).strict();

/** Hard ceilings: a typo in the config can lower the limits, never lift them past these. */
export const CEILINGS = {
  maxInputTokens: 100_000, // keeps Haiku in its cheaper (≤100k prompt) price tier
  maxOutputTokens: 8_192,
  maxRequestsPerDay: 2_000,
  maxRequestsPerMonth: 30_000,
  maxConcurrent: 4,
  maxUnresolved: 10,
  requestTimeoutMs: { min: 1_000, max: 60_000 },
} as const;

export const LimitsSchema = z
  .object({
    maxInputTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    maxRequestsPerDay: z.number().int().positive(),
    maxRequestsPerMonth: z.number().int().positive(),
    maxConcurrent: z.number().int().positive(),
    requestTimeoutMs: z.number().int().positive(),
    /** Calls whose outcome is unknown (timeouts, dropped connections) stay charged; this many in a row pause AI. */
    maxUnresolved: z.number().int().positive(),
  })
  .strict();
export type ConfigLimits = z.infer<typeof LimitsSchema>;

/** Reasons a set of limits is unsafe (empty = fine). Shared by every provider's gate. */
export function limitReasons(L: ConfigLimits): string[] {
  const r: string[] = [];
  if (L.maxInputTokens > CEILINGS.maxInputTokens) r.push(`maxInputTokens is above the built-in ceiling of ${CEILINGS.maxInputTokens}.`);
  if (L.maxOutputTokens > CEILINGS.maxOutputTokens) r.push(`maxOutputTokens is above the built-in ceiling of ${CEILINGS.maxOutputTokens}.`);
  if (L.maxRequestsPerDay > CEILINGS.maxRequestsPerDay) r.push(`maxRequestsPerDay is above the built-in ceiling of ${CEILINGS.maxRequestsPerDay}.`);
  if (L.maxRequestsPerMonth > CEILINGS.maxRequestsPerMonth) r.push(`maxRequestsPerMonth is above the built-in ceiling of ${CEILINGS.maxRequestsPerMonth}.`);
  if (L.maxConcurrent > CEILINGS.maxConcurrent) r.push(`maxConcurrent is above the built-in ceiling of ${CEILINGS.maxConcurrent}.`);
  if (L.maxUnresolved > CEILINGS.maxUnresolved) r.push(`maxUnresolved is above the built-in ceiling of ${CEILINGS.maxUnresolved}.`);
  if (L.requestTimeoutMs < CEILINGS.requestTimeoutMs.min || L.requestTimeoutMs > CEILINGS.requestTimeoutMs.max) r.push('requestTimeoutMs is outside the allowed range.');
  if (L.maxRequestsPerDay > L.maxRequestsPerMonth) r.push('maxRequestsPerDay is larger than maxRequestsPerMonth.');
  return r;
}

/** Reasons any dated confirmation in `attestations` is from the future or too old. */
export function attestationAgeReasons(attestations: object, now: number): string[] {
  const r: string[] = [];
  for (const [name, a] of Object.entries(attestations)) {
    if (a && typeof a === 'object' && 'confirmedAt' in a && typeof (a as { confirmedAt: unknown }).confirmedAt === 'string') {
      const age = ageDays((a as { confirmedAt: string }).confirmedAt, now);
      if (age < -1) r.push(`The confirmation "${name}" is dated in the future.`);
      else if (age > ATTESTATION_MAX_AGE_DAYS) r.push(`The confirmation "${name}" is older than ${ATTESTATION_MAX_AGE_DAYS} days; check again and re-confirm.`);
    }
  }
  return r;
}

export const AiConfigSchema = z
  .object({
    /** Master switch. Off by default; turning it on is still not enough (see evaluateGate). */
    enabled: z.boolean(),
    provider: z.literal('claude'),
    /** Models the app may call. Each must be in the price table; there is no fallback to another model. */
    models: z.array(z.string().min(1)).min(1).max(4),
    attestations: z
      .object({
        /** The Console organization is prepaid-only: not invoiced through Anthropic sales. */
        prepaidOrgNoInvoicing: Attestation.optional(),
        /** Auto-reload (automatic credit purchases) is switched off in Console → Billing. */
        autoReloadDisabled: Attestation.optional(),
        /** No credits have been purchased: the balance is only the plan's included monthly credits. */
        noPurchasedCredits: Attestation.optional(),
        /** No payment method was added to the Console organization. */
        noPaymentMethodAdded: Attestation.optional(),
        /** A dedicated Console workspace exists with a monthly spend limit set, and the API key belongs to it. */
        workspaceSpendLimit: Attestation.extend({ limitUsd: z.number().positive().max(10_000) }).strict().optional(),
        /** Dollars of API credit the Max plan grants per month ($100 for Max 5x, $200 for Max 20x). */
        includedCreditsUsd: z.number().positive().max(10_000).optional(),
      })
      .strict(),
    /** The `wrkspc_…` id of that workspace. Every response is checked against it; a mismatch trips the breaker. */
    expectedWorkspaceId: z.string().regex(/^wrkspc_[A-Za-z0-9]+$/).optional(),
    budgets: z.object({ dailyUsd: z.number().positive(), monthlyUsd: z.number().positive() }).strict(),
    limits: LimitsSchema,
  })
  .strict();

export type AiConfig = z.infer<typeof AiConfigSchema>;

/** Everything off, nothing attested. The only configuration the app ships with. */
export const DEFAULT_AI_CONFIG: AiConfig = {
  enabled: false,
  provider: 'claude',
  models: ['claude-haiku-5-5'],
  attestations: {},
  budgets: { dailyUsd: 1, monthlyUsd: 10 },
  limits: { maxInputTokens: 30_000, maxOutputTokens: 2_000, maxRequestsPerDay: 100, maxRequestsPerMonth: 1_000, maxConcurrent: 2, requestTimeoutMs: 30_000, maxUnresolved: 3 },
};

export type GateResult = { ok: true; config: AiConfig; prices: Record<string, ModelPricing> } | { ok: false; reasons: string[] };

const DAY_MS = 86_400_000;

function ageDays(isoDate: string, now: number): number {
  const t = Date.parse(`${isoDate}T00:00:00Z`);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : (now - t) / DAY_MS;
}

/** Why AI is (or is not) allowed to run right now. `ok` requires every single condition. */
export function evaluateGate(raw: unknown, now: number, priceTable?: Readonly<Record<string, ModelPricing>>): GateResult {
  const parsed = AiConfigSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reasons: ['The AI settings are missing or invalid, so AI stays off.'] };
  const c = parsed.data;
  const reasons: string[] = [];

  if (!c.enabled) reasons.push('AI is switched off.');

  const need: [string, boolean, string][] = [
    ['prepaidOrgNoInvoicing', !!c.attestations.prepaidOrgNoInvoicing, 'You have not confirmed that your Console organization is prepaid with no invoiced billing.'],
    ['autoReloadDisabled', !!c.attestations.autoReloadDisabled, 'You have not confirmed that automatic credit purchases (auto-reload) are off.'],
    ['noPurchasedCredits', !!c.attestations.noPurchasedCredits, 'You have not confirmed that no credits were purchased (only the included monthly credits).'],
    ['noPaymentMethodAdded', !!c.attestations.noPaymentMethodAdded, 'You have not confirmed that no payment method was added to the Console organization.'],
    ['workspaceSpendLimit', !!c.attestations.workspaceSpendLimit, 'You have not confirmed a dedicated Console workspace with a monthly spend limit.'],
    ['includedCreditsUsd', !!c.attestations.includedCreditsUsd, 'The monthly included credit amount of your plan is not set.'],
  ];
  for (const [, present, why] of need) if (!present) reasons.push(why);

  reasons.push(...attestationAgeReasons(c.attestations, now));

  const { dailyUsd, monthlyUsd } = c.budgets;
  if (dailyUsd > monthlyUsd) reasons.push('The daily budget is larger than the monthly budget.');
  const credits = c.attestations.includedCreditsUsd;
  if (credits !== undefined && monthlyUsd > credits) reasons.push('The monthly budget is larger than the included monthly credits.');
  const wsLimit = c.attestations.workspaceSpendLimit?.limitUsd;
  if (wsLimit !== undefined && monthlyUsd > wsLimit) reasons.push('The monthly budget is larger than the spend limit set on the Console workspace; the app limit must be the lower one.');
  if (c.attestations.workspaceSpendLimit && !c.expectedWorkspaceId) reasons.push('The Console workspace id (wrkspc_…) is not set, so responses cannot be checked against it.');

  reasons.push(...limitReasons(c.limits));

  const prices: Record<string, ModelPricing> = {};
  for (const m of c.models) {
    const p = pricingFor(m, priceTable);
    if (!p) reasons.push(`No price is known for model "${m}", so it cannot be used.`);
    else prices[m] = p;
  }

  return reasons.length === 0 ? { ok: true, config: c, prices } : { ok: false, reasons };
}

/**
 * Everything the guard needs to know about one provider, independent of which provider it is. Each provider's gate
 * (Claude: evaluateGate, Gemini: evaluateGeminiGate) produces one only when ALL of its conditions hold.
 */
export interface Policy {
  provider: 'claude' | 'gemini';
  models: string[];
  prices: Record<string, ModelPricing>;
  /** Dollars. For Gemini's free tier these are "shadow" dollars: what the same usage would cost on the paid tier. */
  budgets: { dailyUsd: number; monthlyUsd: number };
  limits: ConfigLimits;
  /** Claude only: every response must come from this Console workspace (the one holding the spend limit). */
  expectedWorkspaceId?: string;
}

export type PolicyResult = { ok: true; policy: Policy } | { ok: false; reasons: string[] };
/** Evaluated fresh on every call, so a confirmation that goes stale switches AI off without a restart. */
export type GateFn = (now: number) => PolicyResult;

export function claudeGate(raw: unknown, priceTable?: Readonly<Record<string, ModelPricing>>): GateFn {
  return (now) => {
    const g = evaluateGate(raw, now, priceTable);
    if (!g.ok) return g;
    const { config, prices } = g;
    return { ok: true, policy: { provider: 'claude', models: config.models, prices, budgets: config.budgets, limits: config.limits, ...(config.expectedWorkspaceId ? { expectedWorkspaceId: config.expectedWorkspaceId } : {}) } };
  };
}
