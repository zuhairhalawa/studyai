import { z } from 'zod';
import { attestationAgeReasons, limitReasons, LimitsSchema, type GateFn } from './config';
import { PRICE_CHECKED_ON, pricingFor, type ModelPricing } from './pricing';

/**
 * Gemini Free Tier. There is no money balance to meter on the free tier, so two independent protections apply:
 *
 *  1. Quotas: the app's own limits are held well below the free quotas the owner reads in AI Studio (the API does not
 *     publish them), and a quota error pauses AI until the quota resets.
 *  2. A "shadow" dollar budget: every call is priced at Google's *paid-tier* per-token rates, and daily/monthly budgets in
 *     those shadow dollars are enforced exactly like real money. On the free tier the shadow cost is never charged, but if
 *     a billing account were ever linked to the project by mistake, this app alone could still cost at most the shadow
 *     monthly budget (hard ceiling $5).
 *
 * Facts (official pages, read 2026-10-16): free→paid only happens if the owner links a billing account and prepays;
 * free-tier content may be used to improve Google products; requests-per-day resets at midnight Pacific; Google Search
 * and Maps grounding are billed per query beyond a small free allowance (so tools are never enabled).
 */

/** Paid-tier text prices in nano-dollars per token, from https://ai.google.dev/gemini-api/docs/pricing. Models whose
 *  price rises on 2027-01-01 (3.6 Flash, 3.8 Flash) carry the higher price. Only models with a free tier are listed. */
export const GEMINI_PRICE_TABLE: Readonly<Record<string, ModelPricing>> = {
  'gemini-2.5-flash-lite': { standard: { input: 100, output: 400, cacheWrite: 100, cacheRead: 10 }, checkedOn: PRICE_CHECKED_ON },
  'gemini-2.5-flash': { standard: { input: 300, output: 2_500, cacheWrite: 300, cacheRead: 30 }, checkedOn: PRICE_CHECKED_ON },
  'gemini-3.1-flash-lite': { standard: { input: 250, output: 1_500, cacheWrite: 250, cacheRead: 25 }, checkedOn: PRICE_CHECKED_ON },
  'gemini-3.5-flash-lite': { standard: { input: 300, output: 2_500, cacheWrite: 300, cacheRead: 30 }, checkedOn: PRICE_CHECKED_ON },
  'gemini-3.6-flash': { standard: { input: 1_500, output: 7_500, cacheWrite: 1_500, cacheRead: 150 }, checkedOn: PRICE_CHECKED_ON },
  'gemini-3.8-flash': { standard: { input: 1_500, output: 7_500, cacheWrite: 1_500, cacheRead: 150 }, checkedOn: PRICE_CHECKED_ON },
};

/** Shadow budgets can never be set above these, whatever the configuration says. */
export const GEMINI_CEILINGS = { dailyUsd: 1, monthlyUsd: 5 } as const;

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Attestation = z.object({ confirmedAt: IsoDate, by: z.literal('owner') }).strict();

export const GeminiConfigSchema = z
  .object({
    enabled: z.boolean(),
    provider: z.literal('gemini'),
    models: z.array(z.string().min(1)).min(1).max(3),
    attestations: z
      .object({
        /** AI Studio → Projects shows this key's project with Billing Tier "Free": no billing account has ever been linked. */
        projectHasNoBilling: Attestation.optional(),
        /** Each allowed model is listed "Free of charge" for input and output on the official pricing page. */
        modelsFreeOfCharge: Attestation.optional(),
        /** You accept that free-tier content may be used by Google to improve its products. */
        acceptsFreeTierDataUse: Attestation.optional(),
        /** The free quotas AI Studio shows for the allowed models (the API does not publish them). */
        /** You approved the very first real request to Google. Nothing real is sent before this, and it expires like the others. */
        firstRequestApproved: Attestation.optional(),
        observedFreeLimits: Attestation.extend({ requestsPerDay: z.number().int().positive(), requestsPerMinute: z.number().int().positive(), tokensPerMinute: z.number().int().positive() }).strict().optional(),
      })
      .strict(),
    /** Shadow dollars: the paid-tier price of the same usage. Not money unless billing is wrongly linked. */
    budgets: z.object({ dailyUsd: z.number().positive(), monthlyUsd: z.number().positive() }).strict(),
    limits: LimitsSchema,
  })
  .strict();

