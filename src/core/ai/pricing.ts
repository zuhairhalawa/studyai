import { addSafe, isNonNegativeInt, mulSafe } from './money';

/**
 * Anthropic's list prices, as integer nano-dollars per token.
 * Source: https://platform.claude.com/docs/en/about-claude/pricing — read on 2026-10-16.
 * Prices can change: the owner re-checks this table when attesting (see docs/FINANCIAL-SAFETY.md), and a model that
 * is not in the table can never be called. The table is deliberately small: only models the app may use.
 */
export interface Price {
  input: number;
  output: number;
  /** Writing to the prompt cache, 1-hour tier (the dearer one). The app never asks for caching; this prices it defensively. */
  cacheWrite: number;
  cacheRead: number;
}

export interface ModelPricing {
  /** Prices for prompts up to `longAbove` tokens. */
  standard: Price;
  /** Prices for prompts above `longAbove` tokens (only some models have a dearer tier). */
  long?: Price;
  longAbove?: number;
  /** Date the owner/assistant last compared these numbers with the official page. */
  checkedOn: string;
}

export const PRICE_CHECKED_ON = '2026-10-16';

export const PRICE_TABLE: Readonly<Record<string, ModelPricing>> = {
  // $0.10 in / $0.50 out per MTok (up to 100k-token prompts); $0.50 / $2.50 above that.
  'claude-haiku-5-5': {
    standard: { input: 100, output: 500, cacheWrite: 200, cacheRead: 10 },
    long: { input: 500, output: 2_500, cacheWrite: 1_000, cacheRead: 50 },
    longAbove: 100_000,
    checkedOn: PRICE_CHECKED_ON,
  },
  // $2 in / $10 out per MTok.
  'claude-sonnet-5-5': { standard: { input: 2_000, output: 10_000, cacheWrite: 4_000, cacheRead: 100 }, checkedOn: PRICE_CHECKED_ON },
  // $4 in / $20 out per MTok.
  'claude-opus-5-5': { standard: { input: 4_000, output: 20_000, cacheWrite: 8_000, cacheRead: 200 }, checkedOn: PRICE_CHECKED_ON },
  // $10 in / $50 out per MTok.
  'claude-fable-5-1': { standard: { input: 10_000, output: 50_000, cacheWrite: 20_000, cacheRead: 250 }, checkedOn: PRICE_CHECKED_ON },
};

/** A web search costs $10 per 1 000 searches on top of tokens. The app never enables tools, but a reported search is still charged. */
export const WEB_SEARCH_NANOS_EACH = 10_000_000;

/** Reservations are inflated by 5/4 so small estimation errors can never make a request cost more than was set aside. */
export const RESERVE_NUM = 5;
export const RESERVE_DEN = 4;

export function pricingFor(model: string, table: Readonly<Record<string, ModelPricing>> = PRICE_TABLE): ModelPricing | undefined {
  return Object.prototype.hasOwnProperty.call(table, model) ? table[model] : undefined;
}

/** The dearest price that could apply to a prompt of up to `inputTokens` tokens. */
export function priceCeiling(p: ModelPricing, inputTokens: number): Price {
  return p.long && p.longAbove !== undefined && inputTokens > p.longAbove ? p.long : p.standard;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  webSearches: number;
}

/** Exact cost of reported usage at the price tier the prompt size selects. Throws if any figure is not a sane integer. */
export function costOfUsage(p: ModelPricing, u: Usage): number {
  const total = addSafe(u.inputTokens, u.cacheWriteTokens, u.cacheReadTokens);
  const price = priceCeiling(p, total);
  return addSafe(
    mulSafe(u.inputTokens, price.input),
    mulSafe(u.outputTokens, price.output),
    mulSafe(u.cacheWriteTokens, price.cacheWrite),
    mulSafe(u.cacheReadTokens, price.cacheRead),
    mulSafe(u.webSearches, WEB_SEARCH_NANOS_EACH),
  );
}

/**
 * The most a request can cost: every input token at the dearest input class, every allowed output token generated.
 * `inputTokenBound` is an upper bound on the prompt (see estimate.ts), `maxOutputTokens` is the cap sent to the API.
 */
export function worstCaseCost(p: ModelPricing, inputTokenBound: number, maxOutputTokens: number): number {
  if (!isNonNegativeInt(inputTokenBound) || !isNonNegativeInt(maxOutputTokens)) throw new RangeError('token counts must be non-negative integers');
  const price = priceCeiling(p, inputTokenBound);
  // The dearest class per token covers an input that is (wrongly) billed as a cache write.
  const perInput = Math.max(price.input, price.cacheWrite);
  const raw = addSafe(mulSafe(inputTokenBound, perInput), mulSafe(maxOutputTokens, price.output));
  return Math.ceil(mulSafe(raw, RESERVE_NUM) / RESERVE_DEN);
}
