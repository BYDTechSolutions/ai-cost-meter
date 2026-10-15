import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkData } from '../scripts/check-data.mjs';
import { createPriceBook, defaultPrices, mergePrices, validatePrices, type PriceDataset } from '../src/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = readFileSync(join(root, 'data/prices.json'), 'utf8');
const data = JSON.parse(raw);
const schema = JSON.parse(readFileSync(join(root, 'data/schema.json'), 'utf8'));
const today = data.updated;
const base = () => JSON.parse(raw);
// Test edits poke at arbitrary fields, so entries are untyped here.
const find = (d: { prices: { model: string }[] }, model: string): any => d.prices.find((e) => e.model === model)!;

describe('data/prices.json', () => {
  it('passes the schema and every consistency check', () => {
    expect(checkData(data, schema, { today })).toEqual([]);
  });

  it('is what the package bundles', () => {
    expect(defaultPrices()).toEqual(data);
  });

  it('covers OpenAI, Anthropic and the Gemini API, each entry with an official source and a checked date', () => {
    const providers = new Set(data.prices.map((e: { provider: string }) => e.provider));
    expect([...providers].sort()).toEqual(['anthropic', 'google-gemini-api', 'openai']);
    const official: Record<string, string> = {
      openai: 'https://developers.openai.com/api/docs/pricing',
      anthropic: 'https://platform.claude.com/docs/en/about-claude/pricing',
      'google-gemini-api': 'https://ai.google.dev/gemini-api/docs/pricing',
    };
    for (const e of data.prices) {
      expect(e.source, e.model).toBe(official[e.provider]);
      expect(e.checked, e.model).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('passes the runtime validator and resolves every ID to one entry', () => {
    expect(() => validatePrices(data)).not.toThrow();
    const book = createPriceBook(data);
    for (const e of data.prices) {
      for (const id of [e.model, ...(e.aliases ?? [])]) {
        const hit = book.find(id);
        expect(hit && 'entry' in hit ? hit.entry.model : null, id).toBe(e.model);
      }
    }
  });
});

describe('checkData', () => {
  it('rejects unsorted entries and duplicates', () => {
    const d = base();
    [d.prices[0], d.prices[1]] = [d.prices[1], d.prices[0]];
    expect(checkData(d, schema, { today }).join('\n')).toContain('not sorted');
    const e = base();
    e.prices.splice(1, 0, structuredClone(e.prices[0]));
    expect(checkData(e, schema, { today }).join('\n')).toContain('duplicate');
  });

  it('rejects an ID used twice, even across providers', () => {
    const d = base();
    find(d, 'gpt-5').aliases = ['claude-opus-4-8'];
    expect(checkData(d, schema, { today }).join('\n')).toContain('is already used by');
  });

  it('rejects bad numbers', () => {
    const neg = base();
    find(neg, 'gpt-5').input_per_mtok = -1;
    expect(checkData(neg, schema, { today }).join('\n')).toContain('schema');
    const huge = base();
    find(huge, 'gpt-5').output_per_mtok = 10_000;
    expect(checkData(huge, schema, { today }).join('\n')).toContain('above 1000');
    const cached = base();
    find(cached, 'gpt-5').cached_input_per_mtok = 5;
    expect(checkData(cached, schema, { today }).join('\n')).toContain('cached_input_per_mtok is above input_per_mtok');
    const str = base();
    find(str, 'gpt-5').input_per_mtok = '1.25';
    expect(checkData(str, schema, { today }).join('\n')).toContain('schema');
  });

  it('rejects a missing source, an unknown field and both kinds of batch price', () => {
    const s = base();
    delete s.prices[0].source;
    expect(checkData(s, schema, { today }).join('\n')).toContain('schema');
    const u = base();
    u.prices[0].price = 1;
    expect(checkData(u, schema, { today }).join('\n')).toContain('schema');
    const b = base();
    find(b, 'gpt-5').batch_discount = 0.5;
    expect(checkData(b, schema, { today }).join('\n')).toContain('both batch and batch_discount');
  });

  it('rejects tiers out of order and a batch tier with no standard tier', () => {
    const t = base();
    const e = find(t, 'claude-haiku-5-5');
    e.tiers.push({ ...e.tiers[0], above_input_tokens: 50_000 });
    expect(checkData(t, schema, { today }).join('\n')).toContain('above_input_tokens must increase');
    const b = base();
    find(b, 'gemini-2.5-flash').batch.tiers = [{ above_input_tokens: 200000, input_per_mtok: 1, output_per_mtok: 1 }];
    expect(checkData(b, schema, { today }).join('\n')).toContain('no matching standard tier');
  });

  it('rejects an announced change that has already taken effect, or that lacks batch rates', () => {
    const d = base();
    find(d, 'gemini-4-argon').changes[0].effective_from = today;
    expect(checkData(d, schema, { today }).join('\n')).toContain('fold it into the current rates');
    const e = base();
    delete find(e, 'gemini-4-argon').changes[0].batch;
    expect(checkData(e, schema, { today }).join('\n')).toContain('must list them too');
  });

  it('rejects impossible and future dates', () => {
    const d = base();
    d.prices[0].checked = '2026-02-30';
    expect(checkData(d, schema, { today }).join('\n')).toContain('not a calendar date');
    const f = base();
    f.updated = '2099-01-01';
    expect(checkData(f, schema, { today }).join('\n')).toContain('in the future');
  });

  it('fails when the data is older than --max-age', () => {
    expect(checkData(data, schema, { today, maxAge: 30 })).toEqual([]);
    const later = new Date(Date.parse(`${today}T00:00:00Z`) + 31 * 86_400_000).toISOString().slice(0, 10);
    expect(checkData(data, schema, { today: later, maxAge: 30 }).join('\n')).toContain('days old');
  });
});

describe('validatePrices and mergePrices', () => {
  it('rejects malformed custom prices', () => {
    expect(() => validatePrices({})).toThrow(/prices/);
    expect(() => validatePrices([{ provider: 'p', model: '', input_per_mtok: 1, output_per_mtok: 1 }])).toThrow(/model/);
    expect(() => validatePrices([{ provider: 'p', model: 'm', input_per_mtok: 1 }])).toThrow(/output_per_mtok is required/);
    expect(() => validatePrices([{ provider: 'p', model: 'm', input_per_mtok: -1, output_per_mtok: 1 }])).toThrow(/>= 0/);
    expect(() => validatePrices([{ provider: 'p', model: 'm', input_per_mtok: 1, output_per_mtok: 1, batch_discount: 2 }])).toThrow(/batch_discount/);
    expect(() =>
      validatePrices([{ provider: 'p', model: 'm', input_per_mtok: 1, output_per_mtok: 1, tiers: [{ above_input_tokens: 0, input_per_mtok: 1, output_per_mtok: 1 }] }]),
    ).toThrow(/above_input_tokens/);
    expect(() =>
      validatePrices([{ provider: 'p', model: 'm', input_per_mtok: 1, output_per_mtok: 1, changes: [{ effective_from: '2026-13-01', input_per_mtok: 1, output_per_mtok: 1 }] }]),
    ).toThrow(/effective_from/);
  });

  it('accepts a bare array and replaces entries with the same provider and model', () => {
    const a: PriceDataset = { updated: '2026-10-16', prices: [{ provider: 'b', model: 'x', input_per_mtok: 1, output_per_mtok: 2 }] };
    const b = validatePrices([
      { provider: 'b', model: 'x', input_per_mtok: 3, output_per_mtok: 4 },
      { provider: 'a', model: 'y', input_per_mtok: 5, output_per_mtok: 6 },
    ]);
    expect(mergePrices(a, b)).toEqual({
      updated: '2026-10-16',
      prices: [
        { provider: 'a', model: 'y', input_per_mtok: 5, output_per_mtok: 6 },
        { provider: 'b', model: 'x', input_per_mtok: 3, output_per_mtok: 4 },
      ],
    });
  });
});
