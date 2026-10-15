import type { MeterRecord } from './types.js';

type MaybePromise<T> = T | Promise<T>;

/**
 * Where a meter keeps budget counters and recorded calls. The default is
 * {@link memoryStore}. To share budgets across processes, implement this
 * over Redis, a database or a file; every method may return a promise.
 * `increment` must be atomic and return the new total, so that exactly one
 * caller sees a budget threshold being crossed.
 */
export interface MeterStore {
  /** Adds `amount` to the counter at `key` (missing counters start at 0) and returns the new total. */
  increment(key: string, amount: number): MaybePromise<number>;
  /** Returns the counter at `key`, or 0. */
  get(key: string): MaybePromise<number>;
  /** Keeps a recorded call for `meter.summary()`. */
  append(record: MeterRecord): MaybePromise<void>;
  /** Returns kept calls, oldest first. */
  records(): MaybePromise<MeterRecord[]>;
}

/** Options for {@link memoryStore}. */
export interface MemoryStoreOptions {
  /** Most calls kept for summaries; the oldest are dropped first. Default 100000. Counters are never dropped. */
  maxRecords?: number;
}

/** A store that lives in this process's memory. Counters and records are lost on exit. */
export function memoryStore(opts: MemoryStoreOptions = {}): MeterStore {
  const max = opts.maxRecords ?? 100_000;
  if (!Number.isInteger(max) || max < 0) throw new TypeError('maxRecords must be an integer >= 0');
  const counters = new Map<string, number>();
  let kept: MeterRecord[] = [];
  return {
    increment(key, amount) {
      const next = (counters.get(key) ?? 0) + amount;
      counters.set(key, next);
      return next;
    },
    get(key) {
      return counters.get(key) ?? 0;
    },
    append(record) {
      if (max === 0) return;
      kept.push(record);
      // Trim in chunks so a full store does not shift the array on every call.
      if (kept.length > max + Math.max(1, Math.floor(max / 10))) kept = kept.slice(kept.length - max);
    },
    records() {
      return kept.length > max ? kept.slice(kept.length - max) : kept.slice();
    },
  };
}
