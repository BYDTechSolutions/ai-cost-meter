/**
 * @bydtech/ai-cost-meter: know what each LLM call costs, per request, per
 * user and per feature, with budgets. Everything runs in your process; no
 * usage data is sent anywhere.
 *
 * @packageDocumentation
 */
export { createMeter, estimateCost, buildPriceBook } from './meter.js';
export type { Meter, MeterOptions, RecordInput, CheckResult } from './meter.js';
export { fromOpenAI, fromAnthropic, fromGemini } from './adapters.js';
export type { AdapterOptions } from './adapters.js';
export { priceCall, normalizeUsage } from './cost.js';
export type { PricedResult } from './cost.js';
export { defaultPrices, validatePrices, loadPricesFile, mergePrices, createPriceBook } from './prices.js';
export type { PriceBook } from './prices.js';
export type { Budget, BudgetEvent, BudgetStatus } from './budgets.js';
export { memoryStore } from './store.js';
export type { MeterStore, MemoryStoreOptions } from './store.js';
export { summarize, UNTAGGED } from './summary.js';
export type { Summary, SummaryGroup, SummaryOptions } from './summary.js';
export { jsonlLogger, readJsonl, parseJsonl } from './log.js';
export { UsageError, UnknownPriceError, USAGE_KEYS } from './types.js';
export type {
  BreakdownLine,
  CostBreakdown,
  CostInput,
  CostResult,
  MeterRecord,
  NormalizedCall,
  PriceBlock,
  PriceChange,
  PriceDataset,
  PriceEntry,
  Rates,
  Tier,
  Usage,
  UsageKey,
} from './types.js';
