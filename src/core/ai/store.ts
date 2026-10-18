import { LedgerSchema, newLedger, type Ledger } from './ledger';

/**
 * Where the ledger lives. The contract is what makes reservations safe under concurrency:
 *
 *   transact(fn) runs `fn` on the current ledger as ONE indivisible step. No other transact can interleave, and the
 *   result is saved only if `fn` returns normally and the ledger still validates. If anything throws (including a
 *   storage failure or a ledger that fails validation) nothing is saved and the caller must treat the budget as unknown.
 *
 * `MemoryBudgetStore` implements this for tests and local use. In the Worker the same interface is implemented by a
 * Durable Object (single-threaded, SQLite-backed), which gives the same one-at-a-time guarantee across requests.
 */
export interface BudgetStore {
  transact<T>(now: number, fn: (ledger: Ledger) => T): Promise<T>;
  /** A validated snapshot for display. Never used to make a spending decision. */
  read(now: number): Promise<Ledger>;
}

export class BudgetUnknownError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'BudgetUnknownError';
  }
}

export class MemoryBudgetStore implements BudgetStore {
  private state: unknown;
  private queue: Promise<unknown> = Promise.resolve();
  /** Test hooks: make the next transaction fail the way a broken disk or a Durable Object error would. */
  failNext: Error | undefined;

  constructor(initial?: unknown) {
    this.state = initial;
  }

  /** Test hook: replace the stored state with anything, including garbage. */
  setRaw(raw: unknown): void {
    this.state = raw;
  }

  transact<T>(now: number, fn: (ledger: Ledger) => T): Promise<T> {
    const run = async (): Promise<T> => {
      if (this.failNext) {
        const e = this.failNext;
        this.failNext = undefined;
        throw new BudgetUnknownError('The budget store failed.', e);
      }
      const current = this.state === undefined ? newLedger(now) : this.state;
      const parsed = LedgerSchema.safeParse(structuredClone(current));
      if (!parsed.success) throw new BudgetUnknownError('The stored budget is damaged, so spending cannot be tracked.', parsed.error);
      const working = parsed.data;
      const result = fn(working);
      const check = LedgerSchema.safeParse(working);
      if (!check.success) throw new BudgetUnknownError('The budget update was inconsistent and was discarded.', check.error);
      this.state = structuredClone(check.data);
      return result;
    };
    // One at a time, in arrival order; a failure must not block the queue.
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async read(now: number): Promise<Ledger> {
    const current = this.state === undefined ? newLedger(now) : this.state;
    const parsed = LedgerSchema.safeParse(structuredClone(current));
    if (!parsed.success) throw new BudgetUnknownError('The stored budget is damaged, so spending cannot be tracked.', parsed.error);
    return parsed.data;
  }
}

/** Synchronous persistence the Durable Object (or a test) provides. Both calls must be all-or-nothing. */
export interface SyncStorage {
  load(): string | undefined;
  save(json: string): void;
}

/**
 * A BudgetStore over synchronous storage. `transact` has NO await between reading the ledger and writing it back, so
 * in a single-threaded Durable Object no other request can interleave: reservations are atomic by construction. Any
 * failure (storage error, unreadable or invalid ledger, an update that does not validate) means nothing is saved and
 * the caller must treat the budget as unknown.
 */
export class SyncBudgetStore implements BudgetStore {
  constructor(private readonly io: SyncStorage) {}

  private load(now: number): Ledger {
    let raw: string | undefined;
    try {
      raw = this.io.load();
    } catch (e) {
      throw new BudgetUnknownError('The budget store failed.', e);
    }
    let value: unknown;
    try {
      value = raw === undefined ? newLedger(now) : JSON.parse(raw);
    } catch (e) {
      throw new BudgetUnknownError('The stored budget is damaged, so spending cannot be tracked.', e);
    }
    const parsed = LedgerSchema.safeParse(value);
    if (!parsed.success) throw new BudgetUnknownError('The stored budget is damaged, so spending cannot be tracked.', parsed.error);
    return parsed.data;
  }

  transact<T>(now: number, fn: (ledger: Ledger) => T): Promise<T> {
    try {
      const working = this.load(now);
      const result = fn(working);
      const check = LedgerSchema.safeParse(working);
      if (!check.success) throw new BudgetUnknownError('The budget update was inconsistent and was discarded.', check.error);
      try {
        this.io.save(JSON.stringify(check.data));
      } catch (e) {
        throw new BudgetUnknownError('The budget store failed.', e);
      }
      return Promise.resolve(result);
    } catch (e) {
      return Promise.reject(e instanceof BudgetUnknownError ? e : new BudgetUnknownError('The budget could not be updated.', e));
    }
  }

  read(now: number): Promise<Ledger> {
    try {
      return Promise.resolve(this.load(now));
    } catch (e) {
      return Promise.reject(e);
    }
  }
}
