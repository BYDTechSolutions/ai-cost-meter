import { readFileSync } from 'node:fs';
import bundled from '../data/prices.json' with { type: 'json' };
import { UsageError, type PriceBlock, type PriceDataset, type PriceEntry } from './types.js';

/** The price dataset bundled with this version of the package. */
export function defaultPrices(): PriceDataset {
  return bundled as unknown as PriceDataset;
}

const RATE_KEYS = [
  'input_per_mtok',
  'output_per_mtok',
  'cached_input_per_mtok',
  'cache_write_per_mtok',
  'cache_write_1h_per_mtok',
  'audio_input_per_mtok',
  'cached_audio_input_per_mtok',
] as const;

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkRates(where: string, b: Record<string, unknown>, required: boolean): void {
  for (const k of RATE_KEYS) {
    const v = b[k];
    if (v === undefined) {
      if (required && (k === 'input_per_mtok' || k === 'output_per_mtok')) {
        throw new UsageError(`${where}.${k} is required`);
      }
      continue;
    }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new UsageError(`${where}.${k} must be a number >= 0`);
    }
  }
}

function checkBlock(where: string, b: unknown): void {
  if (!isObject(b)) throw new UsageError(`${where} must be an object`);
  checkRates(where, b, true);
  if (b.tiers !== undefined) {
    if (!Array.isArray(b.tiers)) throw new UsageError(`${where}.tiers must be an array`);
    let prev = 0;
    b.tiers.forEach((t, i) => {
      const tw = `${where}.tiers[${i}]`;
      if (!isObject(t)) throw new UsageError(`${tw} must be an object`);
      const above = t.above_input_tokens;
      if (typeof above !== 'number' || !Number.isInteger(above) || above <= prev) {
        throw new UsageError(`${tw}.above_input_tokens must be an integer above the previous tier's`);
      }
      prev = above;
      checkRates(tw, t, true);
    });
  }
}

/**
 * Checks the shape of a parsed price dataset (or a bare array of entries)
 * and returns it typed. Throws {@link UsageError} naming the first problem.
 * This is the light check run on custom prices; `npm run check-data`
 * applies the full JSON Schema and consistency rules to the bundled file.
 */
export function validatePrices(value: unknown, label = 'prices'): PriceDataset {
  const obj: Record<string, unknown> = Array.isArray(value) ? { prices: value } : isObject(value) ? value : {};
  if (!Array.isArray(obj.prices)) throw new UsageError(`${label}: expected an object with a "prices" array`);
  if (obj.updated !== undefined && (typeof obj.updated !== 'string' || !DATE.test(obj.updated))) {
    throw new UsageError(`${label}: "updated" must be a YYYY-MM-DD date`);
  }
  obj.prices.forEach((raw, i) => {
    const where = `${label}: prices[${i}]`;
    if (!isObject(raw)) throw new UsageError(`${where} must be an object`);
    for (const k of ['provider', 'model'] as const) {
      if (typeof raw[k] !== 'string' || raw[k] === '') throw new UsageError(`${where}.${k} must be a non-empty string`);
    }
    checkBlock(where, raw);
    if (raw.aliases !== undefined) {
      if (!Array.isArray(raw.aliases) || raw.aliases.some((a) => typeof a !== 'string' || a === '')) {
        throw new UsageError(`${where}.aliases must be an array of non-empty strings`);
      }
    }
    if (raw.batch_discount !== undefined) {
      const d = raw.batch_discount;
      if (typeof d !== 'number' || !(d > 0 && d < 1)) throw new UsageError(`${where}.batch_discount must be between 0 and 1`);
    }
    if (raw.batch !== undefined) checkBlock(`${where}.batch`, raw.batch);
    if (raw.changes !== undefined) {
      if (!Array.isArray(raw.changes)) throw new UsageError(`${where}.changes must be an array`);
      let prev = '';
      raw.changes.forEach((c, k) => {
        const cw = `${where}.changes[${k}]`;
        checkBlock(cw, c);
        const from = (c as Record<string, unknown>).effective_from;
        if (typeof from !== 'string' || !DATE.test(from) || from <= prev) {
          throw new UsageError(`${cw}.effective_from must be a YYYY-MM-DD date after the previous change`);
        }
        prev = from;
        const cb = (c as Record<string, unknown>).batch;
        if (cb !== undefined) checkBlock(`${cw}.batch`, cb);
      });
    }
  });
  return obj as unknown as PriceDataset;
}

/** Reads and validates a price file. Throws {@link UsageError} when it is missing or malformed. */
export function loadPricesFile(file: string): PriceDataset {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new UsageError(`cannot read price file: ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError(`price file is not valid JSON: ${file}`);
  }
  return validatePrices(parsed, file);
}

/**
 * Merges datasets left to right. An entry with the same provider and model
 * as an earlier one replaces it whole. The result is sorted by provider, then model.
 */
export function mergePrices(...sets: PriceDataset[]): PriceDataset {
  const byKey = new Map<string, PriceEntry>();
  let updated: string | undefined;
  for (const set of sets) {
    if (set.updated !== undefined && updated === undefined) updated = set.updated;
    for (const e of set.prices) byKey.set(`${e.provider}\u0000${e.model}`, e);
  }
  const prices = [...byKey.values()].sort((a, b) =>
    a.provider === b.provider ? (a.model < b.model ? -1 : a.model > b.model ? 1 : 0) : a.provider < b.provider ? -1 : 1,
  );
  return updated === undefined ? { prices } : { updated, prices };
}

/** A lookup over a dataset. */
export interface PriceBook {
  readonly dataset: PriceDataset;
  /**
   * Finds the entry for a model ID or alias. With a provider, only that
   * provider's entries are searched. Without one, the ID must be unique
   * across providers; otherwise the result is `ambiguous`.
   */
  find(model: string, provider?: string): { entry: PriceEntry } | { ambiguous: string[] } | null;
}

/** Builds a {@link PriceBook}. Later entries win when two share an ID within a provider. */
export function createPriceBook(dataset: PriceDataset): PriceBook {
  const byId = new Map<string, Map<string, PriceEntry>>();
  const add = (id: string, e: PriceEntry, overwrite: boolean) => {
    let m = byId.get(id);
    if (!m) byId.set(id, (m = new Map()));
    if (overwrite || !m.has(e.provider)) m.set(e.provider, e);
  };
  // Exact model IDs first, so one entry's alias never shadows another entry's model ID.
  for (const e of dataset.prices) add(e.model, e, true);
  for (const e of dataset.prices) for (const a of e.aliases ?? []) add(a, e, false);
  return {
    dataset,
    find(model, provider) {
      const m = byId.get(model);
      if (!m) return null;
      if (provider !== undefined) {
        const e = m.get(provider);
        return e ? { entry: e } : null;
      }
      if (m.size === 1) return { entry: [...m.values()][0]! };
      return { ambiguous: [...m.keys()].sort() };
    },
  };
}

/** Picks the price block in effect on a UTC date (YYYY-MM-DD). */
export function blockOn(entry: PriceEntry, day: string): { block: PriceBlock; batch?: PriceBlock; effectiveFrom: string | null } {
  let current: { block: PriceBlock; batch?: PriceBlock; effectiveFrom: string | null } = {
    block: entry,
    batch: entry.batch,
    effectiveFrom: null,
  };
  for (const c of entry.changes ?? []) {
    if (c.effective_from <= day) current = { block: c, batch: c.batch, effectiveFrom: c.effective_from };
  }
  return current;
}
