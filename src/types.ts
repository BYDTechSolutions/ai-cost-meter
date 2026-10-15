/** Per-token rates of one price block, in USD per million tokens. */
export interface Rates {
  /** Uncached input tokens. */
  input_per_mtok: number;
  /** Output tokens, including reasoning or thinking tokens. */
  output_per_mtok: number;
  /** Input tokens read from the prompt cache. */
  cached_input_per_mtok?: number;
  /** Input tokens written to the prompt cache (for Anthropic, the 5-minute cache). */
  cache_write_per_mtok?: number;
  /** Input tokens written to Anthropic's 1-hour prompt cache. */
  cache_write_1h_per_mtok?: number;
  /** Uncached audio input tokens, when the provider prices audio separately. */
  audio_input_per_mtok?: number;
  /** Cached audio input tokens, when the provider prices them separately. */
  cached_audio_input_per_mtok?: number;
}

/** Rates that apply instead when a prompt has more than `above_input_tokens` input tokens. */
export interface Tier extends Rates {
  above_input_tokens: number;
}

/** A complete set of rates: base rates plus optional prompt-length tiers. */
export interface PriceBlock extends Rates {
  tiers?: Tier[];
}

/** A price change announced in advance, in effect from `effective_from` (UTC) on. */
export interface PriceChange extends PriceBlock {
  effective_from: string;
  batch?: PriceBlock;
}

/** One model's list prices, as stored in `data/prices.json`. */
export interface PriceEntry extends PriceBlock {
  provider: string;
  model: string;
  aliases?: string[];
  /** Fraction taken off every rate for batch requests (0.5 = 50% off). */
  batch_discount?: number;
  /** Batch rates exactly as the provider lists them. */
  batch?: PriceBlock;
  changes?: PriceChange[];
  notes?: string;
  source?: string;
  checked?: string;
}

/** A price dataset: the bundled `data/prices.json` or your own. */
export interface PriceDataset {
  updated?: string;
  prices: PriceEntry[];
}

/**
 * Token counts for one call, split into buckets that do not overlap.
 * Every field defaults to 0. The adapters (`fromOpenAI`, `fromAnthropic`,
 * `fromGemini`) produce this shape from a provider response.
 */
export interface Usage {
  /** Uncached input tokens (text, image, video, documents). Excludes every other input bucket. */
  inputTokens?: number;
  /** Output tokens, including reasoning or thinking tokens. */
  outputTokens?: number;
  /** Input tokens read from the prompt cache. */
  cachedInputTokens?: number;
  /** Input tokens written to the prompt cache (for Anthropic, the 5-minute cache). */
  cacheWriteTokens?: number;
  /** Input tokens written to Anthropic's 1-hour prompt cache. */
  cacheWrite1hTokens?: number;
  /** Uncached audio input tokens. */
  audioInputTokens?: number;
  /** Audio input tokens read from the prompt cache. */
  cachedAudioInputTokens?: number;
}

/** The usage buckets, in the order they are reported. */
export const USAGE_KEYS = [
  'inputTokens',
  'cachedInputTokens',
  'cacheWriteTokens',
  'cacheWrite1hTokens',
  'audioInputTokens',
  'cachedAudioInputTokens',
  'outputTokens',
] as const;

export type UsageKey = (typeof USAGE_KEYS)[number];

/** What an adapter returns: spread it into `meter.record()` or `estimateCost()`. */
export interface NormalizedCall {
  provider: string;
  model: string;
  usage: Usage;
  /** True when the response says it was served by a batch API. */
  batch?: boolean;
  /** Things the adapter saw that the price will not reflect. */
  warnings?: string[];
}

/** What to price: a model and its usage. */
export interface CostInput {
  /** Provider key. Optional: model IDs in the bundled data are unique across providers. */
  provider?: string;
  model: string;
  usage: Usage;
  /** Price at batch rates. Default false. */
  batch?: boolean;
  /** When the call happened; picks announced price changes. Default: now. */
  at?: Date;
  /** Warnings to carry into the result (adapters fill this). */
  warnings?: string[];
}

/** One line of the cost breakdown. */
export interface BreakdownLine {
  tokens: number;
  /** USD per million tokens actually applied. */
  ratePerMtok: number;
  usd: number;
}

/** How a cost was computed. Only buckets with tokens are present. */
export interface CostBreakdown {
  lines: Partial<Record<UsageKey, BreakdownLine>>;
  /** Total input tokens used to pick a prompt-length tier. */
  promptTokens: number;
  /** The tier threshold applied, or null for base rates. */
  tierAboveInputTokens: number | null;
  batch: boolean;
  /** `effective_from` of the announced change in effect, or null for the current rates. */
  priceEffectiveFrom: string | null;
  source: string | null;
}

/** The price of one call. `costUsd` is null when the model or rate is unknown, never a silent 0. */
export interface CostResult {
  provider: string | null;
  model: string;
  /** The dataset entry used, when the model was found under an alias. */
  matchedModel: string | null;
  costUsd: number | null;
  breakdown: CostBreakdown | null;
  warnings: string[];
}

/** One recorded call, as kept by a store and written by `jsonlLogger`. */
export interface MeterRecord {
  /** ISO 8601 timestamp. */
  ts: string;
  provider: string | null;
  model: string;
  tags: string[];
  usage: Usage;
  batch: boolean;
  costUsd: number | null;
  breakdown: CostBreakdown | null;
  warnings: string[];
}

/** Thrown for invalid arguments, malformed price data and malformed responses. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Thrown when a price is missing and the meter is set to `unknownModel: 'throw'`. */
export class UnknownPriceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownPriceError';
  }
}
