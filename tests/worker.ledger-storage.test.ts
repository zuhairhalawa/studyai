import { describe, expect, it } from 'vitest';
import { SyncBudgetStore } from '../src/core/ai/store';
import { ledgerStorage, type KvLike } from '../worker/src/ledger-storage';
import { NOW } from './ai-helpers';

function memoryKv(): KvLike & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return { rows, get: (k) => rows.get(k), put: (k, v) => void rows.set(k, v) };
}

describe('where the Durable Object keeps the spend ledger', () => {
  it('starts empty on first use, then persists what the guard saves', async () => {
    const kv = memoryKv();
    const first = new SyncBudgetStore(ledgerStorage(kv));
    await first.transact(NOW, (l) => {
      l.spentDay = 777;
      l.spentMonth = 777;
    });
    expect(kv.rows.has('ledger')).toBe(true);
    expect((await new SyncBudgetStore(ledgerStorage(kv)).read(NOW)).spentDay).toBe(777);
  });

  it('treats a ledger that has vanished after being used as an UNKNOWN budget, not a fresh zero', async () => {
    const kv = memoryKv();
    await new SyncBudgetStore(ledgerStorage(kv)).transact(NOW, (l) => {
      l.spentDay = 123;
    });
    kv.rows.delete('ledger'); // damage or tampering: the row is gone but the marker is still there
    const store = new SyncBudgetStore(ledgerStorage(kv));
    await expect(store.read(NOW)).rejects.toThrow();
    let ran = false;
    await expect(store.transact(NOW, () => (ran = true))).rejects.toThrow();
    expect(ran).toBe(false);
    expect(kv.rows.has('ledger')).toBe(false); // nothing was silently re-created
  });

  it('does not mistake a brand-new Durable Object for a damaged one', async () => {
    await expect(new SyncBudgetStore(ledgerStorage(memoryKv())).read(NOW)).resolves.toMatchObject({ spentDay: 0 });
  });
});
