#!/usr/bin/env node
// Validates data/prices.json: JSON Schema, calendar dates, sort order,
// duplicate model IDs and aliases, and the numbers themselves (finite,
// non-negative, within a sane bound, cached rates not above input rates,
// tiers in order, announced changes still in the future).
// With --max-age <days>, also fails when "updated" is older than that,
// as a reminder to re-read every source page. It never edits data.
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Anything above this many USD per million tokens is almost certainly a typo. */
const MAX_RATE = 1000;
const RATE_KEYS = [
  'input_per_mtok',
  'output_per_mtok',
  'cached_input_per_mtok',
  'cache_write_per_mtok',
  'cache_write_1h_per_mtok',
  'audio_input_per_mtok',
  'cached_audio_input_per_mtok',
];

function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function days(from, to) {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

function checkRates(where, block, errors) {
  for (const k of RATE_KEYS) {
    const v = block[k];
    if (v === undefined) continue;
    if (!Number.isFinite(v) || v < 0) errors.push(`${where}: ${k} must be a finite number >= 0`);
    else if (v > MAX_RATE) errors.push(`${where}: ${k} ${v} is above ${MAX_RATE} USD per million tokens`);
  }
  if (block.cached_input_per_mtok !== undefined && block.cached_input_per_mtok > block.input_per_mtok) {
    errors.push(`${where}: cached_input_per_mtok is above input_per_mtok`);
  }
  if (
    block.cached_audio_input_per_mtok !== undefined &&
    block.audio_input_per_mtok !== undefined &&
    block.cached_audio_input_per_mtok > block.audio_input_per_mtok
  ) {
    errors.push(`${where}: cached_audio_input_per_mtok is above audio_input_per_mtok`);
  }
}

function checkBlock(where, block, errors) {
  checkRates(where, block, errors);
  let prev = 0;
  (block.tiers ?? []).forEach((t, i) => {
    checkRates(`${where} tiers[${i}]`, t, errors);
    if (t.above_input_tokens <= prev) errors.push(`${where} tiers[${i}]: above_input_tokens must increase`);
    prev = t.above_input_tokens;
  });
}

function thresholds(block) {
  return (block?.tiers ?? []).map((t) => t.above_input_tokens);
}

/**
 * Returns a list of problems (empty when the dataset is valid).
 * @param {unknown} data parsed prices.json
 * @param {object} schema parsed schema.json
 * @param {{ today: string, maxAge?: number }} opts
 */
export function checkData(data, schema, opts) {
  const errors = [];
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  if (!validate(data)) {
    for (const e of validate.errors ?? []) errors.push(`schema: ${e.instancePath || '/'} ${e.message}`);
    return errors;
  }
  if (!isDate(data.updated)) errors.push(`updated: not a calendar date: ${data.updated}`);
  // One day of slack: the dataset date is local to whoever verified it, the check runs in UTC.
  else if (days(opts.today, data.updated) > 1) errors.push(`updated: ${data.updated} is in the future`);

  const owners = new Map();
  let prev = null;
  data.prices.forEach((e, i) => {
    const where = `prices[${i}] ${e.provider}/${e.model}`;
    if (!isDate(e.checked)) errors.push(`${where}: checked is not a calendar date: ${e.checked}`);
    else if (e.checked > data.updated) errors.push(`${where}: checked ${e.checked} is after updated ${data.updated}`);
    if (prev) {
      const order =
        prev.provider === e.provider
          ? prev.model < e.model ? -1 : prev.model > e.model ? 1 : 0
          : prev.provider < e.provider ? -1 : 1;
      if (order === 0) errors.push(`${where}: duplicate entry`);
      else if (order > 0) errors.push(`${where}: not sorted (must follow ${prev.provider}/${prev.model} by provider, then model)`);
    }
    prev = e;

    // Model IDs are looked up without a provider too, so they must be unique across the whole file.
    for (const id of [e.model, ...(e.aliases ?? [])]) {
      const owner = owners.get(id);
      if (owner !== undefined && owner !== `${e.provider}/${e.model}`) errors.push(`${where}: "${id}" is already used by ${owner}`);
      owners.set(id, `${e.provider}/${e.model}`);
    }
    if ((e.aliases ?? []).includes(e.model)) errors.push(`${where}: an alias repeats the model`);

    checkBlock(where, e, errors);
    if (e.batch && e.batch_discount !== undefined) errors.push(`${where}: has both batch and batch_discount; use one`);
    if (e.batch) {
      checkBlock(`${where} batch`, e.batch, errors);
      const std = thresholds(e);
      for (const t of thresholds(e.batch)) {
        if (!std.includes(t)) errors.push(`${where} batch: tier above ${t} has no matching standard tier`);
      }
    }

    let last = e.checked;
    (e.changes ?? []).forEach((c, k) => {
      const cw = `${where} changes[${k}]`;
      if (!isDate(c.effective_from)) {
        errors.push(`${cw}: effective_from is not a calendar date: ${c.effective_from}`);
        return;
      }
      if (c.effective_from <= last) {
        errors.push(
          k === 0
            ? `${cw}: effective_from ${c.effective_from} is not after checked ${e.checked}; fold it into the current rates`
            : `${cw}: changes must be in date order`,
        );
      }
      last = c.effective_from;
      checkBlock(cw, c, errors);
      if (e.batch && !c.batch) errors.push(`${cw}: the entry has batch rates, so the change must list them too`);
      if (!e.batch && c.batch) errors.push(`${cw}: lists batch rates the current entry does not have`);
      if (c.batch) checkBlock(`${cw} batch`, c.batch, errors);
    });
  });

  if (opts.maxAge !== undefined && isDate(data.updated)) {
    const age = days(data.updated, opts.today);
    if (age > opts.maxAge) {
      errors.push(
        `updated ${data.updated} is ${age} days old (limit ${opts.maxAge}). Re-read every source page, correct what changed, then bump "updated" and "checked".`,
      );
    }
  }
  return errors;
}

function main() {
  const { values } = parseArgs({
    options: {
      'max-age': { type: 'string' },
      today: { type: 'string' },
      data: { type: 'string' },
    },
  });
  const today = values.today ?? new Date().toISOString().slice(0, 10);
  const maxAge = values['max-age'] === undefined ? undefined : Number(values['max-age']);
  const dataFile = values.data ?? join(root, 'data/prices.json');
  const data = JSON.parse(readFileSync(dataFile, 'utf8'));
  const schema = JSON.parse(readFileSync(join(root, 'data/schema.json'), 'utf8'));
  const errors = checkData(data, schema, { today, maxAge });
  if (errors.length > 0) {
    for (const e of errors) console.error(`check-data: ${e}`);
    process.exitCode = 1;
    return;
  }
  const counts = {};
  for (const e of data.prices) counts[e.provider] = (counts[e.provider] ?? 0) + 1;
  const parts = Object.entries(counts).map(([p, n]) => `${p} ${n}`);
  console.log(`check-data: ${data.prices.length} models (${parts.join(', ')}), updated ${data.updated}. OK.`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
