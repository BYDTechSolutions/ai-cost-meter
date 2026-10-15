#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pkg from '../package.json' with { type: 'json' };
import { priceCall } from './cost.js';
import { readJsonl } from './log.js';
import { buildPriceBook } from './meter.js';
import { defaultPrices, loadPricesFile, mergePrices, type PriceBook } from './prices.js';
import { summarize, type Summary } from './summary.js';
import { USAGE_KEYS, UsageError, type CostResult, type PriceDataset, type Usage, type UsageKey } from './types.js';

const HELP = `Usage:
  ai-cost-meter price <model> [options]    estimate the list price of one call
  ai-cost-meter report <log.jsonl> [opts]  summarize a log written by jsonlLogger()
  ai-cost-meter models [options]           list the models with prices

Price options:
      --in <n>              uncached input tokens (default 0)
      --out <n>             output tokens, reasoning included (default 0)
      --cached <n>          input tokens read from the prompt cache
      --cache-write <n>     input tokens written to the prompt cache (Anthropic: 5-minute)
      --cache-write-1h <n>  input tokens written to Anthropic's 1-hour cache
      --audio <n>           uncached audio input tokens
      --cached-audio <n>    cached audio input tokens
      --provider <name>     provider key, when a model ID is not unique
      --batch               price at batch rates
      --date <YYYY-MM-DD>   price as of this date (default: today, UTC)

Report options:
      --group-by <model|tag|day>  default: model
      --tag-prefix <prefix>       with --group-by tag, only tags starting with this
      --since <YYYY-MM-DD>        only calls on or after this day (UTC)
      --until <YYYY-MM-DD>        only calls on or before this day (UTC)

Models options:
      --provider <name>     only this provider

Common options:
  -f, --format <text|json>  output format (default: text)
      --prices <file>       merge a custom price file over the bundled one (repeatable)
      --no-default-prices   use only the --prices files
  -h, --help                show this help
      --version             show the version

Prices are list prices read from each provider's pricing page on the date in
the dataset. They are estimates, not your invoice.

Exit codes: 0 ok, 1 no price for that model or mode, 2 usage error.
`;

export interface CliIO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  cwd?: string;
}

