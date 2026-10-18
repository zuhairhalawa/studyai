import type { SyncStorage } from '../../src/core/ai/store';

/** The two operations the spend ledger needs from the Durable Object's key-value table. */
export interface KvLike {
  get(key: string): string | undefined;
  put(key: string, value: string): void;
}

/**
 * Where the spend ledger lives. A ledger that has been written once must never "disappear": if its row is missing after
 * that, storage was damaged or tampered with, so the budget is unknown (not zero) and the guard refuses to spend.
 */
export function ledgerStorage(kv: KvLike): SyncStorage {
  return {
    load: () => {
      const raw = kv.get('ledger');
      if (raw === undefined && kv.get('ledger:started') !== undefined) throw new Error('the spend ledger is missing');
      return raw;
    },
    save: (json) => {
      kv.put('ledger', json);
      kv.put('ledger:started', '1');
    },
  };
}
