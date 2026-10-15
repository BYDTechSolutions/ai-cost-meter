// A meter with a daily budget per user and a monthly budget for one feature,
// fed with a saved response, so it runs without calling any provider.
//
//   npm run build && node examples/budgets.mjs
import { createMeter, fromAnthropic, jsonlLogger } from '@bydtech/ai-cost-meter';
import { jsonFileStore } from './json-file-store.mjs';

const meter = createMeter({
  store: jsonFileStore('meter-state.json'),
  onRecord: jsonlLogger('ai-cost.jsonl'),
  budgets: [
    { tag: 'user:*', window: 'day', limitUsd: 0.05 },
    { tag: 'feature:search', window: 'month', limitUsd: 20 },
  ],
  onBudget: (e) => console.log(`budget ${e.budgetId} for ${e.tag ?? 'everyone'} reached ${e.threshold * 100}%: $${e.spentUsd.toFixed(4)} of $${e.limitUsd}`),
});

// What client.messages.create() returned (trimmed to the fields that matter).
const message = {
  model: 'claude-sonnet-4-6',
  usage: {
    input_tokens: 50,
    cache_creation_input_tokens: 2048,
    cache_read_input_tokens: 10000,
    cache_creation: { ephemeral_5m_input_tokens: 2048, ephemeral_1h_input_tokens: 0 },
    output_tokens: 503,
  },
};

const tags = ['user:42', 'feature:search'];
for (let i = 0; i < 4; i++) {
  const gate = await meter.check(tags, { estimateUsd: 0.02 });
  if (!gate.ok) {
    console.log('blocked before the call:', gate.budgets.filter((b) => b.exceeded).map((b) => b.budgetId).join(', '));
    break;
  }
  const { costUsd } = await meter.record({ ...fromAnthropic(message), tags });
  console.log(`call ${i + 1}: $${costUsd.toFixed(6)}`);
}

console.log(await meter.summary({ groupBy: 'tag' }));
console.log('Log written to ai-cost.jsonl; try: npx ai-cost-meter report ai-cost.jsonl');