export type GeminiConfig = z.infer<typeof GeminiConfigSchema>;

/** Everything off, nothing attested. */
export const DEFAULT_GEMINI_CONFIG: GeminiConfig = {
  enabled: false,
  provider: 'gemini',
  // gemini-3.1-flash-lite: free 15 requests/min, 250K tokens/min, 500 requests/day (read in AI Studio on 2026-10-16).
  // Other text models on the free tier allow only 20 requests/day, which is too few for studying.
  models: ['gemini-3.1-flash-lite'],
  attestations: {},
  budgets: { dailyUsd: 0.5, monthlyUsd: 3 },
  limits: { maxInputTokens: 60_000, maxOutputTokens: 4_000, maxRequestsPerDay: 100, maxRequestsPerMonth: 1_500, maxConcurrent: 2, requestTimeoutMs: 45_000, maxUnresolved: 5 },
};

/**
 * Problems with the numbers and models themselves (budgets, limits, model list, and how they relate to the free quotas the
 * owner entered). Used by the gate and, before saving, by the settings screen, so an unsafe value is refused when typed.
 */
export function geminiConfigProblems(c: GeminiConfig, priceTable: Readonly<Record<string, ModelPricing>> = GEMINI_PRICE_TABLE): string[] {
  const reasons: string[] = [];
  const { dailyUsd, monthlyUsd } = c.budgets;
  if (dailyUsd > monthlyUsd) reasons.push('The daily budget is larger than the monthly budget.');
  if (dailyUsd > GEMINI_CEILINGS.dailyUsd) reasons.push(`The daily shadow budget is above the built-in ceiling of $${GEMINI_CEILINGS.dailyUsd}.`);
  if (monthlyUsd > GEMINI_CEILINGS.monthlyUsd) reasons.push(`The monthly shadow budget is above the built-in ceiling of $${GEMINI_CEILINGS.monthlyUsd}.`);

  reasons.push(...limitReasons(c.limits));
  const f = c.attestations.observedFreeLimits;
  if (f) {
    // Our day is UTC and Google's resets at Pacific midnight, so across their day we may use up to two of ours: stay under half.
    if (c.limits.maxRequestsPerDay * 2 > f.requestsPerDay) reasons.push('maxRequestsPerDay must be at most half of the free requests-per-day quota.');
    if (c.limits.maxInputTokens * c.limits.maxConcurrent * 2 > f.tokensPerMinute) reasons.push('maxInputTokens × maxConcurrent must be at most half of the free tokens-per-minute quota.');
  }
  for (const m of c.models) if (!pricingFor(m, priceTable)) reasons.push(`"${m}" is not a model with a known free tier and price, so it cannot be used.`);
  return reasons;
}

export function geminiGate(raw: unknown, priceTable: Readonly<Record<string, ModelPricing>> = GEMINI_PRICE_TABLE): GateFn {
  return (now) => {
    const parsed = GeminiConfigSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reasons: ['The Gemini settings are missing or invalid, so AI stays off.'] };
    const c = parsed.data;
    const a = c.attestations;
    const reasons: string[] = [];

    if (!c.enabled) reasons.push('AI is switched off.');
    if (!a.projectHasNoBilling) reasons.push('You have not confirmed in AI Studio → Projects that this key’s project has no billing account (Billing Tier: Free).');
    if (!a.modelsFreeOfCharge) reasons.push('You have not confirmed that the allowed models are "Free of charge" on Google’s pricing page.');
    if (!a.acceptsFreeTierDataUse) reasons.push('You have not accepted that free-tier content may be used to improve Google products.');
    if (!a.observedFreeLimits) reasons.push('The free quotas shown in AI Studio have not been entered, so the app cannot keep its limits below them.');
    if (!a.firstRequestApproved) reasons.push('You have not approved the first real request to Google yet.');
    reasons.push(...attestationAgeReasons(a, now));
    reasons.push(...geminiConfigProblems(c, priceTable));

    if (reasons.length > 0) return { ok: false, reasons };
    const prices: Record<string, ModelPricing> = {};
    for (const m of c.models) prices[m] = pricingFor(m, priceTable)!;
    return { ok: true, policy: { provider: 'gemini', models: c.models, prices, budgets: c.budgets, limits: c.limits } };
  };
}
