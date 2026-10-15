import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  UnknownPriceError,
  createMeter,
  jsonlLogger,
  memoryStore,
  parseJsonl,
  readJsonl,
  summarize,
  type BudgetEvent,
  type MeterRecord,
  type MeterStore,
} from '../src/index.js';

/** A clock the test moves by hand. */
function clock(start: string) {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    set: (iso: string) => {
      t = new Date(iso).getTime();
    },
  };
}

// claude-sonnet-4-6 output is $15 per million tokens: 100,000 output tokens cost $1.50.
const call = (tags: string[] = [], outputTokens = 100_000) => ({
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  usage: { outputTokens },
  tags,
});

describe('record', () => {
  it('returns the cost and breakdown and keeps a record', async () => {
    const c = clock('2026-10-16T09:00:00Z');
    const seen: MeterRecord[] = [];
    const meter = createMeter({ now: c.now, onRecord: (r) => void seen.push(r) });
    const r = await meter.record(call(['user:1', 'feature:search', 'user:1']));
    expect(r.costUsd).toBeCloseTo(1.5, 12);
    expect(r.breakdown?.lines.outputTokens?.tokens).toBe(100_000);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      ts: '2026-10-16T09:00:00.000Z',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      tags: ['user:1', 'feature:search'],
      usage: { outputTokens: 100_000 },
      batch: false,
    });
  });

  it('rejects bad tags and bad usage before recording anything', async () => {
    const meter = createMeter();
    await expect(meter.record({ ...call(), tags: [''] })).rejects.toThrow(/tags/);
    await expect(meter.record({ model: 'gpt-5', usage: { inputTokens: -5 } })).rejects.toThrow(/inputTokens/);
    expect((await meter.summary()).calls).toBe(0);
  });
});

describe('unknown models', () => {
  it('warns once and records costUsd null by default, never 0', async () => {
    const warnings: string[] = [];
    const meter = createMeter({ onWarning: (m) => void warnings.push(m) });
    const a = await meter.record({ model: 'gpt-2', usage: { inputTokens: 100 } });
    await meter.record({ model: 'gpt-2', usage: { inputTokens: 100 } });
    expect(a.costUsd).toBeNull();
    expect(a.warnings).toEqual(['no price for model "gpt-2" in the price data']);
    expect(warnings).toEqual(['no price for model "gpt-2" in the price data']);
    const s = await meter.summary();
    expect(s).toMatchObject({ calls: 2, costUsd: 0, unpricedCalls: 2 });
  });

  it('throws UnknownPriceError when configured, for unknown models and missing batch prices', async () => {
    const meter = createMeter({ unknownModel: 'throw' });
    await expect(meter.record({ model: 'gpt-2', usage: {} })).rejects.toBeInstanceOf(UnknownPriceError);
    expect(() => meter.estimate({ model: 'gpt-3.5-turbo', batch: true, usage: {} })).toThrow(/no batch price/);
    expect(meter.estimate({ model: 'gpt-5', usage: { inputTokens: 1_000_000 } }).costUsd).toBeCloseTo(1.25, 12);
  });

  it('uses custom prices merged over the bundled ones', async () => {
    const meter = createMeter({
      prices: [{ provider: 'anthropic', model: 'claude-sonnet-4-6', input_per_mtok: 1, output_per_mtok: 1 }],
      onWarning: () => {},
    });
    expect((await meter.record(call())).costUsd).toBeCloseTo(0.1, 12);
    expect(meter.estimate({ model: 'gpt-5', usage: { inputTokens: 1_000_000 } }).costUsd).toBeCloseTo(1.25, 12);
    const only = createMeter({ prices: [{ provider: 'x', model: 'y', input_per_mtok: 1, output_per_mtok: 1 }], defaultPrices: false, onWarning: () => {} });
    expect(only.estimate({ model: 'gpt-5', usage: {} }).costUsd).toBeNull();
  });
});

