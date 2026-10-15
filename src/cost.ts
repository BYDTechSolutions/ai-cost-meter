import { blockOn, type PriceBook } from './prices.js';
import {
  USAGE_KEYS,
  UsageError,
  type BreakdownLine,
  type CostInput,
  type CostResult,
  type PriceBlock,
  type PriceEntry,
  type Rates,
  type Usage,
  type UsageKey,
} from './types.js';

/** A cost result plus, when the price could not be computed, the reason. */
export interface PricedResult extends CostResult {
  /** Set when `costUsd` is null: why no price could be given. */
  missing?: string;
}

/** Reads and checks a usage object, filling missing buckets with 0. */
export function normalizeUsage(usage: unknown): Required<Usage> {
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) {
    throw new UsageError('usage must be an object of token counts');
  }
  const u = usage as Record<string, unknown>;
  const out = {} as Required<Usage>;
  for (const k of USAGE_KEYS) {
    const v = u[k] ?? 0;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new UsageError(`usage.${k} must be a number >= 0`);
    }
    out[k] = v;
  }
  for (const k of Object.keys(u)) {
    if (!(USAGE_KEYS as readonly string[]).includes(k)) {
      throw new UsageError(`usage.${k} is not a known field (expected ${USAGE_KEYS.join(', ')})`);
    }
  }
  return out;
}

/** UTC calendar day of a date, YYYY-MM-DD. */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function selectTier(block: PriceBlock, promptTokens: number): { rates: Rates; above: number | null } {
  let rates: Rates = block;
  let above: number | null = null;
  for (const t of block.tiers ?? []) {
    if (promptTokens > t.above_input_tokens) {
      rates = t;
      above = t.above_input_tokens;
    }
  }
  return { rates, above };
}

function scaled(r: Rates, factor: number): Rates {
  const out: Rates = { input_per_mtok: r.input_per_mtok * factor, output_per_mtok: r.output_per_mtok * factor };
  for (const k of [
    'cached_input_per_mtok',
    'cache_write_per_mtok',
    'cache_write_1h_per_mtok',
    'audio_input_per_mtok',
    'cached_audio_input_per_mtok',
  ] as const) {
    const v = r[k];
    if (v !== undefined) out[k] = v * factor;
  }
  return out;
}

type RateFor = { rate: number; fallback?: string };

/** The rate for one usage bucket, with the fallback rule written down in one place. */
function rateFor(r: Rates, key: UsageKey): RateFor {
  switch (key) {
    case 'inputTokens':
      return { rate: r.input_per_mtok };
    case 'outputTokens':
      return { rate: r.output_per_mtok };
    case 'cachedInputTokens':
      return r.cached_input_per_mtok !== undefined
        ? { rate: r.cached_input_per_mtok }
        : { rate: r.input_per_mtok, fallback: 'no cached-input rate is listed; cached tokens were charged at the input rate' };
    case 'cacheWriteTokens':
      return r.cache_write_per_mtok !== undefined
        ? { rate: r.cache_write_per_mtok }
        : { rate: r.input_per_mtok, fallback: 'no cache-write rate is listed; cache writes were charged at the input rate' };
    case 'cacheWrite1hTokens':
      if (r.cache_write_1h_per_mtok !== undefined) return { rate: r.cache_write_1h_per_mtok };
      return r.cache_write_per_mtok !== undefined
        ? { rate: r.cache_write_per_mtok, fallback: 'no 1-hour cache-write rate is listed; charged at the cache-write rate' }
        : { rate: r.input_per_mtok, fallback: 'no cache-write rate is listed; 1-hour cache writes were charged at the input rate' };
    case 'audioInputTokens':
      // Providers that list one input price say it covers every modality.
      return { rate: r.audio_input_per_mtok ?? r.input_per_mtok };
    case 'cachedAudioInputTokens':
      if (r.cached_audio_input_per_mtok !== undefined) return { rate: r.cached_audio_input_per_mtok };
      if (r.audio_input_per_mtok === undefined && r.cached_input_per_mtok !== undefined) return { rate: r.cached_input_per_mtok };
      return {
        rate: r.audio_input_per_mtok ?? r.input_per_mtok,
        fallback: 'no cached audio rate is listed; cached audio tokens were charged at the audio input rate',
      };
  }
}

