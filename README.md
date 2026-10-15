# ai-cost-meter

Know what each LLM call costs, per request, per user and per feature, with budgets, without sending usage data anywhere.

[![npm version](https://img.shields.io/npm/v/@bydtech/ai-cost-meter.svg)](https://www.npmjs.com/package/@bydtech/ai-cost-meter)
[![CI](https://github.com/BYDTechSolutions/ai-cost-meter/actions/workflows/ci.yml/badge.svg)](https://github.com/BYDTechSolutions/ai-cost-meter/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Why it exists

Provider dashboards show what you spent yesterday, per API key. They do not show which user, which feature or which prompt spent it, and they cannot stop a runaway loop before the bill arrives. `ai-cost-meter` prices every call in your own process from the token counts the response already carries, tags it, adds it to daily and monthly budgets, and can refuse the next call when a budget is used up. Nothing leaves your machine: no service, no telemetry, no API key.

> **Prices change.** The bundled prices are list prices read from each provider's own pricing page on the date in [`data/prices.json`](data/prices.json) (`updated`, and `checked` per model). Every entry has a `source` URL: check it before relying on a number. Results are **estimates of list price, not your invoice**: discounts, credits, taxes, regional uplifts, priority or flex tiers, tool fees and rounding are not included.

## Install

```sh
npm install @bydtech/ai-cost-meter
```

Node.js 20 or later. No runtime dependencies.

## Quick start

From the command line, a quick estimate:

```text
$ npx @bydtech/ai-cost-meter price gpt-5 --in 1200 --out 300 --cached 4096 --date 2026-10-16
openai/gpt-5  (2026-10-16, standard rates)
  input         1,200 tokens  x $1.25/MTok   = $0.001500
  cached input  4,096 tokens  x $0.125/MTok  = $0.000512
  output          300 tokens  x $10/MTok     = $0.003000
  total                                        $0.005012
source: https://developers.openai.com/api/docs/pricing
List-price estimate; your invoice may differ.
```

In code, record each call with tags and a budget:

```js
import { createMeter, fromOpenAI } from '@bydtech/ai-cost-meter';

const meter = createMeter({
  budgets: [{ tag: 'user:*', window: 'day', limitUsd: 1 }],
  onBudget: (e) => console.log(`${e.tag} is at ${e.threshold * 100}% of $${e.limitUsd} today`),
});

// Use the object your OpenAI client returned; this one is a saved example.
const response = {
  model: 'gpt-5-mini',
  usage: {
    prompt_tokens: 1834,
    completion_tokens: 412,
    prompt_tokens_details: { cached_tokens: 1536 },
  },
};

const tags = ['user:42', 'feature:search'];
if ((await meter.check(tags)).ok) {
  const { costUsd, breakdown } = await meter.record({ ...fromOpenAI(response), tags });
  console.log(costUsd); // 0.0009369
  console.log(breakdown.lines);
  // {
  //   inputTokens: { tokens: 298, ratePerMtok: 0.25, usd: 0.0000745 },
  //   cachedInputTokens: { tokens: 1536, ratePerMtok: 0.025, usd: 0.0000384 },
  //   outputTokens: { tokens: 412, ratePerMtok: 2, usd: 0.000824 }
  // }
}
```

`fromAnthropic(message)` and `fromGemini(response)` work the same way. A fuller example with a file-backed store and a JSONL log is in [`examples/budgets.mjs`](examples/budgets.mjs).

## CLI reference

```text
ai-cost-meter price <model> [options]    estimate the list price of one call
ai-cost-meter report <log.jsonl> [opts]  summarize a log written by jsonlLogger()
ai-cost-meter models [options]           list the models with prices
```

### `price`

| Flag | Default | Meaning |
|---|---|---|
| `--in <n>` | 0 | Uncached input tokens |
| `--out <n>` | 0 | Output tokens, reasoning included |
| `--cached <n>` | 0 | Input tokens read from the prompt cache |
| `--cache-write <n>` | 0 | Input tokens written to the prompt cache (Anthropic: the 5-minute cache) |
| `--cache-write-1h <n>` | 0 | Input tokens written to Anthropic's 1-hour cache |
| `--audio <n>`, `--cached-audio <n>` | 0 | Audio input tokens, for models that price audio separately |
| `--provider <name>` | none | Needed only when a model ID is listed by more than one provider |
| `--batch` | off | Price at batch rates |
| `--date <YYYY-MM-DD>` | today (UTC) | Price as of this date, which matters for announced price changes |

Counts accept `1,200` and `1_200`. When the model is unknown, the CLI prints the closest known IDs and exits 1.

### `report`

Reads the JSONL file written by `jsonlLogger()` and prints cost, calls and tokens per group.

```text
$ npx ai-cost-meter report ai-cost.jsonl --group-by model
ai-cost.jsonl: 5 calls, $0.035050 total, 1 without a price (not in the total)

  COST        CALLS   INPUT  CACHED  OUTPUT  MODEL
  $0.027975       2  18,298  15,000     803  anthropic/claude-sonnet-4-6
  $0.006138       1   5,000   3,000   2,000  google-gemini-api/gemini-2.5-flash
  $0.000937       1   1,834   1,536     412  openai/gpt-5-mini
  $0.000000*      1     800       0     100  my-finetune

* some calls in this group have no price and are not in its cost.
```

| Flag | Default | Meaning |
|---|---|---|
| `--group-by <model\|tag\|day>` | `model` | How to group |
| `--tag-prefix <prefix>` | none | With `--group-by tag`, only tags starting with this, for example `user:` |
| `--since <YYYY-MM-DD>` | none | Calls on or after this UTC day |
| `--until <YYYY-MM-DD>` | none | Calls on or before this UTC day |

The report sums the cost stored with each call; it does not re-price old calls.

### `models`

Lists every model with its base input, output and cached rates, and whether it has tiers, batch prices or announced changes. `--provider <name>` narrows it.

### Common flags

| Flag | Default | Meaning |
|---|---|---|
| `-f, --format <text\|json>` | `text` | Output format |
| `--prices <file>` | none | Merge a custom price file over the bundled one. Repeatable; later files win. |
| `--no-default-prices` | off | Use only the `--prices` files |
| `-h, --help`, `--version` | | |

Exit codes: 0 ok, 1 no price for that model or mode, 2 usage error.

## API reference

### `createMeter(options?) → Meter`

| Method | Returns | What it does |
|---|---|---|
| `record({ provider?, model, usage, tags?, batch?, at? })` | `Promise<CostResult>` | Prices the call, keeps it in the store, adds it to every budget it falls under, fires `onBudget` and `onRecord`. |
| `estimate({ provider?, model, usage, batch?, at? })` | `CostResult` | Prices a call without recording it. |
| `check(tags?, { estimateUsd?, at? })` | `Promise<{ ok, budgets }>` | The budgets that apply to a call with these tags. `ok` is false when one is used up, or when `estimateUsd` would push it over. Call it before the request to block it. |
| `summary({ groupBy?, tagPrefix?, since?, until? })` | `Promise<Summary>` | Totals over the calls in the store, grouped by `model` (default), `tag` or `day`. |
| `prices` | `PriceDataset` | The merged prices in use. |

`CostResult` is `{ provider, model, matchedModel, costUsd, breakdown, warnings }`. `costUsd` is a number in USD, or `null` when the price is unknown: never a silent 0. `breakdown.lines` has `{ tokens, ratePerMtok, usd }` for each usage bucket with tokens, plus `promptTokens`, `tierAboveInputTokens` (the tier applied, or null), `batch`, `priceEffectiveFrom` and `source`.

### Usage

`usage` is a set of token counts in buckets that do not overlap. Every field defaults to 0.

| Field | Tokens |
|---|---|
| `inputTokens` | Uncached input (text, image, video, documents) |
| `cachedInputTokens` | Input read from the prompt cache |
| `cacheWriteTokens` | Input written to the prompt cache (Anthropic: 5-minute) |
| `cacheWrite1hTokens` | Input written to Anthropic's 1-hour cache |
| `audioInputTokens`, `cachedAudioInputTokens` | Audio input, uncached and cached |
| `outputTokens` | Output, including reasoning or thinking tokens |

If you build usage by hand, do not count a token in two buckets: OpenAI's `prompt_tokens` already includes cached tokens, for example. The adapters do this subtraction for you.

### Adapters

They read the response object (an SDK's return value or the raw JSON body) without importing any SDK, and return `{ provider, model, usage, batch, warnings? }` to spread into `record()`. Each takes `{ batch?, model? }` to override what the response says.

| Adapter | Reads | Verified against |
|---|---|---|
| `fromOpenAI(response)` | Chat Completions: `usage.prompt_tokens`, `usage.prompt_tokens_details.cached_tokens`, `usage.prompt_tokens_details.cache_write_tokens`, `usage.completion_tokens`. Responses API: `usage.input_tokens`, `usage.input_tokens_details.cached_tokens`, `usage.input_tokens_details.cache_write_tokens`, `usage.output_tokens`. Uncached input is the total minus cached minus cache writes, as in OpenAI's own cost example. `service_tier` other than default is flagged. | [Chat Completions reference](https://developers.openai.com/api/reference/resources/chat), [Responses reference](https://developers.openai.com/api/reference/resources/responses/methods/create), [Prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching) |
| `fromAnthropic(message)` | `usage.input_tokens`, `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens` split by `usage.cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`, `usage.output_tokens`. `usage.service_tier: "batch"` sets batch; other tiers and a non-global `usage.inference_geo` are flagged. | [Messages API reference](https://platform.claude.com/docs/en/api/messages/create) |
| `fromGemini(response)` | `usageMetadata.promptTokenCount` (includes cached), `cachedContentTokenCount`, `toolUsePromptTokenCount` (counted as input), `candidatesTokenCount` + `thoughtsTokenCount` (output), the `AUDIO` entries of `promptTokensDetails`, `toolUsePromptTokensDetails` and `cacheTokensDetails`, `serviceTier`, and `modelVersion` for the model. Batch is not marked in the response: pass `{ batch: true }`. | [generateContent reference, UsageMetadata](https://ai.google.dev/api/generate-content#UsageMetadata) |

For streams: pass OpenAI's last chunk with `stream_options: { include_usage: true }` (or the `response` of `response.completed`), Anthropic's final message, or Gemini's last chunk.

### Other exports

- `estimateCost(input, { prices?, defaultPrices? })`: price one call with no meter. Never throws for a missing price; the reason is in `warnings`.
- `jsonlLogger(file)`: an `onRecord` callback that appends each record as one JSON line (synchronous append). `readJsonl(file)` and `parseJsonl(text)` read it back; `summarize(records, options)` is what `summary()` and the CLI use.
- `memoryStore({ maxRecords })`: the default store.
- `defaultPrices()`, `validatePrices(value)`, `loadPricesFile(file)`, `mergePrices(...sets)`, `createPriceBook(dataset)`, `buildPriceBook(prices?, useDefaults?)`, `priceCall(book, input)`, `normalizeUsage(usage)`.
- Errors: `UsageError` (bad arguments or data), `UnknownPriceError` (missing price with `unknownModel: 'throw'`).

All types are exported.

## Configuration

`createMeter` options, all optional:

| Option | Default | Meaning |
|---|---|---|
| `prices` | none | Your own entries (a dataset or an array), merged over the bundled ones. Same provider and model replaces the bundled entry. |
| `defaultPrices` | `true` | `false` uses only `prices`. |
| `budgets` | `[]` | Spending limits; see below. |
| `onBudget(event)` | none | Called once when a budget first reaches 80% and once at 100% in each window. `event` is `{ budgetId, tag, window, period, threshold, spentUsd, limitUsd }`. |
| `onRecord(record)` | none | Called with every recorded call. Use `jsonlLogger(file)` to write a log. |
| `store` | `memoryStore()` | Where counters and records live; see below. |
| `unknownModel` | `'warn'` | When a price is missing (unknown model, or no batch or long-context price listed): `'warn'` returns `costUsd: null` and warns; `'throw'` throws `UnknownPriceError`. |
| `onWarning(message)` | `process.emitWarning` | Receives each distinct warning once. |
| `now()` | `() => new Date()` | The clock, for tests and replays. |

### Budgets

```js
budgets: [
  { window: 'month', limitUsd: 500 },                       // everything
  { tag: 'feature:search', window: 'day', limitUsd: 20 },  // calls tagged feature:search
  { tag: 'user:*', window: 'day', limitUsd: 0.5 },          // each user:<id> separately
]
```

`window` is `day` (resets at 00:00 UTC) or `month` (the 1st, 00:00 UTC). A tag ending in `:*` creates one budget per value. `id` defaults to `<tag or "global">/<window>`. Calls without a price are not counted. Budgets are checked when you call `check()`: the meter never blocks a call on its own, since it only sees the call after it was made.

### Stores

The default store keeps counters and up to 100,000 records in memory, so budgets reset when the process restarts and are not shared between processes. To share or persist them, pass an object with four methods (each may return a promise):

```ts
interface MeterStore {
  increment(key: string, amount: number): number | Promise<number>; // atomic; returns the new total
  get(key: string): number | Promise<number>;
  append(record: MeterRecord): void | Promise<void>;
  records(): MeterRecord[] | Promise<MeterRecord[]>;
}
```

`increment` must be atomic (Redis `INCRBYFLOAT`, a SQL `UPDATE ... RETURNING`), so exactly one caller sees a threshold being crossed. [`examples/json-file-store.mjs`](examples/json-file-store.mjs) is a single-process example that keeps everything in one JSON file; it is not part of the package.

### Custom prices

A price file has the shape of [`data/prices.json`](data/prices.json); only `provider`, `model`, `input_per_mtok` and `output_per_mtok` are required. Use it for negotiated rates, your gateway's model names, or a dated snapshot ID that responses report. See [`examples/custom-prices.json`](examples/custom-prices.json).

## The price data

`data/prices.json` holds 69 models, each read on 2026-10-16 from the provider's official pricing page:

| Provider key | Models | Source |
|---|---|---|
| `openai` | 43 (the text models in the flagship table, plus `chat-latest`, `gpt-5.3-codex`, `gpt-5-search-api`) | [developers.openai.com/api/docs/pricing](https://developers.openai.com/api/docs/pricing) |
| `anthropic` | 16 (every model on the page that is available on the Claude API) | [platform.claude.com/docs/en/about-claude/pricing](https://platform.claude.com/docs/en/about-claude/pricing) |
| `google-gemini-api` | 10 (the text-generation models) | [ai.google.dev/gemini-api/docs/pricing](https://ai.google.dev/gemini-api/docs/pricing) |

Each entry has rates in USD per million tokens and only the rates the page lists:

- `input_per_mtok`, `output_per_mtok`, and where listed `cached_input_per_mtok`, `cache_write_per_mtok`, `cache_write_1h_per_mtok`, `audio_input_per_mtok`, `cached_audio_input_per_mtok`.
- `tiers`: rates that replace the base rates when the prompt is longer than `above_input_tokens` (OpenAI above 272K, Claude Haiku 5.5 above 100,000, some Gemini models above 200K). Prompt length counts cached and cache-write tokens.
- `batch_discount` where the page states one flat batch discount (Anthropic: 50%, with cache prices discounted too), or `batch` with the batch table's own numbers where the page lists them per model (OpenAI, Gemini). Models with neither have no batch price.
- `changes`: price changes the page announces with a date. Gemini 4 Argon, Gemini 3.8 Flash and Gemini 3.6 Flash list higher prices from December 1, 2026 and January 1, 2027; the meter uses the rates in effect on the UTC date of each call.
- `notes`, `source`, `checked`.

`npm run check-data` validates the file against [`data/schema.json`](data/schema.json) and checks sort order, duplicate IDs (across providers too), that every number is finite, non-negative and under $1,000 per million, that cached rates do not exceed input rates, that tiers are in order and that announced changes are still in the future. A weekly workflow fails when `updated` is more than 30 days old, as a reminder to re-read the pages; it never edits the data.

Left out on purpose: models priced per minute, per image or per second, realtime and audio-generation models, embeddings, image and video models, fine-tuned model inference, Anthropic models retired from the Claude API, OpenAI's limited-access cyber and life-sciences models, and Gemini Live, TTS and transcription models. Add any of them with `prices`.

## How it works, and its limits

Each call is priced as `tokens × rate / 1,000,000` per usage bucket, summed, at the rates in effect on the call's UTC date, at the tier its prompt length falls in, at batch rates when asked. Records go to the store; budgets are counters keyed by budget, tag and window. The JSONL logger and the CLI use only the Node standard library.

When a rate is not listed, the meter does not guess low: cached tokens without a cached rate, and cache writes without a cache-write rate, are charged at the input rate, and the result carries a warning. When a whole price is missing (unknown model, a batch request on a model with no batch price, a long prompt with no long-context batch price), `costUsd` is `null`.

Not modeled, so not in the number:

- Discounts, credits, committed-use pricing, taxes and currency conversion.
- Regional or data-residency uplifts (OpenAI and Anthropic list 10% for some endpoints), Anthropic's US-only inference multiplier, priority, flex and fast modes. Adapters warn when a response shows one of these.
- Tool fees (web search, code execution containers, grounding), context-cache storage billed per hour, and free tiers.
- Gemini `toolUsePromptTokenCount` is counted as input; whether a given tool's tokens are billed is up to that tool's pricing.
- Model IDs are matched exactly. A dated snapshot such as `gpt-4o-2024-08-06` is unknown unless you add it, because the page may price it differently from the alias.
- Budget windows are UTC. Totals are floating-point sums, rounded to 1e-12 USD.

## Contributing

Corrections to the price data are the most useful contribution; see [CONTRIBUTING.md](CONTRIBUTING.md). Issues and pull requests are welcome at [github.com/BYDTechSolutions/ai-cost-meter](https://github.com/BYDTechSolutions/ai-cost-meter).

## License

[MIT](LICENSE)

---

Maintained by [BYD Tech](https://bydtech.in), a software studio that builds MVPs, AI agents, and web & mobile apps.
