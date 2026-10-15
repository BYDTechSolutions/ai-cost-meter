import { UsageError } from './types.js';

/** A spending limit over a calendar window (UTC). */
export interface Budget {
  /** Name used in events and checks. Default `<tag or "global">/<window>`. */
  id?: string;
  /**
   * Which calls count. Omit for every call (a global budget). An exact tag
   * such as `feature:search` counts calls carrying it. A tag ending in `:*`,
   * such as `user:*`, is one budget per value: `user:1` and `user:2` each
   * get the full limit.
   */
  tag?: string;
  /** `day` resets at 00:00 UTC, `month` on the 1st at 00:00 UTC. */
  window: 'day' | 'month';
  /** Limit in USD. */
  limitUsd: number;
}

/** Sent to `onBudget` when spending first reaches 80% and 100% of a limit in a window. */
export interface BudgetEvent {
  budgetId: string;
  /** The tag the spending was counted under, or null for a global budget. */
  tag: string | null;
  window: 'day' | 'month';
  /** The window, as `YYYY-MM-DD` or `YYYY-MM`. */
  period: string;
  /** 0.8 or 1. */
  threshold: number;
  spentUsd: number;
  limitUsd: number;
}

/** One budget's state, as returned by `meter.check()`. */
export interface BudgetStatus {
  budgetId: string;
  tag: string | null;
  window: 'day' | 'month';
  period: string;
  spentUsd: number;
  limitUsd: number;
  remainingUsd: number;
  /** True when this budget blocks the call. */
  exceeded: boolean;
}

export const THRESHOLDS = [0.8, 1] as const;

/** A budget with its id filled in. */
export interface NormalizedBudget {
  id: string;
  tag?: string;
  window: 'day' | 'month';
  limitUsd: number;
}

/** Validates budgets and fills in their ids. */
export function normalizeBudgets(budgets: Budget[] | undefined): NormalizedBudget[] {
  const out: NormalizedBudget[] = [];
  const ids = new Set<string>();
  (budgets ?? []).forEach((b, i) => {
    const where = `budgets[${i}]`;
    if (typeof b !== 'object' || b === null) throw new UsageError(`${where} must be an object`);
    if (b.window !== 'day' && b.window !== 'month') throw new UsageError(`${where}.window must be "day" or "month"`);
    if (typeof b.limitUsd !== 'number' || !Number.isFinite(b.limitUsd) || b.limitUsd <= 0) {
      throw new UsageError(`${where}.limitUsd must be a number > 0`);
    }
    if (b.tag !== undefined && (typeof b.tag !== 'string' || b.tag === '' || b.tag === '*' || (b.tag.includes('*') && !b.tag.endsWith(':*')))) {
      throw new UsageError(`${where}.tag must be a tag, or a prefix ending in ":*"`);
    }
    const id = b.id ?? `${b.tag ?? 'global'}/${b.window}`;
    if (ids.has(id)) throw new UsageError(`${where}: duplicate budget id "${id}"`);
    ids.add(id);
    out.push({ id, window: b.window, limitUsd: b.limitUsd, ...(b.tag !== undefined ? { tag: b.tag } : {}) });
  });
  return out;
}

/** The window a date falls in. */
export function periodOf(window: 'day' | 'month', at: Date): string {
  const iso = at.toISOString();
  return window === 'day' ? iso.slice(0, 10) : iso.slice(0, 7);
}

/** The concrete tags a budget applies to for a call with these tags: [null] for global. */
export function scopesFor(budget: { tag?: string }, tags: readonly string[]): (string | null)[] {
  if (budget.tag === undefined) return [null];
  if (budget.tag.endsWith(':*')) {
    const prefix = budget.tag.slice(0, -1);
    return [...new Set(tags.filter((t) => t.startsWith(prefix) && t.length > prefix.length))];
  }
  return tags.includes(budget.tag) ? [budget.tag] : [];
}

/** The store key of a budget counter. */
export function counterKey(budgetId: string, scope: string | null, period: string): string {
  return `budget\u0000${budgetId}\u0000${scope ?? ''}\u0000${period}`;
}
