// Read usage from provider responses without importing any provider SDK.
// Each adapter accepts the plain JSON body of the HTTP response or the
// object an official SDK returns (they carry the same field names), and
// returns disjoint usage buckets ready for meter.record().
import { UsageError, type NormalizedCall, type Usage } from './types.js';

/** Options shared by the adapters. */
export interface AdapterOptions {
  /** The call went through a batch API. Default: what the response says, else false. */
  batch?: boolean;
  /** Use this model ID instead of the one in the response. */
  model?: string;
}

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : undefined;
}

function count(v: unknown, field: string): number {
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new UsageError(`${field} must be a number >= 0`);
  return v;
}

function modelOf(given: string | undefined, fromResponse: unknown, adapter: string): string {
  const m = given ?? fromResponse;
  if (typeof m !== 'string' || m === '') throw new UsageError(`${adapter}: the response has no model; pass { model }`);
  return m;
}

function clampWarn(value: number, what: string, warnings: string[]): number {
  if (value >= 0) return value;
  warnings.push(`${what} came out negative (${value}); counted as 0`);
  return 0;
}

/**
 * Reads an OpenAI response: a Chat Completions object (`usage.prompt_tokens`,
 * `usage.prompt_tokens_details.cached_tokens` / `cache_write_tokens`,
 * `usage.completion_tokens`) or a Responses API object (`usage.input_tokens`,
 * `usage.input_tokens_details.cached_tokens` / `cache_write_tokens`,
 * `usage.output_tokens`). Reasoning tokens are already part of the output count.
 * For a streamed chat completion, pass the last chunk with
 * `stream_options: { include_usage: true }`; for a streamed response, pass
 * the `response` of the `response.completed` event.
 */
export function fromOpenAI(response: unknown, opts: AdapterOptions = {}): NormalizedCall {
  const r = obj(response);
  const u = obj(r?.usage);
  if (!r || !u) throw new UsageError('fromOpenAI: the response has no usage object');
  const warnings: string[] = [];
  let total: number;
  let cached: number;
  let written: number;
  let output: number;
  if (u.input_tokens !== undefined || u.output_tokens !== undefined) {
    const d = obj(u.input_tokens_details);
    total = count(u.input_tokens, 'usage.input_tokens');
    cached = count(d?.cached_tokens, 'usage.input_tokens_details.cached_tokens');
    written = count(d?.cache_write_tokens, 'usage.input_tokens_details.cache_write_tokens');
    output = count(u.output_tokens, 'usage.output_tokens');
  } else if (u.prompt_tokens !== undefined || u.completion_tokens !== undefined) {
    const d = obj(u.prompt_tokens_details);
    total = count(u.prompt_tokens, 'usage.prompt_tokens');
    cached = count(d?.cached_tokens, 'usage.prompt_tokens_details.cached_tokens');
    written = count(d?.cache_write_tokens, 'usage.prompt_tokens_details.cache_write_tokens');
    output = count(u.completion_tokens, 'usage.completion_tokens');
  } else {
    throw new UsageError('fromOpenAI: usage has neither input_tokens/output_tokens nor prompt_tokens/completion_tokens');
  }
  const tier = r.service_tier;
  if (typeof tier === 'string' && !['default', 'auto', 'standard'].includes(tier)) {
    warnings.push(`openai service_tier "${tier}" is not modeled; priced at standard rates`);
  }
  const usage: Usage = {
    inputTokens: clampWarn(total - cached - written, 'openai uncached input tokens', warnings),
    cachedInputTokens: cached,
    cacheWriteTokens: written,
    outputTokens: output,
  };
  return {
    provider: 'openai',
    model: modelOf(opts.model, r.model, 'fromOpenAI'),
    usage,
    batch: opts.batch ?? false,
    ...(warnings.length ? { warnings } : {}),
  };
}

/**
 * Reads an Anthropic Messages API `Message`: `usage.input_tokens` (uncached),
 * `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens` (split
 * into 5-minute and 1-hour writes by `usage.cache_creation` when present) and
 * `usage.output_tokens`. `usage.service_tier: "batch"` marks a batch result.
 * For a stream, pass the final message (the SDK's `finalMessage()`).
 */
