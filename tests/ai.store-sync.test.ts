import { describe, expect, it } from 'vitest';
import { GuardedAi } from '../src/core/ai/guard';
import { claudeGate } from '../src/core/ai/config';
import { SyncBudgetStore, type SyncStorage } from '../src/core/ai/store';
import { attestedConfig, deferred, FakeProvider, NOW, ok, REQ } from './ai-helpers';

function memory(initial?: string): SyncStorage & { value: string | undefined; failLoad?: boolean; failSave?: boolean; saves: number } {
  const s = {
    value: initial,
    saves: 0,
    failLoad: false,
    failSave: false,
    load() {
      if (s.failLoad) throw new Error('disk');
      return s.value;
    },
    save(json: string) {
      if (s.failSave) throw new Error('disk');
      s.value = json;
      s.saves += 1;
    },
  };
  return s;
}

describe('SyncBudgetStore (what the Durable Object runs)', () => {
  it('persists across instances and validates what it reads', async () => {
    const io = memory();
    const a = new SyncBudgetStore(io);
    await a.transact(NOW, (l) => {
      l.spentDay = 123;
      l.spentMonth = 123;
    });
    expect((await new SyncBudgetStore(io).read(NOW)).spentDay).toBe(123);
  });

  it('fails closed: unreadable, invalid or failing storage means no transaction and nothing saved', async () => {
    for (const bad of ['not json', '{}', JSON.stringify({ v: 1 }), JSON.stringify({ ...JSON.parse(JSON.stringify((await new SyncBudgetStore(memory()).read(NOW)))), spentDay: -1 })]) {
      const io = memory(bad);
      let ran = false;
      await expect(new SyncBudgetStore(io).transact(NOW, () => (ran = true))).rejects.toThrow();
      expect(ran).toBe(false);
      expect(io.value).toBe(bad);
    }
    const io = memory();
    io.failLoad = true;
    await expect(new SyncBudgetStore(io).transact(NOW, () => 1)).rejects.toThrow();
    io.failLoad = false;
    io.failSave = true;
    await expect(new SyncBudgetStore(io).transact(NOW, (l) => (l.spentDay = 5))).rejects.toThrow();
    expect(io.value).toBeUndefined();
  });

  it('discards an update that would make the ledger invalid', async () => {
    const io = memory();
    const s = new SyncBudgetStore(io);
    await expect(s.transact(NOW, (l) => (l.spentDay = -5))).rejects.toThrow();
    expect(io.value).toBeUndefined();
    await expect(s.transact(NOW, () => {
      throw new Error('boom');
    })).rejects.toThrow();
    expect(io.saves).toBe(0);
  });

  it('is atomic: simultaneous reservations through the guard never exceed the budget', async () => {
    const gate = deferred<void>();
    const provider = new FakeProvider(async () => {
      await gate.promise;
      return ok();
    });
    const io = memory();
    const ai = new GuardedAi({ store: new SyncBudgetStore(io), provider, gate: claudeGate(attestedConfig({ budgets: { dailyUsd: 0.00017, monthlyUsd: 1 }, limits: { maxConcurrent: 4 } })), now: () => NOW, newId: (() => { let n = 0; return () => `id-${++n}`; })() });
    const all = Array.from({ length: 10 }, () => ai.ask(REQ));
    await new Promise((r) => setTimeout(r, 20));
    expect(provider.calls).toBe(2);
    gate.resolve();
    const results = await Promise.all(all);
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(JSON.parse(io.value!).spentDay).toBe(2 * (20 * 100 + 30 * 500));
  });
});
