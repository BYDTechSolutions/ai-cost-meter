import { UsageError, type MeterRecord } from './types.js';

/** Options for {@link summarize} and `meter.summary()`. */
export interface SummaryOptions {
  /** Group by model (`provider/model`), by tag, or by UTC day. Default `model`. */
  groupBy?: 'model' | 'tag' | 'day';
  /** With `groupBy: 'tag'`, only tags starting with this prefix form groups (for example `user:`). */
  tagPrefix?: string;
  /** Only calls at or after this time. */
  since?: Date;
  /** Only calls before this time. */
  until?: Date;
}

/** One group of a summary. */
export interface SummaryGroup {
  key: string;
  calls: number;
  /** Sum of the known costs in this group. */
  costUsd: number;
  /** Calls whose cost is unknown (null) and therefore not in `costUsd`. */
  unpricedCalls: number;
  /** All input tokens: uncached, cached, cache writes and audio. */
  inputTokens: number;
  /** The part of `inputTokens` read from the cache. */
  cachedInputTokens: number;
  outputTokens: number;
}

/** A summary of recorded calls. */
export interface Summary {
  groupBy: 'model' | 'tag' | 'day';
  calls: number;
  costUsd: number;
  unpricedCalls: number;
  /** Sorted by cost, highest first, then by key (by date for `day`). With `groupBy: 'tag'`, a call with several tags counts in each. */
  groups: SummaryGroup[];
}

/** The group a call lands in when it has no tag that matches. */
export const UNTAGGED = '(untagged)';

function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Summarizes recorded calls (from a store or a JSONL log). */
export function summarize(records: readonly MeterRecord[], opts: SummaryOptions = {}): Summary {
  const groupBy = opts.groupBy ?? 'model';
  if (!['model', 'tag', 'day'].includes(groupBy)) throw new UsageError('groupBy must be "model", "tag" or "day"');
  const since = opts.since?.getTime();
  const until = opts.until?.getTime();
  const groups = new Map<string, SummaryGroup>();
  const total = { calls: 0, costUsd: 0, unpricedCalls: 0 };
  for (const r of records) {
    const t = Date.parse(r.ts);
    if (since !== undefined && !(t >= since)) continue;
    if (until !== undefined && !(t < until)) continue;
    let keys: string[];
    if (groupBy === 'model') keys = [r.provider ? `${r.provider}/${r.model}` : r.model];
    else if (groupBy === 'day') keys = [Number.isNaN(t) ? 'invalid-date' : new Date(t).toISOString().slice(0, 10)];
    else {
      const prefix = opts.tagPrefix ?? '';
      const tags = [...new Set((r.tags ?? []).filter((x) => x.startsWith(prefix)))];
      keys = tags.length ? tags : [UNTAGGED];
    }
    const u = r.usage ?? {};
    const input =
      n(u.inputTokens) + n(u.cachedInputTokens) + n(u.cacheWriteTokens) + n(u.cacheWrite1hTokens) + n(u.audioInputTokens) + n(u.cachedAudioInputTokens);
    const cached = n(u.cachedInputTokens) + n(u.cachedAudioInputTokens);
    const priced = typeof r.costUsd === 'number';
    total.calls += 1;
    if (priced) total.costUsd += r.costUsd as number;
    else total.unpricedCalls += 1;
    for (const key of keys) {
      let g = groups.get(key);
      if (!g) {
        g = { key, calls: 0, costUsd: 0, unpricedCalls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
        groups.set(key, g);
      }
      g.calls += 1;
      if (priced) g.costUsd += r.costUsd as number;
      else g.unpricedCalls += 1;
      g.inputTokens += input;
      g.cachedInputTokens += cached;
      g.outputTokens += n(u.outputTokens);
    }
  }
  const sorted = [...groups.values()].sort((a, b) =>
    groupBy === 'day' ? (a.key < b.key ? -1 : 1) : b.costUsd - a.costUsd || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  return { groupBy, ...total, groups: sorted };
}
