import { appendFileSync, readFileSync } from 'node:fs';
import { UsageError, type MeterRecord } from './types.js';

/**
 * Returns an `onRecord` callback that appends each record to a file as one
 * JSON line, for `ai-cost-meter report`. Writes are synchronous appends, so a
 * line is on disk when `record()` resolves. The file stays on your machine.
 */
export function jsonlLogger(file: string): (record: MeterRecord) => void {
  if (typeof file !== 'string' || file === '') throw new UsageError('jsonlLogger needs a file path');
  return (record) => {
    appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  };
}

function isRecord(v: unknown): v is MeterRecord {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.ts === 'string' &&
    typeof r.model === 'string' &&
    (r.costUsd === null || typeof r.costUsd === 'number') &&
    (r.tags === undefined || (Array.isArray(r.tags) && r.tags.every((t) => typeof t === 'string')))
  );
}

/** Parses JSONL text written by {@link jsonlLogger}. Blank lines are skipped; a bad line throws with its number. */
export function parseJsonl(text: string, label = 'log'): MeterRecord[] {
  const out: MeterRecord[] = [];
  text.split('\n').forEach((line, i) => {
    const s = line.trim();
    if (s === '') return;
    let v: unknown;
    try {
      v = JSON.parse(s);
    } catch {
      throw new UsageError(`${label}:${i + 1}: not valid JSON`);
    }
    if (!isRecord(v)) throw new UsageError(`${label}:${i + 1}: not a meter record (needs ts, model, costUsd)`);
    out.push({ ...v, tags: v.tags ?? [] });
  });
  return out;
}

/** Reads a JSONL log written by {@link jsonlLogger}. */
export function readJsonl(file: string): MeterRecord[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new UsageError(`cannot read log file: ${file}`);
  }
  return parseJsonl(text, file);
}
