import { describe, expect, it } from 'vitest';
import { ATTESTATION_MAX_AGE_DAYS, CEILINGS, DEFAULT_AI_CONFIG, evaluateGate } from '../src/core/ai/config';
import { addSafe, formatUsd, mulSafe, NANOS_PER_USD, usdToNanos } from '../src/core/ai/money';
import { costOfUsage, PRICE_TABLE, pricingFor, worstCaseCost } from '../src/core/ai/pricing';
import { AiRequestSchema, inputTokenBound } from '../src/core/ai/request';
import { attestedConfig, NOW, REQ, REQ_RESERVATION } from './ai-helpers';

const haiku = PRICE_TABLE['claude-haiku-5-5']!;

describe('money', () => {
  it('uses exact integer nano-dollars and refuses unusable amounts', () => {
    expect(usdToNanos(1)).toBe(NANOS_PER_USD);
    expect(usdToNanos(0.0003)).toBe(300_000);
    for (const bad of [-1, NaN, Infinity, -0.000000001, 1e30]) expect(() => usdToNanos(bad as number)).toThrow();
    expect(() => usdToNanos('1' as unknown as number)).toThrow();
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(83_000)).toBe('$0.000083');
    expect(formatUsd(2_500_000_000)).toBe('$2.50');
  });

  it('refuses to add or multiply anything that is not a safe non-negative integer', () => {
    expect(addSafe(1, 2, 3)).toBe(6);
    expect(() => addSafe(1, -1)).toThrow();
    expect(() => addSafe(1, 0.5)).toThrow();
    expect(() => addSafe(Number.MAX_SAFE_INTEGER, 1)).toThrow();
    expect(() => mulSafe(Number.MAX_SAFE_INTEGER, 2)).toThrow();
    expect(() => mulSafe(NaN, 2)).toThrow();
  });
});

describe('pricing', () => {
  it('prices usage exactly from the official per-token rates', () => {
    // Haiku 5.5: $0.10 in / $0.50 out per million tokens → 100 and 500 nano-dollars per token.
    expect(costOfUsage(haiku, { inputTokens: 1000, outputTokens: 500, cacheWriteTokens: 0, cacheReadTokens: 0, webSearches: 0 })).toBe(350_000);
    // 1M in + 1M out on Sonnet 5.5 = $2 + $10.
    expect(costOfUsage(PRICE_TABLE['claude-sonnet-5-5']!, { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheWriteTokens: 0, cacheReadTokens: 0, webSearches: 0 })).toBe(12 * NANOS_PER_USD);
    // Cache reads are cheap, 1-hour cache writes dear, a web search is $0.01.
    expect(costOfUsage(haiku, { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1000, cacheReadTokens: 1000, webSearches: 2 })).toBe(200_000 + 10_000 + 20_000_000);
  });

  it('switches Haiku to its dearer tier above 100 000 prompt tokens', () => {
    const small = costOfUsage(haiku, { inputTokens: 100_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, webSearches: 0 });
    const big = costOfUsage(haiku, { inputTokens: 100_001, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, webSearches: 0 });
    expect(small).toBe(10_000_000);
    expect(big).toBe(50_000_500);
  });

  it('never guesses a price: unknown models have none, bad numbers throw', () => {
    expect(pricingFor('claude-made-up')).toBeUndefined();
    expect(pricingFor('__proto__')).toBeUndefined();
    expect(pricingFor('constructor')).toBeUndefined();
    expect(() => costOfUsage(haiku, { inputTokens: -1, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, webSearches: 0 })).toThrow();
    expect(() => costOfUsage(haiku, { inputTokens: 1.5, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, webSearches: 0 })).toThrow();
    expect(() => worstCaseCost(haiku, NaN, 10)).toThrow();
  });

  it('the reservation is an upper bound on any possible real cost', () => {
    // Deterministic pseudo-random sweep: any usage that fits within the bound and the output cap costs no more than the reservation.
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % (n + 1);
    };
    for (const [model, p] of Object.entries(PRICE_TABLE)) {
      for (let i = 0; i < 300; i++) {
        const bound = 100 + rnd(100_000);
        const maxOut = 1 + rnd(8000);
        const reserved = worstCaseCost(p, bound, maxOut);
        const input = rnd(bound);
        const cacheWrite = rnd(bound - input);
        const cacheRead = rnd(bound - input - cacheWrite);
        const actual = costOfUsage(p, { inputTokens: input, cacheWriteTokens: cacheWrite, cacheReadTokens: cacheRead, outputTokens: rnd(maxOut), webSearches: 0 });
        expect(actual, `${model} bound=${bound} out=${maxOut}`).toBeLessThanOrEqual(reserved);
      }
    }
  });

  it('REQ reserves exactly what the tests assume', () => {
    expect(worstCaseCost(haiku, inputTokenBound(REQ), REQ.maxOutputTokens)).toBe(REQ_RESERVATION);
  });
});

