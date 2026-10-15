import { describe, expect, it } from 'vitest';
import { buildPriceBook, estimateCost, normalizeUsage, priceCall, type CostInput } from '../src/index.js';

const book = buildPriceBook();
const at = new Date('2026-10-16T12:00:00Z');
const price = (input: Omit<CostInput, 'at'> & { at?: Date }) => priceCall(book, { at, ...input });
const M = 1_000_000;

describe('cost math', () => {
  it('prices every Anthropic bucket: input, cache reads, 5-minute and 1-hour cache writes, output', () => {
    const r = price({
      model: 'claude-sonnet-4-6',
      usage: { inputTokens: 1200, cachedInputTokens: 5000, cacheWriteTokens: 2000, cacheWrite1hTokens: 1000, outputTokens: 300 },
    });
    // 1200*3 + 5000*0.3 + 2000*3.75 + 1000*6 + 300*15, per million
    expect(r.costUsd).toBeCloseTo(0.0231, 12);
    expect(r.provider).toBe('anthropic');
    expect(r.breakdown?.lines.cachedInputTokens).toEqual({ tokens: 5000, ratePerMtok: 0.3, usd: 0.0015 });
    expect(r.breakdown?.lines.cacheWrite1hTokens?.ratePerMtok).toBe(6);
    expect(r.breakdown?.source).toBe('https://platform.claude.com/docs/en/about-claude/pricing');
    expect(r.warnings).toEqual([]);
  });

  it('uses the model-specific cache-read rate (0.05x on Claude Opus 5.5)', () => {
    const r = price({ model: 'claude-opus-5-5', usage: { cachedInputTokens: M } });
    expect(r.costUsd).toBeCloseTo(0.2, 12);
  });

  it('prices OpenAI cache writes where the page lists them', () => {
    const r = price({ model: 'gpt-6-astra', usage: { inputTokens: 1000, cachedInputTokens: 1000, cacheWriteTokens: 1000, outputTokens: 1000 } });
    // 1000*10 + 1000*1 + 1000*12.5 + 1000*50
    expect(r.costUsd).toBeCloseTo(0.0735, 12);
  });

  it('switches to tier rates when the whole prompt, cached tokens included, is over the threshold', () => {
    const over = price({ model: 'claude-haiku-5-5', usage: { inputTokens: 90_000, cachedInputTokens: 20_000, outputTokens: 1000 } });
    expect(over.breakdown?.tierAboveInputTokens).toBe(100_000);
    expect(over.breakdown?.promptTokens).toBe(110_000);
    expect(over.costUsd).toBeCloseTo(0.045 + 0.001 + 0.0025, 12);
    const at100k = price({ model: 'claude-haiku-5-5', usage: { inputTokens: 90_000, cachedInputTokens: 10_000, outputTokens: 1000 } });
    expect(at100k.breakdown?.tierAboveInputTokens).toBeNull();
    expect(at100k.costUsd).toBeCloseTo(0.009 + 0.0001 + 0.0005, 12);
  });

  it('applies OpenAI long-context rates above 272K input tokens', () => {
    const r = price({ model: 'gpt-5.5', usage: { inputTokens: 300_000, outputTokens: 1000 } });
    expect(r.costUsd).toBeCloseTo(3 + 0.045, 12);
    const short = price({ model: 'gpt-5.5', usage: { inputTokens: 272_000, outputTokens: 1000 } });
    expect(short.costUsd).toBeCloseTo(1.36 + 0.03, 12);
  });

  it('prices audio input at the audio rate where one is listed, and at the input rate where one price covers all', () => {
    const r = price({
      model: 'gemini-2.5-flash',
      usage: { inputTokens: 1000, cachedInputTokens: 1000, audioInputTokens: 1000, cachedAudioInputTokens: 1000, outputTokens: 1000 },
    });
    // 1000*0.30 + 1000*0.03 + 1000*1.00 + 1000*0.10 + 1000*2.50
    expect(r.costUsd).toBeCloseTo(0.00393, 12);
    const lite = price({ model: 'gemini-3.5-flash-lite', usage: { audioInputTokens: M, cachedAudioInputTokens: M } });
    expect(lite.costUsd).toBeCloseTo(0.3 + 0.03, 12);
    expect(lite.warnings).toEqual([]);
  });

  it('charges at the input rate, with a warning, when a cached or cache-write rate is not listed', () => {
    const r = price({ model: 'gpt-5.5-pro', usage: { cachedInputTokens: 100_000 } });
    expect(r.costUsd).toBeCloseTo(3, 12);
    expect(r.warnings.join('\n')).toContain('no cached-input rate is listed');
    const w = price({ model: 'gpt-5', usage: { cacheWriteTokens: M } });
    expect(w.costUsd).toBeCloseTo(1.25, 12);
    expect(w.warnings.join('\n')).toContain('no cache-write rate is listed');
  });

  it('returns 0 for zero usage on a known model, and null (never 0) for an unknown one', () => {
    expect(price({ model: 'gpt-5', usage: {} }).costUsd).toBe(0);
    const r = price({ model: 'gpt-4', usage: { inputTokens: 10 } });
    expect(r.costUsd).toBeNull();
    expect(r.breakdown).toBeNull();
    expect(r.missing).toContain('no price for model "gpt-4"');
  });

  it('finds a model by alias and reports the entry it matched', () => {
    const r = price({ model: 'claude-haiku-4-5', usage: { inputTokens: M } });
    expect(r.matchedModel).toBe('claude-haiku-4-5-20251001');
    expect(r.costUsd).toBeCloseTo(1, 12);
  });

  it('respects the provider, and asks for one when a model ID is listed twice', () => {
    expect(price({ provider: 'openai', model: 'claude-opus-4-8', usage: {} }).missing).toContain('openai/claude-opus-4-8');
    const custom = buildPriceBook([{ provider: 'my-gateway', model: 'gpt-5', input_per_mtok: 2, output_per_mtok: 20 }]);
    expect(priceCall(custom, { model: 'gpt-5', usage: {} }).missing).toContain('several providers (my-gateway, openai)');
    expect(priceCall(custom, { provider: 'my-gateway', model: 'gpt-5', usage: { inputTokens: M } }).costUsd).toBe(2);
  });
});

