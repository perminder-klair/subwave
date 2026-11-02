// /stats cost and voice figures: a gateway (openai-compatible, OpenRouter, …)
// is priced as the model family its id names, and the TTS summary names its
// slowest render.
import assert from 'node:assert/strict';
import test from 'node:test';

const { estimateCost, summarizeTts } = await import('../src/stats.js');

const usage = { input: 1_000_000, output: 100_000 };

test('a direct provider is priced by its own rows', () => {
  assert.deepEqual(estimateCost('anthropic:claude-sonnet-4-5', usage), { usd: 4.5, priced: true });
  assert.deepEqual(estimateCost('ollama:qwen3:8b', usage), { usd: 0, priced: true });
});

test('a gateway is priced as the family its model id names', () => {
  assert.deepEqual(estimateCost('openai-compatible:claude-sonnet-4-5', usage), { usd: 4.5, priced: true });
  assert.deepEqual(estimateCost('openrouter:openai/gpt-4o-mini', usage), { usd: 0.21, priced: true });
  assert.deepEqual(estimateCost('openrouter:google/gemini-2.5-flash', usage), { usd: 0.105, priced: true });
  assert.equal(estimateCost('requesty:openai/o3-mini', usage).priced, true);
});

test('a gateway serving an unknown model stays unpriced, whatever the gateway is called', () => {
  assert.deepEqual(estimateCost('openai-compatible:llama-3.3-70b', usage), { usd: 0, priced: false });
  assert.deepEqual(estimateCost('openai-compatible:qwen-pro', usage), { usd: 0, priced: false });
});

test('the TTS summary names its slowest render', () => {
  const s = summarizeTts([
    { ok: true, ms: 4_000, kind: 'link' },
    { ok: true, ms: 13_400, kind: 'handoff' },
    { ok: false, kind: 'weather' },
  ]);
  assert.deepEqual(s.slowest, { ms: 13_400, kind: 'handoff' });
  assert.equal(summarizeTts([]).slowest, null);
});
