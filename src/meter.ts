import { THRESHOLDS, counterKey, normalizeBudgets, periodOf, scopesFor, type Budget, type BudgetEvent, type BudgetStatus } from './budgets.js';
import { normalizeUsage, priceCall } from './cost.js';
import { createPriceBook, defaultPrices, mergePrices, validatePrices, type PriceBook } from './prices.js';
import { memoryStore, type MeterStore } from './store.js';
import { summarize, type Summary, type SummaryOptions } from './summary.js';
import {
  USAGE_KEYS,
  UnknownPriceError,
  UsageError,
  type CostInput,
  type CostResult,
  type MeterRecord,
  type PriceDataset,
  type PriceEntry,
  type Usage,
} from './types.js';

/** Options for {@link createMeter}. Every field is optional. */
export interface MeterOptions {
  /** Your own prices, merged over the bundled ones (same provider and model replaces). */
  prices?: PriceDataset | PriceEntry[];
  /** Use the bundled dataset. Default true; false uses only `prices`. */
  defaultPrices?: boolean;
  /** Spending limits, checked on every `record()`. */
  budgets?: Budget[];
  /** Called once when a budget's spending first reaches 80% and once at 100% in each window. */
  onBudget?: (event: BudgetEvent) => void | Promise<void>;
  /** Called with every recorded call, after the store has it. Use `jsonlLogger(file)` to write a log. */
  onRecord?: (record: MeterRecord) => void | Promise<void>;
  /** Where counters and records live. Default: a new `memoryStore()`. */
  store?: MeterStore;
  /**
   * What to do when a price is missing (unknown model, or no batch or
   * long-context price listed): `warn` returns `costUsd: null` and warns,
   * `throw` throws {@link UnknownPriceError}. Default `warn`.
   */
  unknownModel?: 'warn' | 'throw';
  /** Receives each distinct warning once. Default: `process.emitWarning`. */
  onWarning?: (message: string) => void;
  /** Clock, for tests and replays. Default `() => new Date()`. */
  now?: () => Date;
}

/** What `meter.record()` takes: a priced call plus tags. */
export interface RecordInput extends CostInput {
  /** Free-form labels such as `user:123` or `feature:search`, for budgets and summaries. */
  tags?: string[];
}

/** What `meter.check()` returns. */
export interface CheckResult {
  /** False when any budget that applies to these tags is used up (or would be by `estimateUsd`). */
  ok: boolean;
  budgets: BudgetStatus[];
}

/** A cost meter. Create one with {@link createMeter}. */
export interface Meter {
  /** Prices a call, keeps it in the store, updates budgets and calls `onRecord`. */
  record(input: RecordInput): Promise<CostResult>;
  /** Prices a call without recording it. */
  estimate(input: CostInput): CostResult;
  /** Reports the budgets that apply to a call with these tags, so you can refuse it before it is made. */
  check(tags?: string[], opts?: { estimateUsd?: number; at?: Date }): Promise<CheckResult>;
  /** Summarizes the calls kept in the store. */
  summary(opts?: SummaryOptions): Promise<Summary>;
  /** The merged price dataset in use. */
  readonly prices: PriceDataset;
}

function defaultWarn(message: string): void {
  process.emitWarning(message, 'AiCostMeterWarning');
}

function checkTags(tags: unknown): string[] {
  if (tags === undefined) return [];
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string' || t === '')) {
    throw new UsageError('tags must be an array of non-empty strings');
  }
  return [...new Set(tags as string[])];
}

function compactUsage(u: Required<Usage>): Usage {
  const out: Usage = {};
  for (const k of USAGE_KEYS) if (u[k] !== 0) out[k] = u[k];
  return out;
}

/** Builds the price book a meter or estimate uses. */
export function buildPriceBook(prices?: PriceDataset | PriceEntry[], useDefaults = true): PriceBook {
  const sets: PriceDataset[] = [];
  if (useDefaults) sets.push(defaultPrices());
  if (prices !== undefined) sets.push(validatePrices(prices));
  if (sets.length === 0) throw new UsageError('no prices: pass prices or leave defaultPrices on');
  return createPriceBook(sets.length === 1 ? sets[0]! : mergePrices(...sets));
}

let bundledBook: PriceBook | undefined;

