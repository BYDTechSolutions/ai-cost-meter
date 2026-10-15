// An example MeterStore that keeps budget counters and records in one JSON
// file, so budgets survive a restart. It is for a single process: it reads
// and rewrites the whole file on every change, and two processes writing the
// same file will lose updates. For several processes, implement the same four
// methods over Redis (INCRBYFLOAT is atomic) or a database.
//
// This file is an example, not part of the published package. Copy it.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/**
 * @param {string} file path of the JSON file (created if missing)
 * @param {{ maxRecords?: number }} [opts]
 * @returns {import('@bydtech/ai-cost-meter').MeterStore}
 */
export function jsonFileStore(file, opts = {}) {
  const maxRecords = opts.maxRecords ?? 10_000;
  let state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { counters: {}, records: [] };

  function save() {
    // Write to a temporary file and rename, so a crash never leaves half a file.
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, file);
  }

  return {
    increment(key, amount) {
      state.counters[key] = (state.counters[key] ?? 0) + amount;
      save();
      return state.counters[key];
    },
    get(key) {
      return state.counters[key] ?? 0;
    },
    append(record) {
      state.records.push(record);
      if (state.records.length > maxRecords) state.records = state.records.slice(-maxRecords);
      save();
    },
    records() {
      return state.records.slice();
    },
  };
}