describe('request allowlist', () => {
  it('accepts plain text and rejects everything that could change the price', () => {
    expect(AiRequestSchema.safeParse(REQ).success).toBe(true);
    const bad: Record<string, unknown> = {
      tools: { ...REQ, tools: [{ name: 'web_search' }] },
      stream: { ...REQ, stream: true },
      thinking: { ...REQ, thinking: { type: 'enabled', budget_tokens: 5000 } },
      speed: { ...REQ, speed: 'fast' },
      geo: { ...REQ, inference_geo: 'us' },
      image: { ...REQ, messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] },
      systemRole: { ...REQ, messages: [{ role: 'system', content: 'x' }] },
      empty: { ...REQ, messages: [] },
      zeroOut: { ...REQ, maxOutputTokens: 0 },
      floatOut: { ...REQ, maxOutputTokens: 10.5 },
      purpose: { ...REQ, purpose: 'Not Valid!' },
      extraMessageKey: { ...REQ, messages: [{ role: 'user', content: 'x', cache_control: { type: 'ephemeral' } }] },
    };
    for (const [name, r] of Object.entries(bad)) expect(AiRequestSchema.safeParse(r).success, name).toBe(false);
  });

  it('bounds the prompt by its UTF-8 bytes, which can never be fewer than its tokens', () => {
    expect(inputTokenBound({ messages: [{ role: 'user', content: 'hi' }] })).toBe(64 + 2 + 16);
    expect(inputTokenBound({ system: 'abc', messages: [{ role: 'user', content: 'é' }] })).toBe(64 + 3 + 2 + 16); // é is 2 bytes
    expect(inputTokenBound({ messages: [{ role: 'user', content: '日本語' }] })).toBe(64 + 9 + 16);
  });
});

describe('the gate: AI runs only when every condition holds', () => {
  const day = 86_400_000;

  it('ships switched off and with nothing attested', () => {
    const g = evaluateGate(DEFAULT_AI_CONFIG, NOW);
    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.reasons.length).toBeGreaterThanOrEqual(7);
      expect(g.reasons.join(' ')).toMatch(/switched off/);
    }
  });

  it('opens with a complete, fresh, consistent configuration', () => {
    const g = evaluateGate(attestedConfig(), NOW);
    expect(g.ok).toBe(true);
  });

  it('is closed if ANY single confirmation is missing', () => {
    for (const key of ['prepaidOrgNoInvoicing', 'autoReloadDisabled', 'noPurchasedCredits', 'noPaymentMethodAdded', 'workspaceSpendLimit', 'includedCreditsUsd'] as const) {
      const c = attestedConfig();
      delete c.attestations[key];
      expect(evaluateGate(c, NOW).ok, key).toBe(false);
    }
    expect(evaluateGate(attestedConfig({ enabled: false }), NOW).ok).toBe(false);
    const noWs = attestedConfig();
    delete noWs.expectedWorkspaceId;
    expect(evaluateGate(noWs, NOW).ok).toBe(false);
  });

  it('is closed when confirmations are stale or from the future', () => {
    // the confirmations are dated 2026-10-15, so at NOW they are 1.5 days old
    expect(evaluateGate(attestedConfig(), NOW + (ATTESTATION_MAX_AGE_DAYS - 2) * day).ok).toBe(true);
    expect(evaluateGate(attestedConfig(), NOW + (ATTESTATION_MAX_AGE_DAYS + 2) * day).ok).toBe(false);
    expect(evaluateGate(attestedConfig(), NOW - 10 * day).ok).toBe(false);
  });

  it('is closed for inconsistent or unsafe budgets and limits', () => {
    expect(evaluateGate(attestedConfig({ budgets: { dailyUsd: 20, monthlyUsd: 10 } }), NOW).ok).toBe(false); // daily > monthly
    expect(evaluateGate(attestedConfig({ budgets: { dailyUsd: 1, monthlyUsd: 150 } }), NOW).ok).toBe(false); // above included credits
    expect(evaluateGate(attestedConfig({ budgets: { dailyUsd: 1, monthlyUsd: 60 } }), NOW).ok).toBe(false); // above the workspace limit
    expect(evaluateGate(attestedConfig({ budgets: { dailyUsd: 0, monthlyUsd: 10 } }), NOW).ok).toBe(false);
    expect(evaluateGate(attestedConfig({ budgets: { dailyUsd: -1, monthlyUsd: 10 } }), NOW).ok).toBe(false);
    for (const [k, v] of Object.entries({
      maxInputTokens: CEILINGS.maxInputTokens + 1,
      maxOutputTokens: CEILINGS.maxOutputTokens + 1,
      maxRequestsPerDay: CEILINGS.maxRequestsPerDay + 1,
      maxConcurrent: CEILINGS.maxConcurrent + 1,
      maxUnresolved: CEILINGS.maxUnresolved + 1,
      requestTimeoutMs: 500,
    })) {
      expect(evaluateGate(attestedConfig({ limits: { [k]: v } }), NOW).ok, k).toBe(false);
    }
    expect(evaluateGate(attestedConfig({ limits: { maxRequestsPerDay: 500, maxRequestsPerMonth: 100 } }), NOW).ok).toBe(false);
  });

  it('is closed for models without a known price and for malformed configuration', () => {
    expect(evaluateGate(attestedConfig({ models: ['claude-haiku-5-5', 'claude-unknown-9'] }), NOW).ok).toBe(false);
    expect(evaluateGate(undefined, NOW).ok).toBe(false);
    expect(evaluateGate(null, NOW).ok).toBe(false);
    expect(evaluateGate('enabled', NOW).ok).toBe(false);
    expect(evaluateGate({ ...attestedConfig(), surprise: true }, NOW).ok).toBe(false);
    expect(evaluateGate({ ...attestedConfig(), enabled: 'yes' }, NOW).ok).toBe(false);
    expect(evaluateGate({ ...attestedConfig(), provider: 'gemini' }, NOW).ok).toBe(false);
  });
});
