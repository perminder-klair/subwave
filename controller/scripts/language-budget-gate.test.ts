// Language AI fallback is an optional background model task. It must obey the
// shared LLM budget before entering the provider, and a denied batch must stay
// retryable rather than being written as an unknown language.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const state = mkdtempSync(join(tmpdir(), 'subwave-language-budget-'));
process.env.STATE_DIR = state;

const settings = await import('../src/settings.js');
const { addDailyUsage } = await import('../src/llm/internal/telemetry/budget.js');
const { detectWithAi } = await import('../src/music/language-tagger.js');

await settings.load();

test.after(() => {
  rmSync(state, { recursive: true, force: true });
});

test('language AI fallback is denied before the provider at the budget limit', async (t) => {
  await settings.update({ llm: { dailyTokenCap: 100, budgetSoftPct: 80 } } as never);
  addDailyUsage(100);

  let providerCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    providerCalls += 1;
    throw new Error('the provider must not be reached');
  });

  await assert.rejects(
    detectWithAi(['This is a deliberately long lyric excerpt '.repeat(8)]),
    (error: unknown) => (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'LLM_BUDGET_EXHAUSTED'
    ),
  );
  assert.equal(providerCalls, 0, 'the budget gate runs before any provider request');
});
