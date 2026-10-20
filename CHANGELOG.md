# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-10-21

### Changed

- Published from GitHub Actions through npm trusted publishing, with a
  provenance attestation linking the package to this repository. No code changes.

## [0.1.0] - 2026-10-16

### Added

- `createMeter()` with `record()`, `estimate()`, `check()` and `summary()`: per-call cost with a breakdown per usage bucket, tags, and summaries by model, tag or UTC day.
- Budgets per tag (including one budget per value with `user:*`) and global, over UTC day or month windows, with `onBudget` at 80% and 100% and `check()` to refuse a call before it is made, optionally with an estimate.
- A pluggable `MeterStore` interface with an in-memory default, and a JSON-file store example.
- SDK-free adapters `fromOpenAI` (Chat Completions and Responses API), `fromAnthropic` (input, cache reads, 5-minute and 1-hour cache writes, output, batch tier) and `fromGemini` (usageMetadata, including cached, tool-use, thinking and audio tokens).
- Unknown models and missing batch or long-context prices give `costUsd: null` with a warning, or throw `UnknownPriceError` with `unknownModel: 'throw'`; never a silent 0.
- `jsonlLogger()` and the `ai-cost-meter` CLI: `price` for a quick estimate, `report` over a JSONL log, `models` to list prices.
- Price dataset of 69 models from OpenAI, Anthropic and the Gemini API, each read from the provider's official pricing page on 2026-10-16, with prompt-length tiers, batch prices, announced price changes, a JSON Schema, `npm run check-data` and a weekly freshness check.

[Unreleased]: https://github.com/BYDTechSolutions/ai-cost-meter/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/BYDTechSolutions/ai-cost-meter/releases/tag/v0.1.1
[0.1.0]: https://github.com/BYDTechSolutions/ai-cost-meter/tree/0a495e7ead06cd3015fcbafeb6463b41fdac559f