/** Runs the CLI with `argv` (without the node and script paths) and returns the exit code. */
export function run(argv: string[], io: CliIO): number {
  try {
    return main(argv, io);
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`ai-cost-meter: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(s: string, flag: string): Date {
  const d = new Date(`${s}T00:00:00Z`);
  if (!DATE.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new UsageError(`invalid ${flag} "${s}": expected YYYY-MM-DD`);
  }
  return d;
}

function parseCount(s: string | undefined, flag: string): number {
  if (s === undefined) return 0;
  const t = s.replace(/[_,]/g, '');
  if (!/^\d+$/.test(t)) throw new UsageError(`invalid ${flag} "${s}": expected a whole number of tokens`);
  return Number(t);
}

function formatUsd(v: number): string {
  const a = Math.abs(v);
  return `$${v.toFixed(a >= 100 ? 2 : a >= 1 ? 4 : 6)}`;
}

function formatInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function formatRate(r: number): string {
  return `$${Number(r.toPrecision(10))}/MTok`;
}

const LABELS: Record<UsageKey, string> = {
  inputTokens: 'input',
  cachedInputTokens: 'cached input',
  cacheWriteTokens: 'cache write',
  cacheWrite1hTokens: 'cache write 1h',
  audioInputTokens: 'audio input',
  cachedAudioInputTokens: 'cached audio',
  outputTokens: 'output',
};

function main(argv: string[], io: CliIO): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        in: { type: 'string' },
        out: { type: 'string' },
        cached: { type: 'string' },
        'cache-write': { type: 'string' },
        'cache-write-1h': { type: 'string' },
        audio: { type: 'string' },
        'cached-audio': { type: 'string' },
        provider: { type: 'string' },
        batch: { type: 'boolean' },
        date: { type: 'string' },
        'group-by': { type: 'string' },
        'tag-prefix': { type: 'string' },
        since: { type: 'string' },
        until: { type: 'string' },
        format: { type: 'string', short: 'f' },
        prices: { type: 'string', multiple: true },
        'no-default-prices': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' },
      },
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout(HELP);
    return 0;
  }
  if (values.version) {
    io.stdout(`${pkg.version}\n`);
    return 0;
  }
  const format = values.format ?? 'text';
  if (format !== 'text' && format !== 'json') throw new UsageError(`invalid --format "${format}": expected text or json`);
  const [command, ...rest] = positionals;
  const cwd = io.cwd ?? process.cwd();

  const sets: PriceDataset[] = [];
  if (!values['no-default-prices']) sets.push(defaultPrices());
  for (const f of values.prices ?? []) sets.push(loadPricesFile(resolve(cwd, f)));
  if (sets.length === 0) throw new UsageError('--no-default-prices needs at least one --prices file');
  const dataset = sets.length === 1 ? sets[0]! : mergePrices(...sets);

  switch (command) {
    case 'price':
      return price(rest, values, buildPriceBook(dataset, false), format, io);
    case 'report':
      return report(rest, values, cwd, format, io);
    case 'models':
      return models(rest, values, dataset, format, io);
    case undefined:
      io.stdout(HELP);
      return 2;
    default:
      throw new UsageError(`unknown command "${command}". Run ai-cost-meter --help`);
  }
}

type Values = Record<string, string | boolean | string[] | undefined>;

function suggest(book: PriceBook, model: string): string[] {
  const q = model.toLowerCase();
  const ids = book.dataset.prices.flatMap((e) => [e.model, ...(e.aliases ?? [])]);
  return ids.filter((id) => id.toLowerCase().includes(q) || q.includes(id.toLowerCase())).slice(0, 8);
}

function price(args: string[], v: Values, book: PriceBook, format: string, io: CliIO): number {
  if (args.length !== 1) throw new UsageError('price needs exactly one model ID, for example: ai-cost-meter price gpt-5 --in 1200 --out 300');
  const model = args[0]!;
  const usage: Usage = {
    inputTokens: parseCount(v.in as string | undefined, '--in'),
    outputTokens: parseCount(v.out as string | undefined, '--out'),
    cachedInputTokens: parseCount(v.cached as string | undefined, '--cached'),
    cacheWriteTokens: parseCount(v['cache-write'] as string | undefined, '--cache-write'),
    cacheWrite1hTokens: parseCount(v['cache-write-1h'] as string | undefined, '--cache-write-1h'),
    audioInputTokens: parseCount(v.audio as string | undefined, '--audio'),
    cachedAudioInputTokens: parseCount(v['cached-audio'] as string | undefined, '--cached-audio'),
  };
  const at = v.date === undefined ? new Date() : parseDay(v.date as string, '--date');
  const provider = v.provider as string | undefined;
  const { missing, ...result } = priceCall(book, { model, usage, batch: v.batch === true, at, ...(provider ? { provider } : {}) });
  if (missing) result.warnings.push(missing);
  const entry = result.costUsd === null ? undefined : book.find(result.matchedModel ?? model, result.provider ?? undefined);
  const notes = entry && 'entry' in entry ? entry.entry.notes : undefined;

  if (format === 'json') {
    io.stdout(`${JSON.stringify({ date: at.toISOString().slice(0, 10), ...result, notes: notes ?? null }, null, 2)}\n`);
    return result.costUsd === null ? 1 : 0;
  }
  if (result.costUsd === null) {
    for (const w of result.warnings) io.stderr(`ai-cost-meter: ${w}\n`);
    const near = missing?.startsWith('no price for model') ? suggest(book, model) : [];
    if (near.length) io.stderr(`Known models like it: ${near.join(', ')}\n`);
    return 1;
  }
  io.stdout(formatPrice(result, at, notes));
  return 0;
}

function formatPrice(r: CostResult, at: Date, notes: string | undefined): string {
  const b = r.breakdown!;
  const name = `${r.provider}/${r.matchedModel ?? r.model}`;
  const mode = [b.batch ? 'batch rates' : 'standard rates'];
  if (b.tierAboveInputTokens !== null) mode.push(`prompt over ${formatInt(b.tierAboveInputTokens)} tokens`);
  if (b.priceEffectiveFrom) mode.push(`prices from ${b.priceEffectiveFrom}`);
  const lines = [`${name}  (${at.toISOString().slice(0, 10)}, ${mode.join(', ')})`];
  const rows = USAGE_KEYS.filter((k) => b.lines[k]).map((k) => {
    const l = b.lines[k]!;
    return [LABELS[k], `${formatInt(l.tokens)} tokens`, `x ${formatRate(l.ratePerMtok)}`, formatUsd(l.usd)];
  });
  const w = [0, 1, 2].map((i) => Math.max(0, ...rows.map((row) => row[i]!.length)));
  for (const row of rows) lines.push(`  ${row[0]!.padEnd(w[0]!)}  ${row[1]!.padStart(w[1]!)}  ${row[2]!.padEnd(w[2]!)}  = ${row[3]}`);
  lines.push(`  ${'total'.padEnd(w[0]! + w[1]! + w[2]! + 4)}    ${formatUsd(r.costUsd!)}`);
  if (b.source) lines.push(`source: ${b.source}`);
  if (notes) lines.push(`notes: ${notes}`);
  for (const warning of r.warnings) lines.push(`warning: ${warning}`);
  lines.push('List-price estimate; your invoice may differ.');
  return `${lines.join('\n')}\n`;
}

function report(args: string[], v: Values, cwd: string, format: string, io: CliIO): number {
  if (args.length !== 1) throw new UsageError('report needs exactly one log file');
  const groupBy = (v['group-by'] as string | undefined) ?? 'model';
  if (groupBy !== 'model' && groupBy !== 'tag' && groupBy !== 'day') {
    throw new UsageError(`invalid --group-by "${groupBy}": expected model, tag or day`);
  }
  const since = v.since === undefined ? undefined : parseDay(v.since as string, '--since');
  const untilDay = v.until === undefined ? undefined : parseDay(v.until as string, '--until');
  const until = untilDay ? new Date(untilDay.getTime() + 86_400_000) : undefined;
  const file = args[0]!;
  const records = readJsonl(resolve(cwd, file));
  const s = summarize(records, {
    groupBy,
    ...(v['tag-prefix'] !== undefined ? { tagPrefix: v['tag-prefix'] as string } : {}),
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
  });
  io.stdout(format === 'json' ? `${JSON.stringify(s, null, 2)}\n` : formatReport(file, s));
  return 0;
}

function formatReport(file: string, s: Summary): string {
  const head = `${file}: ${formatInt(s.calls)} calls, ${formatUsd(s.costUsd)} total${s.unpricedCalls ? `, ${formatInt(s.unpricedCalls)} without a price (not in the total)` : ''}`;
  if (s.groups.length === 0) return `${head}\n`;
  const rows = [
    ['COST', 'CALLS', 'INPUT', 'CACHED', 'OUTPUT', s.groupBy.toUpperCase()],
    ...s.groups.map((g) => [
      formatUsd(g.costUsd) + (g.unpricedCalls ? '*' : ''),
      formatInt(g.calls),
      formatInt(g.inputTokens),
      formatInt(g.cachedInputTokens),
      formatInt(g.outputTokens),
      g.key,
    ]),
  ];
  const w = [0, 1, 2, 3, 4].map((i) => Math.max(...rows.map((r) => r[i]!.length)));
  const lines = [head, ''];
  for (const r of rows) {
    lines.push(`  ${r[0]!.padEnd(w[0]!)}  ${r.slice(1, 5).map((c, i) => c.padStart(w[i + 1]!)).join('  ')}  ${r[5]}`);
  }
  if (s.groups.some((g) => g.unpricedCalls)) lines.push('', '* some calls in this group have no price and are not in its cost.');
  if (s.groupBy === 'tag') lines.push('', 'A call with several tags is counted in each of its groups.');
  return `${lines.join('\n')}\n`;
}

function models(args: string[], v: Values, dataset: PriceDataset, format: string, io: CliIO): number {
  if (args.length > 0) throw new UsageError(`unexpected argument for models: ${args[0]}`);
  let list = dataset.prices;
  const provider = v.provider as string | undefined;
  if (provider !== undefined) {
    const providers = [...new Set(list.map((e) => e.provider))].sort();
    if (!providers.includes(provider)) throw new UsageError(`unknown provider "${provider}". Known: ${providers.join(', ')}`);
    list = list.filter((e) => e.provider === provider);
  }
  if (format === 'json') {
    io.stdout(`${JSON.stringify({ ...(dataset.updated ? { updated: dataset.updated } : {}), prices: list }, null, 2)}\n`);
    return 0;
  }
  const rows = list.map((e) => [
    `${e.provider}/${e.model}`,
    `in ${formatRate(e.input_per_mtok)}`,
    `out ${formatRate(e.output_per_mtok)}`,
    e.cached_input_per_mtok !== undefined ? `cached ${formatRate(e.cached_input_per_mtok)}` : '',
    [e.tiers ? 'tiered' : '', e.batch || e.batch_discount !== undefined ? 'batch' : '', e.changes ? 'changes' : ''].filter(Boolean).join(' '),
  ]);
  const w = [0, 1, 2, 3].map((i) => Math.max(0, ...rows.map((r) => r[i]!.length)));
  const lines = rows.map((r) => `${r.slice(0, 4).map((c, i) => c.padEnd(w[i]!)).join('  ')}  ${r[4]}`.trimEnd());
  lines.push(`${list.length} models${dataset.updated ? `, prices checked ${dataset.updated}` : ''}. Rates are USD per million tokens, base tier.`);
  io.stdout(`${lines.join('\n')}\n`);
  return 0;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = run(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
}