describe('budgets', () => {
  it('fires onBudget once at 80% and once at 100% per window, and resets the next UTC day', async () => {
    const c = clock('2026-10-16T08:00:00Z');
    const events: BudgetEvent[] = [];
    const meter = createMeter({
      now: c.now,
      budgets: [{ window: 'day', limitUsd: 5 }],
      onBudget: (e) => void events.push(e),
    });
    await meter.record(call()); // 1.50
    await meter.record(call()); // 3.00
    expect(events).toEqual([]);
    await meter.record(call()); // 4.50: crosses 80%
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ budgetId: 'global/day', tag: null, window: 'day', period: '2026-10-16', threshold: 0.8, limitUsd: 5 });
    expect(events[0]!.spentUsd).toBeCloseTo(4.5, 12);
    await meter.record(call()); // 6.00: crosses 100%
    await meter.record(call()); // 7.50: nothing new
    expect(events.map((e) => e.threshold)).toEqual([0.8, 1]);
    expect((await meter.check()).ok).toBe(false);

    c.set('2026-10-16T23:59:59Z');
    expect((await meter.check()).ok).toBe(false);
    c.set('2026-10-17T00:00:00Z');
    const fresh = await meter.check();
    expect(fresh.ok).toBe(true);
    expect(fresh.budgets[0]).toMatchObject({ period: '2026-10-17', spentUsd: 0, remainingUsd: 5, exceeded: false });
    await meter.record(call(undefined, 300_000)); // 4.50 in one call: 80% only
    expect(events.map((e) => [e.period, e.threshold])).toEqual([
      ['2026-10-16', 0.8],
      ['2026-10-16', 1],
      ['2026-10-17', 0.8],
    ]);
  });

  it('fires both thresholds when one call jumps past both', async () => {
    const events: BudgetEvent[] = [];
    const meter = createMeter({ budgets: [{ window: 'month', limitUsd: 1 }], onBudget: (e) => void events.push(e) });
    await meter.record(call());
    expect(events.map((e) => e.threshold)).toEqual([0.8, 1]);
  });

  it('keeps monthly windows by UTC calendar month', async () => {
    const c = clock('2026-10-31T23:30:00Z');
    const meter = createMeter({ now: c.now, budgets: [{ window: 'month', limitUsd: 2 }] });
    await meter.record(call());
    expect((await meter.check()).budgets[0]).toMatchObject({ period: '2026-10' });
    expect((await meter.check()).budgets[0]!.spentUsd).toBeCloseTo(1.5, 12);
    c.set('2026-11-01T00:00:00Z');
    expect((await meter.check()).budgets[0]).toMatchObject({ period: '2026-11', spentUsd: 0 });
    // A call can be recorded into a past window with `at`.
    await meter.record({ ...call(), at: new Date('2026-10-15T00:00:00Z') });
    expect((await meter.check([], { at: new Date('2026-10-20T00:00:00Z') })).ok).toBe(false);
  });

  it('counts tagged budgets only for calls with the tag, and `user:*` separately per user', async () => {
    const events: BudgetEvent[] = [];
    const meter = createMeter({
      budgets: [
        { tag: 'feature:search', window: 'day', limitUsd: 10 },
        { tag: 'user:*', window: 'day', limitUsd: 2 },
      ],
      onBudget: (e) => void events.push(e),
    });
    await meter.record(call(['user:1', 'feature:search']));
    await meter.record(call(['user:2']));
    await meter.record(call(['user:1']));
    expect(events.map((e) => [e.budgetId, e.tag, e.threshold])).toEqual([
      ['user:*/day', 'user:1', 0.8],
      ['user:*/day', 'user:1', 1],
    ]);
    const u1 = await meter.check(['user:1', 'feature:search']);
    expect(u1.ok).toBe(false);
    expect(u1.budgets.map((b) => [b.budgetId, b.tag, b.exceeded])).toEqual([
      ['feature:search/day', 'feature:search', false],
      ['user:*/day', 'user:1', true],
    ]);
    expect((await meter.check(['user:2'])).ok).toBe(true);
    expect((await meter.check(['user:3'])).budgets[0]).toMatchObject({ tag: 'user:3', spentUsd: 0 });
    expect((await meter.check([])).budgets).toEqual([]);
  });

  it('blocks a call whose estimate would go over the limit', async () => {
    const meter = createMeter({ budgets: [{ window: 'day', limitUsd: 2 }] });
    await meter.record(call()); // 1.50
    expect((await meter.check([], { estimateUsd: 0.4 })).ok).toBe(true);
    const r = await meter.check([], { estimateUsd: 0.6 });
    expect(r.ok).toBe(false);
    expect(r.budgets[0]!.remainingUsd).toBeCloseTo(0.5, 12);
    await expect(meter.check([], { estimateUsd: -1 })).rejects.toThrow(/estimateUsd/);
  });

  it('does not count unknown-model calls against budgets', async () => {
    const meter = createMeter({ budgets: [{ window: 'day', limitUsd: 1 }], onWarning: () => {} });
    await meter.record({ model: 'nope', usage: { inputTokens: 1e9 } });
    expect((await meter.check()).budgets[0]!.spentUsd).toBe(0);
  });

  it('rejects malformed budgets', () => {
    expect(() => createMeter({ budgets: [{ window: 'week' as 'day', limitUsd: 1 }] })).toThrow(/window/);
    expect(() => createMeter({ budgets: [{ window: 'day', limitUsd: 0 }] })).toThrow(/limitUsd/);
    expect(() => createMeter({ budgets: [{ window: 'day', limitUsd: 1, tag: 'user*' }] })).toThrow(/tag/);
    expect(() => createMeter({ budgets: [{ window: 'day', limitUsd: 1 }, { window: 'day', limitUsd: 2 }] })).toThrow(/duplicate/);
  });
});

