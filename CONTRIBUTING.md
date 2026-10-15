# Contributing

Thanks for helping. Issues and pull requests are welcome at
[github.com/BYDTechSolutions/ai-cost-meter](https://github.com/BYDTechSolutions/ai-cost-meter).

## Correcting the price data

Most useful contributions are price corrections: a price that changed, a model
that was added, a tier or batch price that is missing.

1. Find the price on the provider's **own** pricing page. News articles, blog
   posts, forum threads, emails, aggregator sites and third-party calculators
   are not accepted as sources. Never fill a number from memory.
2. Edit [`data/prices.json`](data/prices.json). Every entry needs `provider`,
   `model`, `input_per_mtok`, `output_per_mtok`, `source` (the exact URL you
   read) and `checked` (the date you read it). Add other rates only when the
   page lists them; a rate shown as "-" or not shown is left out, not set to 0.
   - Prompt-length pricing goes in `tiers`, with the threshold the page states.
   - A flat batch discount the page states for every rate goes in
     `batch_discount`; a per-model batch table goes in `batch`, copied as listed.
   - A future price the page announces with a date goes in `changes`. Once that
     date has passed, fold it into the current rates and remove it.
   - Anything else the page says about the price goes in `notes`.
   When the page is ambiguous, leave the model or field out and say so in the
   pull request.
3. Keep entries sorted by `provider`, then `model`. Model IDs and aliases must be
   unique across the whole file. Run:

   ```sh
   npm run check-data   # schema, order, duplicates, numbers, tiers, changes
   npm test
   ```

4. In the pull request, link the source and quote the row you used.

When re-verifying the whole dataset, re-read every source page, update each
`checked` date and the top-level `updated` date. The weekly "Data freshness"
workflow fails once `updated` is more than 30 days old.

## Code

```sh
npm ci
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

Node.js 20 or later.

- No runtime dependencies.
- Adapters read response fields by name and never import a provider SDK. A new
  field needs a link to the provider's API reference in the README table and a
  realistic fixture in `test/fixtures`.
- Tests must not call any provider API.
- Add a line to `CHANGELOG.md` under "Unreleased".
- American English in code, messages and docs.
