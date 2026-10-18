import { claudeGate, DEFAULT_AI_CONFIG, type AiConfig, type GateFn } from '../src/core/ai/config';
import { GuardedAi } from '../src/core/ai/guard';
import { MemoryBudgetStore } from '../src/core/ai/store';
import type { Provider, ProviderOutcome, ProviderRequest } from '../src/core/ai/provider';

/** 2026-10-16 12:00 UTC. */
export const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
export const WORKSPACE = 'wrkspc_testworkspace1';

/** A fully attested, switched-on config (what the owner must produce before any call can happen). */
export function attestedConfig(over: Omit<Partial<AiConfig>, 'budgets' | 'limits'> & { budgets?: Partial<AiConfig['budgets']>; limits?: Partial<AiConfig['limits']> } = {}): AiConfig {
  const a = { confirmedAt: '2026-10-15', by: 'owner' as const };
  return {
    ...DEFAULT_AI_CONFIG,
    enabled: true,
    attestations: {
      prepaidOrgNoInvoicing: a,
      autoReloadDisabled: a,
      noPurchasedCredits: a,
      noPaymentMethodAdded: a,
      workspaceSpendLimit: { ...a, limitUsd: 50 },
      includedCreditsUsd: 100,
    },
    expectedWorkspaceId: WORKSPACE,
    ...over,
    budgets: { ...DEFAULT_AI_CONFIG.budgets, ...over.budgets },
    limits: { ...DEFAULT_AI_CONFIG.limits, ...over.limits },
  };
}

export const REQ = { model: 'claude-haiku-5-5', purpose: 'tutor', messages: [{ role: 'user' as const, content: 'hi' }], maxOutputTokens: 100 };

/** Worst-case reservation of REQ on Haiku 5.5: ((82 bytes-bound × 200) + (100 × 500)) × 5/4. */
export const REQ_RESERVATION = 83_000;

export const okUsage = (input = 20, output = 30) => ({ input_tokens: input, output_tokens: output });
export const ok = (usage: unknown = okUsage(), extra: Partial<Extract<ProviderOutcome, { kind: 'ok' }>> = {}): ProviderOutcome => ({ kind: 'ok', text: 'an answer', usage, workspaceId: WORKSPACE, requestId: 'req_fake', ...extra });

export class FakeProvider implements Provider {
  calls = 0;
  last: ProviderRequest | undefined;
  constructor(public behavior: (n: number, signal: AbortSignal) => ProviderOutcome | Promise<ProviderOutcome> = () => ok()) {}
  async complete(req: ProviderRequest, signal: AbortSignal): Promise<ProviderOutcome> {
    this.calls += 1;
    this.last = req;
    return this.behavior(this.calls, signal);
  }
}

export function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export function setup(opts: { config?: unknown; gate?: GateFn; provider?: FakeProvider; now?: { t: number }; store?: MemoryBudgetStore } = {}) {
  const clock = opts.now ?? { t: NOW };
  const store = opts.store ?? new MemoryBudgetStore();
  const provider = opts.provider ?? new FakeProvider();
  let n = 0;
  const ai = new GuardedAi({ store, provider, gate: opts.gate ?? claudeGate(opts.config ?? attestedConfig()), now: () => clock.t, newId: () => `id-${++n}` });
  return { ai, store, provider, clock };
}