describe('store', () => {
  it('works with an async store (the shape a Redis or database store has)', async () => {
    const counters = new Map<string, number>();
    const kept: MeterRecord[] = [];
    const store: MeterStore = {
      async increment(key, amount) {
        const v = (counters.get(key) ?? 0) + amount;
        counters.set(key, v);
        return v;
      },
      async get(key) {
        return counters.get(key) ?? 0;
      },
      async append(record) {
        kept.push(record);
      },
      async records() {
        return kept;
      },
    };
    const meter = createMeter({ store, budgets: [{ window: 'day', limitUsd: 2 }] });
    await meter.record(call());
    await meter.record(call());
    expect(kept).toHaveLength(2);
    expect((await meter.check()).ok).toBe(false);
    expect((await meter.summary()).costUsd).toBeCloseTo(3, 12);
  });

  it('memoryStore drops the oldest records past maxRecords but keeps counters', async () => {
    const store = memoryStore({ maxRecords: 3 });
    const meter = createMeter({ store, budgets: [{ window: 'day', limitUsd: 100 }] });
    for (let i = 0; i < 10; i++) await meter.record(call([`n:${i}`]));
    const records = await store.records();
    expect(records.map((r) => r.tags[0])).toEqual(['n:7', 'n:8', 'n:9']);
    expect((await meter.check()).budgets[0]!.spentUsd).toBeCloseTo(15, 12);
    expect(() => memoryStore({ maxRecords: -1 })).toThrow();
  });
});

describe('summary', () => {
  it('groups by model, tag (with a prefix) and day', async () => {
    const c = clock('2026-10-15T10:00:00Z');
    const meter = createMeter({ now: c.now, onWarning: () => {} });
    await meter.record(call(['user:1', 'feature:search'])); // 1.50
    c.set('2026-10-16T10:00:00Z');
    await meter.record({ model: 'gpt-5', usage: { inputTokens: 1_000_000, cachedInputTokens: 1_000_000 }, tags: ['user:2'] }); // 1.375
    await meter.record({ model: 'unknown-model', usage: { outputTokens: 5 } });

    const byModel = await meter.summary();
    expect(byModel.calls).toBe(3);
    expect(byModel.unpricedCalls).toBe(1);
    expect(byModel.costUsd).toBeCloseTo(2.875, 12);
    expect(byModel.groups.map((g) => g.key)).toEqual(['anthropic/claude-sonnet-4-6', 'openai/gpt-5', 'unknown-model']);
    expect(byModel.groups[1]).toMatchObject({ calls: 1, inputTokens: 2_000_000, cachedInputTokens: 1_000_000, outputTokens: 0 });

    const byUser = await meter.summary({ groupBy: 'tag', tagPrefix: 'user:' });
    expect(byUser.groups.map((g) => [g.key, g.calls])).toEqual([
      ['user:1', 1],
      ['user:2', 1],
      ['(untagged)', 1],
    ]);

    const byDay = await meter.summary({ groupBy: 'day' });
    expect(byDay.groups.map((g) => [g.key, g.calls])).toEqual([
      ['2026-10-15', 1],
      ['2026-10-16', 2],
    ]);

    const since = await meter.summary({ since: new Date('2026-10-16T00:00:00Z') });
    expect(since.calls).toBe(2);
    const until = await meter.summary({ until: new Date('2026-10-16T00:00:00Z') });
    expect(until.calls).toBe(1);
    expect(() => summarize([], { groupBy: 'week' as 'day' })).toThrow(/groupBy/);
  });
});

describe('JSONL log', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('writes one line per call that reads back into the same summary', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ai-cost-meter-'));
    const file = join(dir, 'calls.jsonl');
    const meter = createMeter({ onRecord: jsonlLogger(file) });
    await meter.record(call(['feature:a']));
    await meter.record(call(['feature:b'], 50_000));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const records = readJsonl(file);
    expect(summarize(records)).toEqual(await meter.summary());
  });

  it('reports the line number of a bad line', () => {
    expect(() => parseJsonl('\n{"ts":"2026-10-16T00:00:00Z","model":"m","costUsd":1}\n{oops', 'x.jsonl')).toThrow('x.jsonl:3: not valid JSON');
    expect(() => parseJsonl('{"model":"m"}', 'x.jsonl')).toThrow('x.jsonl:1: not a meter record');
    expect(() => readJsonl('/nonexistent/file.jsonl')).toThrow(/cannot read/);
  });
});