/**
 * Prices one call against the bundled prices (or your own) with no meter,
 * store or budgets. Never throws for a missing price: `costUsd` is null and
 * `warnings` says why.
 */
export function estimateCost(input: CostInput, opts: { prices?: PriceDataset | PriceEntry[]; defaultPrices?: boolean } = {}): CostResult {
  let book: PriceBook;
  if (opts.prices === undefined && opts.defaultPrices !== false) book = bundledBook ??= buildPriceBook();
  else book = buildPriceBook(opts.prices, opts.defaultPrices !== false);
  const { missing, ...result } = priceCall(book, input);
  if (missing) result.warnings.push(missing);
  return result;
}

/** Creates a meter. See {@link MeterOptions} for every option and its default. */
export function createMeter(opts: MeterOptions = {}): Meter {
  const book = buildPriceBook(opts.prices, opts.defaultPrices !== false);
  const budgets = normalizeBudgets(opts.budgets);
  const store = opts.store ?? memoryStore();
  const now = opts.now ?? (() => new Date());
  const policy = opts.unknownModel ?? 'warn';
  if (policy !== 'warn' && policy !== 'throw') throw new UsageError('unknownModel must be "warn" or "throw"');
  const warn = opts.onWarning ?? defaultWarn;
  const seen = new Set<string>();
  const emit = (messages: string[]) => {
    for (const m of messages) {
      if (seen.has(m)) continue;
      if (seen.size < 10_000) seen.add(m);
      warn(m);
    }
  };

  const price = (input: CostInput, at: Date): CostResult => {
    const { missing, ...result } = priceCall(book, { ...input, at });
    if (missing) {
      if (policy === 'throw') throw new UnknownPriceError(missing);
      result.warnings.push(missing);
    }
    emit(result.warnings);
    return result;
  };

  return {
    prices: book.dataset,

    estimate(input) {
      return price(input, input.at ?? now());
    },

    async record(input) {
      if (typeof input !== 'object' || input === null) throw new UsageError('expected { model, usage, tags? }');
      const tags = checkTags(input?.tags);
      const at = input.at ?? now();
      const result = price(input, at);
      const record: MeterRecord = {
        ts: at.toISOString(),
        provider: result.provider,
        model: input.model,
        tags,
        usage: compactUsage(normalizeUsage(input.usage)),
        batch: input.batch === true,
        costUsd: result.costUsd,
        breakdown: result.breakdown,
        warnings: result.warnings,
      };
      await store.append(record);
      const cost = result.costUsd;
      if (cost !== null && cost > 0) {
        for (const b of budgets) {
          const period = periodOf(b.window, at);
          for (const scope of scopesFor(b, tags)) {
            const total = await store.increment(counterKey(b.id, scope, period), cost);
            const before = total - cost;
            for (const t of THRESHOLDS) {
              const line = b.limitUsd * t;
              if (before < line && total >= line && opts.onBudget) {
                await opts.onBudget({ budgetId: b.id, tag: scope, window: b.window, period, threshold: t, spentUsd: total, limitUsd: b.limitUsd });
              }
            }
          }
        }
      }
      if (opts.onRecord) await opts.onRecord(record);
      return result;
    },

    async check(tags, o = {}) {
      const list = checkTags(tags);
      const estimate = o.estimateUsd ?? 0;
      if (typeof estimate !== 'number' || !Number.isFinite(estimate) || estimate < 0) {
        throw new UsageError('estimateUsd must be a number >= 0');
      }
      const at = o.at ?? now();
      const statuses: BudgetStatus[] = [];
      for (const b of budgets) {
        const period = periodOf(b.window, at);
        for (const scope of scopesFor(b, list)) {
          const spent = await store.get(counterKey(b.id, scope, period));
          const exceeded = spent >= b.limitUsd || (estimate > 0 && spent + estimate > b.limitUsd);
          statuses.push({
            budgetId: b.id,
            tag: scope,
            window: b.window,
            period,
            spentUsd: spent,
            limitUsd: b.limitUsd,
            remainingUsd: Math.max(0, b.limitUsd - spent),
            exceeded,
          });
        }
      }
      return { ok: statuses.every((s) => !s.exceeded), budgets: statuses };
    },

    async summary(o) {
      return summarize(await store.records(), o);
    },
  };
}
