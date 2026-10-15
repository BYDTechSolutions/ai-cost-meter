import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { estimateCost, fromAnthropic, fromGemini, fromOpenAI } from '../src/index.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const at = new Date('2026-10-16T12:00:00Z');

describe('fromOpenAI', () => {
  it('reads a Chat Completions response: cached tokens come out of prompt_tokens', () => {
    const call = fromOpenAI(fixture('openai-chat-completion.json'));
    expect(call).toEqual({
      provider: 'openai',
      model: 'gpt-5-mini',
      usage: { inputTokens: 298, cachedInputTokens: 1536, cacheWriteTokens: 0, outputTokens: 412 },
      batch: false,
    });
    // 298*0.25 + 1536*0.025 + 412*2.00 (reasoning tokens are already in completion_tokens)
    expect(estimateCost({ ...call, at }).costUsd).toBeCloseTo(0.0009369, 12);
  });

  it('reads a Responses API response, including cache writes', () => {
    const call = fromOpenAI(fixture('openai-response.json'));
    expect(call.usage).toEqual({ inputTokens: 1760, cachedInputTokens: 8192, cacheWriteTokens: 2048, outputTokens: 900 });
    // 1760*2 + 8192*0.2 + 2048*2.5 + 900*10
    expect(estimateCost({ ...call, at }).costUsd).toBeCloseTo(0.0192784, 12);
  });

  it('takes batch and model overrides, and warns about service tiers it does not price', () => {
    const res = { ...fixture('openai-chat-completion.json'), service_tier: 'flex' };
    const call = fromOpenAI(res, { batch: true, model: 'gpt-5' });
    expect(call.batch).toBe(true);
    expect(call.model).toBe('gpt-5');
    expect(call.warnings).toEqual(['openai service_tier "flex" is not modeled; priced at standard rates']);
  });

  it('works on a minimal usage object with no details', () => {
    const call = fromOpenAI({ model: 'o3', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    expect(call.usage).toEqual({ inputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 5 });
  });

  it('rejects a response without usage or with malformed counts', () => {
    expect(() => fromOpenAI({ model: 'gpt-5' })).toThrow(/no usage object/);
    expect(() => fromOpenAI({ model: 'gpt-5', usage: {} })).toThrow(/neither/);
    expect(() => fromOpenAI({ model: 'gpt-5', usage: { prompt_tokens: '10', completion_tokens: 1 } })).toThrow(/prompt_tokens/);
    expect(() => fromOpenAI({ usage: { prompt_tokens: 1, completion_tokens: 1 } })).toThrow(/no model/);
  });
});

describe('fromAnthropic', () => {
  it('reads input, cache reads, cache writes and output as separate buckets', () => {
    const call = fromAnthropic(fixture('anthropic-message.json'));
    expect(call).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      usage: { inputTokens: 50, cachedInputTokens: 10000, cacheWriteTokens: 2048, cacheWrite1hTokens: 0, outputTokens: 503 },
      batch: false,
    });
    // 50*3 + 10000*0.3 + 2048*3.75 + 503*15
    expect(estimateCost({ ...call, at }).costUsd).toBeCloseTo(0.018375, 12);
  });

  it('marks a batch result, splits 1-hour cache writes and resolves the alias', () => {
    const call = fromAnthropic(fixture('anthropic-batch-message.json'));
    expect(call.batch).toBe(true);
    expect(call.usage.cacheWrite1hTokens).toBe(4096);
    expect(call.usage.cacheWriteTokens).toBe(0);
    const r = estimateCost({ ...call, at });
    expect(r.matchedModel).toBe('claude-haiku-4-5-20251001');
    // (312*1 + 4096*2 + 9*5) * 0.5
    expect(r.costUsd).toBeCloseTo(0.0042745, 12);
  });

  it('falls back to cache_creation_input_tokens when there is no breakdown', () => {
    const m = fixture('anthropic-message.json');
    delete m.usage.cache_creation;
    expect(fromAnthropic(m).usage.cacheWriteTokens).toBe(2048);
    m.usage.cache_creation_input_tokens = null;
    m.usage.cache_read_input_tokens = null;
    expect(fromAnthropic(m).usage).toMatchObject({ cacheWriteTokens: 0, cachedInputTokens: 0 });
  });

  it('warns about pricing it does not apply', () => {
    const m = fixture('anthropic-message.json');
    m.usage.inference_geo = 'us';
    m.usage.service_tier = 'priority';
    expect(fromAnthropic(m).warnings).toEqual([
      'anthropic service_tier "priority" is not modeled; priced at standard rates',
      'anthropic inference_geo "us" may carry a price multiplier that is not applied',
    ]);
  });

  it('rejects a message without usage', () => {
    expect(() => fromAnthropic({ model: 'claude-opus-4-8' })).toThrow(/no usage object/);
    expect(() => fromAnthropic(null)).toThrow(/no usage object/);
  });
});

describe('fromGemini', () => {
  it('splits cached and audio tokens out of promptTokenCount and adds thinking tokens to output', () => {
    const call = fromGemini(fixture('gemini-response.json'));
    expect(call).toEqual({
      provider: 'google-gemini-api',
      model: 'gemini-2.5-flash',
      usage: { inputTokens: 1400, cachedInputTokens: 2600, audioInputTokens: 600, cachedAudioInputTokens: 400, outputTokens: 2000 },
      batch: false,
    });
    // 1400*0.30 + 2600*0.03 + 600*1.00 + 400*0.10 + 2000*2.50
    expect(estimateCost({ ...call, at }).costUsd).toBeCloseTo(0.006138, 12);
  });

  it('counts tool-use prompt tokens as input, strips "models/" and warns about flex', () => {
    const call = fromGemini(fixture('gemini-tool-response.json'));
    expect(call.model).toBe('gemini-3.8-flash');
    expect(call.usage).toEqual({ inputTokens: 2020, cachedInputTokens: 0, audioInputTokens: 0, cachedAudioInputTokens: 0, outputTokens: 64 });
    expect(call.warnings).toEqual(['gemini serviceTier "flex" is not modeled; priced at standard rates']);
    // 2020*0.75 + 64*3.75
    expect(estimateCost({ ...call, at }).costUsd).toBeCloseTo(0.001755, 12);
  });

  it('needs a model from modelVersion or the options, and usageMetadata', () => {
    const r = fixture('gemini-response.json');
    delete r.modelVersion;
    expect(() => fromGemini(r)).toThrow(/no model/);
    expect(fromGemini(r, { model: 'gemini-2.5-pro', batch: true })).toMatchObject({ model: 'gemini-2.5-pro', batch: true });
    expect(() => fromGemini({ modelVersion: 'gemini-2.5-pro' })).toThrow(/no usageMetadata/);
    expect(() => fromGemini({ modelVersion: 'x', usageMetadata: { promptTokensDetails: {} } })).toThrow(/must be an array/);
  });
});