export function fromAnthropic(message: unknown, opts: AdapterOptions = {}): NormalizedCall {
  const m = obj(message);
  const u = obj(m?.usage);
  if (!m || !u) throw new UsageError('fromAnthropic: the message has no usage object');
  const warnings: string[] = [];
  const creation = obj(u.cache_creation);
  let write5m: number;
  let write1h: number;
  const creationTotal = count(u.cache_creation_input_tokens, 'usage.cache_creation_input_tokens');
  if (creation) {
    write5m = count(creation.ephemeral_5m_input_tokens, 'usage.cache_creation.ephemeral_5m_input_tokens');
    write1h = count(creation.ephemeral_1h_input_tokens, 'usage.cache_creation.ephemeral_1h_input_tokens');
    if (write5m + write1h !== creationTotal && creationTotal > 0) {
      warnings.push(
        `anthropic cache_creation breakdown (${write5m} + ${write1h}) differs from cache_creation_input_tokens (${creationTotal}); used the breakdown`,
      );
    }
  } else {
    write5m = creationTotal;
    write1h = 0;
  }
  const tier = u.service_tier;
  if (typeof tier === 'string' && tier !== 'standard' && tier !== 'batch') {
    warnings.push(`anthropic service_tier "${tier}" is not modeled; priced at standard rates`);
  }
  const geo = u.inference_geo;
  if (typeof geo === 'string' && geo !== '' && geo !== 'global') {
    warnings.push(`anthropic inference_geo "${geo}" may carry a price multiplier that is not applied`);
  }
  return {
    provider: 'anthropic',
    model: modelOf(opts.model, m.model, 'fromAnthropic'),
    usage: {
      inputTokens: count(u.input_tokens, 'usage.input_tokens'),
      cachedInputTokens: count(u.cache_read_input_tokens, 'usage.cache_read_input_tokens'),
      cacheWriteTokens: write5m,
      cacheWrite1hTokens: write1h,
      outputTokens: count(u.output_tokens, 'usage.output_tokens'),
    },
    batch: opts.batch ?? tier === 'batch',
    ...(warnings.length ? { warnings } : {}),
  };
}

function audioCount(list: unknown, field: string): number {
  if (list === undefined || list === null) return 0;
  if (!Array.isArray(list)) throw new UsageError(`${field} must be an array`);
  let n = 0;
  for (const item of list) {
    const o = obj(item);
    if (o?.modality === 'AUDIO') n += count(o.tokenCount, `${field}[].tokenCount`);
  }
  return n;
}

/**
 * Reads a Gemini API `GenerateContentResponse`: `usageMetadata.promptTokenCount`
 * (which includes cached tokens), `cachedContentTokenCount`,
 * `toolUsePromptTokenCount` (counted as input), `candidatesTokenCount` plus
 * `thoughtsTokenCount` (output; the price includes thinking tokens), and the
 * `AUDIO` entries of `promptTokensDetails`, `toolUsePromptTokensDetails` and
 * `cacheTokensDetails` for models that price audio separately. The model
 * comes from `modelVersion`. Batch results are not marked in the response:
 * pass `{ batch: true }`.
 */
export function fromGemini(response: unknown, opts: AdapterOptions = {}): NormalizedCall {
  const r = obj(response);
  const u = obj(r?.usageMetadata);
  if (!r || !u) throw new UsageError('fromGemini: the response has no usageMetadata object');
  const warnings: string[] = [];
  const prompt = count(u.promptTokenCount, 'usageMetadata.promptTokenCount');
  const toolUse = count(u.toolUsePromptTokenCount, 'usageMetadata.toolUsePromptTokenCount');
  const cached = count(u.cachedContentTokenCount, 'usageMetadata.cachedContentTokenCount');
  const audioIn =
    audioCount(u.promptTokensDetails, 'usageMetadata.promptTokensDetails') +
    audioCount(u.toolUsePromptTokensDetails, 'usageMetadata.toolUsePromptTokensDetails');
  const audioCached = audioCount(u.cacheTokensDetails, 'usageMetadata.cacheTokensDetails');
  const output =
    count(u.candidatesTokenCount, 'usageMetadata.candidatesTokenCount') +
    count(u.thoughtsTokenCount, 'usageMetadata.thoughtsTokenCount');
  const tier = u.serviceTier;
  if (typeof tier === 'string' && tier !== 'standard' && tier !== 'unspecified') {
    warnings.push(`gemini serviceTier "${tier}" is not modeled; priced at standard rates`);
  }
  const nonAudioCached = clampWarn(cached - audioCached, 'gemini cached non-audio tokens', warnings);
  const nonAudioTotal = clampWarn(prompt + toolUse - audioIn, 'gemini non-audio input tokens', warnings);
  let model = modelOf(opts.model, r.modelVersion, 'fromGemini');
  if (model.startsWith('models/')) model = model.slice('models/'.length);
  return {
    provider: 'google-gemini-api',
    model,
    usage: {
      inputTokens: clampWarn(nonAudioTotal - nonAudioCached, 'gemini uncached input tokens', warnings),
      cachedInputTokens: nonAudioCached,
      audioInputTokens: clampWarn(audioIn - audioCached, 'gemini uncached audio tokens', warnings),
      cachedAudioInputTokens: audioCached,
      outputTokens: output,
    },
    batch: opts.batch ?? false,
    ...(warnings.length ? { warnings } : {}),
  };
}