/** Rounds to 1e-12 USD, which only removes floating-point noise such as 0.000038400000000000005. */
function round12(v: number): number {
  return Math.round(v * 1e12) / 1e12;
}

function label(entry: PriceEntry): string {
  return `${entry.provider}/${entry.model}`;
}

/**
 * Prices one call against a price book. Pure: no store, no budgets, no I/O.
 * When the model or a needed rate is unknown, `costUsd` is null and
 * `missing` says why.
 */
export function priceCall(book: PriceBook, input: CostInput, now: Date = new Date()): PricedResult {
  if (typeof input !== 'object' || input === null) throw new UsageError('expected { model, usage }');
  if (typeof input.model !== 'string' || input.model === '') throw new UsageError('model must be a non-empty string');
  if (input.provider !== undefined && (typeof input.provider !== 'string' || input.provider === '')) {
    throw new UsageError('provider must be a non-empty string when given');
  }
  const usage = normalizeUsage(input.usage);
  const warnings = [...(input.warnings ?? [])];
  const batch = input.batch === true;
  const base = { provider: input.provider ?? null, model: input.model, matchedModel: null, costUsd: null, breakdown: null };

  const found = book.find(input.model, input.provider);
  if (found === null) {
    const where = input.provider ? `${input.provider}/${input.model}` : input.model;
    return { ...base, warnings, missing: `no price for model "${where}" in the price data` };
  }
  if ('ambiguous' in found) {
    return {
      ...base,
      warnings,
      missing: `model "${input.model}" is listed by several providers (${found.ambiguous.join(', ')}); pass provider`,
    };
  }
  const entry = found.entry;
  const at = input.at ?? now;
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new UsageError('at must be a valid Date');
  const { block, batch: batchBlock, effectiveFrom } = blockOn(entry, utcDay(at));
  const promptTokens =
    usage.inputTokens +
    usage.cachedInputTokens +
    usage.cacheWriteTokens +
    usage.cacheWrite1hTokens +
    usage.audioInputTokens +
    usage.cachedAudioInputTokens;

  const std = selectTier(block, promptTokens);
  let rates: Rates;
  let above = std.above;
  const resolved = {
    ...base,
    provider: entry.provider,
    matchedModel: entry.model === input.model ? null : entry.model,
  };
  if (!batch) {
    rates = std.rates;
  } else if (batchBlock) {
    const b = selectTier(batchBlock, promptTokens);
    if (b.above !== std.above) {
      return {
        ...resolved,
        warnings,
        missing: `no batch price is listed for ${label(entry)} above ${std.above} input tokens`,
      };
    }
    rates = b.rates;
    above = b.above;
  } else if (entry.batch_discount !== undefined) {
    rates = scaled(std.rates, 1 - entry.batch_discount);
  } else {
    return { ...resolved, warnings, missing: `no batch price is listed for ${label(entry)}` };
  }

  const lines: Partial<Record<UsageKey, BreakdownLine>> = {};
  let micro = 0; // sum of tokens * USD-per-million, divided once at the end
  for (const key of USAGE_KEYS) {
    const tokens = usage[key];
    if (tokens === 0) continue;
    const { rate, fallback } = rateFor(rates, key);
    if (fallback) warnings.push(`${label(entry)}: ${fallback}`);
    micro += tokens * rate;
    lines[key] = { tokens, ratePerMtok: rate, usd: round12((tokens * rate) / 1_000_000) };
  }
  return {
    ...resolved,
    costUsd: round12(micro / 1_000_000),
    breakdown: {
      lines,
      promptTokens,
      tierAboveInputTokens: above,
      batch,
      priceEffectiveFrom: effectiveFrom,
      source: entry.source ?? null,
    },
    warnings,
  };
}