describe('batch prices', () => {
  it('applies a flat batch discount to every rate (Anthropic: 50%, cache multipliers stack)', () => {
    const r = price({ model: 'claude-opus-4-8', batch: true, usage: { inputTokens: M, cachedInputTokens: M, outputTokens: M } });
    expect(r.costUsd).toBeCloseTo(2.5 + 0.25 + 12.5, 12);
    expect(r.breakdown?.batch).toBe(true);
  });

  it('uses the per-model batch table where the page lists one', () => {
    const r = price({ model: 'gpt-5', batch: true, usage: { inputTokens: M, cachedInputTokens: M, outputTokens: M } });
    expect(r.costUsd).toBeCloseTo(0.625 + 0.0625 + 5, 12);
    const g = price({ model: 'gemini-2.5-pro', batch: true, usage: { inputTokens: 250_000, cachedInputTokens: 0, outputTokens: 1000 } });
    expect(g.breakdown?.tierAboveInputTokens).toBe(200_000);
    expect(g.costUsd).toBeCloseTo(0.3125 + 0.0075, 12);
  });

  it('falls back to the batch input rate for cached tokens when the batch table has no cached price', () => {
    const r = price({ model: 'gpt-4.1', batch: true, usage: { cachedInputTokens: M } });
    expect(r.costUsd).toBeCloseTo(1, 12);
    expect(r.warnings.join('\n')).toContain('no cached-input rate is listed');
  });

  it('gives no price when the page lists no batch price, or none for a long prompt', () => {
    expect(price({ model: 'gpt-3.5-turbo', batch: true, usage: { inputTokens: 1 } }).missing).toContain('no batch price is listed for openai/gpt-3.5-turbo');
    const long = price({ model: 'gpt-5.5-pro', batch: true, usage: { inputTokens: 300_000 } });
    expect(long.costUsd).toBeNull();
    expect(long.missing).toContain('above 272000 input tokens');
    expect(price({ model: 'gpt-5.5-pro', batch: true, usage: { inputTokens: 1000 } }).costUsd).toBeCloseTo(0.015, 12);
  });
});

describe('announced price changes', () => {
  it('uses the rates in effect on the UTC date of the call', () => {
    const before = price({ model: 'gemini-4-argon', at: new Date('2026-11-30T23:59:59Z'), usage: { inputTokens: M, outputTokens: M } });
    expect(before.costUsd).toBeCloseTo(12, 12);
    expect(before.breakdown?.priceEffectiveFrom).toBeNull();
    const after = price({ model: 'gemini-4-argon', at: new Date('2026-12-01T00:00:00Z'), usage: { inputTokens: M, outputTokens: M } });
    expect(after.costUsd).toBeCloseTo(24, 12);
    expect(after.breakdown?.priceEffectiveFrom).toBe('2026-12-01');
    const batch = price({ model: 'gemini-4-argon', at: new Date('2026-12-01T00:00:00Z'), batch: true, usage: { inputTokens: M } });
    expect(batch.costUsd).toBeCloseTo(2, 12);
  });
});

describe('usage validation', () => {
  it('fills missing buckets with 0 and rejects bad values or unknown fields', () => {
    expect(normalizeUsage({ inputTokens: 5 })).toMatchObject({ inputTokens: 5, outputTokens: 0, cachedInputTokens: 0 });
    expect(() => normalizeUsage({ inputTokens: -1 })).toThrow(/inputTokens/);
    expect(() => normalizeUsage({ inputTokens: Number.NaN })).toThrow(/inputTokens/);
    expect(() => normalizeUsage({ prompt_tokens: 5 })).toThrow(/not a known field/);
    expect(() => normalizeUsage(null)).toThrow(/usage must be an object/);
    expect(() => priceCall(book, { model: '', usage: {} })).toThrow(/model/);
  });
});

describe('estimateCost', () => {
  it('prices against the bundled data and puts the reason for a missing price in warnings', () => {
    expect(estimateCost({ model: 'gpt-5-mini', usage: { inputTokens: M, outputTokens: M }, at }).costUsd).toBeCloseTo(2.25, 12);
    const r = estimateCost({ model: 'nope', usage: {} });
    expect(r.costUsd).toBeNull();
    expect(r.warnings).toEqual(['no price for model "nope" in the price data']);
  });

  it('accepts custom prices with or without the bundled ones', () => {
    const prices = [{ provider: 'local', model: 'my-model', input_per_mtok: 0.5, output_per_mtok: 1 }];
    expect(estimateCost({ model: 'my-model', usage: { inputTokens: M } }, { prices }).costUsd).toBe(0.5);
    expect(estimateCost({ model: 'gpt-5', usage: {} }, { prices, defaultPrices: false }).costUsd).toBeNull();
  });
});
