// Unit tests for the pure LLM helpers — the regression-critical bits of the
// llm/ rewrite. Run: `npm run test:llm` (tsx scripts/llm-pure.test.ts).
//
// These functions are side-effect-free and unit-pinned here so a wiring slip
// (a provider routed to the wrong path, a thinking knob flipped, the failover
// gate widened) fails an assert BEFORE it ever reaches a model. Matches the
// node:assert-via-tsx style of scripts/picker-recency-regression.ts.

import assert from 'node:assert/strict';
import { stripThinking, extractJson, usageOf, isUnreachable, isTransient } from '../src/llm/internal/core/pure.js';
import { withDeadline } from '../src/llm/internal/core/retry.js';
import { providerOptions, needsToolCallObject, repeatPenaltyApplies, appliedNumCtx } from '../src/llm/internal/provider/capabilities.js';
import { agentPlan } from '../src/llm/internal/strategy/plan.js';
import { introBudgetPhrase, enforceIntroBudget } from '../src/llm/internal/prompts/intro-budget.js';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

async function main() {
  // ---- failover gate: isUnreachable ⊂ isTransient, but EXCLUDES 5xx/429 ----
  console.log('isUnreachable vs isTransient (the failover gate):');
  await test('500 is transient but NOT unreachable', () => {
    assert.equal(isTransient({ statusCode: 500 }), true);
    assert.equal(isUnreachable({ statusCode: 500 }), false);
  });
  await test('429 is transient but NOT unreachable', () => {
    assert.equal(isTransient({ statusCode: 429 }), true);
    assert.equal(isUnreachable({ statusCode: 429 }), false);
  });
  await test('ECONNREFUSED is both transient and unreachable', () => {
    assert.equal(isTransient({ code: 'ECONNREFUSED' }), true);
    assert.equal(isUnreachable({ code: 'ECONNREFUSED' }), true);
  });
  await test('ENOTFOUND is unreachable (DNS down)', () => {
    assert.equal(isUnreachable({ code: 'ENOTFOUND' }), true);
  });
  await test('cause.code is unwrapped', () => {
    assert.equal(isUnreachable({ cause: { code: 'ECONNREFUSED' } }), true);
  });
  await test('AgentDeadlineError is NOT unreachable (model overthinking ≠ host down)', async () => {
    const e: any = new Error('x exceeded 1000ms deadline');
    e.name = 'AgentDeadlineError';
    assert.equal(isUnreachable(e), false);
    assert.equal(isTransient(e), false);
    // And the real withDeadline produces exactly that error.
    const thrown = await withDeadline(20, 'race', () => new Promise<never>(() => {})).catch((x) => x);
    assert.equal(thrown.name, 'AgentDeadlineError');
    assert.equal(isUnreachable(thrown), false);
  });

  // ---- per-provider thinking knob (the single most regression-prone mapping) ----
  console.log('providerOptions(cfg, {reasoning, forceNoThink}):');
  await test('ollama: think tracks raw reasoning toggle', () => {
    assert.deepEqual(providerOptions({ provider: 'ollama', model: 'qwen3', reasoning: false }), { ollama: { think: false } });
    assert.deepEqual(providerOptions({ provider: 'ollama', model: 'qwen3', reasoning: true }), { ollama: { think: true } });
  });
  await test('ollama: repeat_penalty + num_ctx ride in options (local only)', () => {
    assert.deepEqual(
      providerOptions({ provider: 'ollama', model: 'qwen3', numCtx: 16384 }, { repeatPenalty: 1.2 }),
      { ollama: { think: false, options: { repeat_penalty: 1.2, num_ctx: 16384 } } },
    );
    // :cloud models manage their own context — no num_ctx.
    assert.deepEqual(
      providerOptions({ provider: 'ollama', model: 'glm-5.1:cloud', numCtx: 16384 }),
      { ollama: { think: false } },
    );
  });
  await test('deepseek: reasoning:false (or forceNoThink) DISABLES thinking', () => {
    assert.deepEqual(providerOptions({ provider: 'deepseek', model: 'deepseek-v4-flash', reasoning: false }), { deepseek: { thinking: { type: 'disabled' } } });
    assert.deepEqual(providerOptions({ provider: 'deepseek', model: 'deepseek-v4-flash', reasoning: true }), { deepseek: { thinking: { type: 'enabled' } } });
    assert.deepEqual(providerOptions({ provider: 'deepseek', model: 'deepseek-v4-flash', reasoning: true }, { forceNoThink: true }), { deepseek: { thinking: { type: 'disabled' } } });
  });
  await test('anthropic: adaptive only when reasoning on AND not forced-tool', () => {
    assert.deepEqual(providerOptions({ provider: 'anthropic', model: 'claude-haiku-4.5', reasoning: true }), { anthropic: { thinking: { type: 'adaptive' } } });
    assert.deepEqual(providerOptions({ provider: 'anthropic', model: 'claude-haiku-4.5', reasoning: true }, { forceNoThink: true }), {});
    assert.deepEqual(providerOptions({ provider: 'anthropic', model: 'claude-haiku-4.5', reasoning: false }), {});
  });
  await test('google: gemini-3 → thinkingLevel:minimal, 2.5 → thinkingBudget:0 (reasoning off)', () => {
    assert.deepEqual(providerOptions({ provider: 'google', model: 'gemini-3.5-flash', reasoning: false }), { google: { thinkingConfig: { thinkingLevel: 'minimal' } } });
    assert.deepEqual(providerOptions({ provider: 'google', model: 'gemini-2.5-flash', reasoning: false }), { google: { thinkingConfig: { thinkingBudget: 0 } } });
    assert.deepEqual(providerOptions({ provider: 'google', model: 'gemini-3.5-flash', reasoning: true }), {});
  });
  await test('openai: reasoningEffort only on o-series/gpt-5', () => {
    assert.deepEqual(providerOptions({ provider: 'openai', model: 'o3', reasoning: false }), { openai: { reasoningEffort: 'minimal' } });
    assert.deepEqual(providerOptions({ provider: 'openai', model: 'o3', reasoning: true }), { openai: { reasoningEffort: 'medium' } });
    assert.deepEqual(providerOptions({ provider: 'openai', model: 'gpt-4.1-mini', reasoning: false }), {});
  });
  await test('openai-compatible: no providerOptions block (transport handles thinking)', () => {
    assert.deepEqual(providerOptions({ provider: 'openai-compatible', model: 'qwen3', reasoning: false }), {});
  });
  await test('locca: shares the openai-compatible path — no providerOptions block', () => {
    assert.deepEqual(providerOptions({ provider: 'locca', model: 'qwen3', reasoning: false }), {});
    assert.deepEqual(providerOptions({ provider: 'locca', model: 'qwen3', reasoning: true }), {});
  });
  await test('capability flags: tool-object + repeat-penalty are Ollama-only', () => {
    assert.equal(needsToolCallObject({ provider: 'ollama' }), true);
    assert.equal(needsToolCallObject({ provider: 'openai' }), false);
    assert.equal(needsToolCallObject({ provider: 'locca' }), false);
    assert.equal(repeatPenaltyApplies({ provider: 'ollama' }), true);
    assert.equal(repeatPenaltyApplies({ provider: 'deepseek' }), false);
    assert.equal(repeatPenaltyApplies({ provider: 'locca' }), false);
    assert.equal(appliedNumCtx({ provider: 'ollama', model: 'qwen3', numCtx: 8192 }), 8192);
    assert.equal(appliedNumCtx({ provider: 'openai', model: 'gpt-4.1-mini', numCtx: 8192 }), null);
    assert.equal(appliedNumCtx({ provider: 'locca', model: 'qwen3', numCtx: 8192 }), null);
  });

  // ---- agent plan routing ----
  console.log('agentPlan(cfg, schema, toolCount):');
  await test('routes each provider/shape to the right plan', () => {
    assert.equal(agentPlan({ provider: 'ollama' }, {}, 0), 'object-via-tool');
    assert.equal(agentPlan({ provider: 'ollama' }, {}, 3), 'done-tool');
    assert.equal(agentPlan({ provider: 'openai' }, {}, 0), 'native-no-tools');
    assert.equal(agentPlan({ provider: 'openai' }, {}, 3), 'native-then-done');
    // locca routes like any native provider (not the Ollama tool-object path).
    assert.equal(agentPlan({ provider: 'locca' }, {}, 0), 'native-no-tools');
    assert.equal(agentPlan({ provider: 'locca' }, {}, 3), 'native-then-done');
    assert.equal(agentPlan({ provider: 'openai' }, null, 3), 'free-text');
    assert.equal(agentPlan({ provider: 'ollama' }, null, 0), 'free-text');
  });

  // ---- JSON / thinking salvage ----
  console.log('stripThinking / extractJson / usageOf:');
  await test('stripThinking removes complete and dangling <think> blocks', () => {
    assert.equal(stripThinking('<think>reasoning</think>hello'), 'hello');
    assert.equal(stripThinking('leftover reasoning</think>  the answer'), 'the answer');
    assert.equal(stripThinking('plain text'), 'plain text');
  });
  await test('extractJson pulls the object out of fences and prose', () => {
    assert.equal(extractJson('```json\n{"a":1}\n```'), '{"a":1}');
    assert.equal(extractJson('here you go: {"a":1,"b":2} done'), '{"a":1,"b":2}');
    assert.throws(() => extractJson('no json here'));
    assert.throws(() => extractJson(''));
  });
  await test('usageOf normalises totalUsage / usage / missing', () => {
    assert.deepEqual(usageOf({ totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }), { input: 10, output: 5, total: 15 });
    assert.deepEqual(usageOf({ usage: { promptTokens: 3, completionTokens: 2 } }), { input: 3, output: 2, total: 5 });
    assert.deepEqual(usageOf({}), { input: 0, output: 0, total: 0 });
  });

  // ---- talk-within-the-intro budget ----
  console.log('introBudgetPhrase / enforceIntroBudget:');
  await test('introBudgetPhrase is empty outside the usable runway window', () => {
    assert.equal(introBudgetPhrase(null), '');
    assert.equal(introBudgetPhrase(1000), '');
    assert.equal(introBudgetPhrase(20000), '');
    assert.match(introBudgetPhrase(4000), /4s/);
    assert.match(introBudgetPhrase(10000), /10s/);
  });
  await test('enforceIntroBudget trims to a budget, prefers sentence boundary', () => {
    assert.equal(enforceIntroBudget('Short line.', 5000), 'Short line.');           // under budget
    assert.equal(enforceIntroBudget('text', null), 'text');                          // no runway
    assert.equal(enforceIntroBudget('text', 20000), 'text');                         // ≥18s
    const sentences = enforceIntroBudget('One. Two. Three. Four. Five. Six. Seven. Eight. Nine. Ten. Eleven. Twelve.', 4000);
    assert.ok(sentences.endsWith('.') && sentences.split(/\s+/).length <= 10);        // last full sentence
    const hardcut = enforceIntroBudget('a b c d e f g h i j k l m n o p q r s t', 4000);
    assert.ok(hardcut.endsWith('…') && hardcut.split(/\s+/).length <= 11);            // ellipsis fallback
  });

  console.log(failures === 0 ? '\nAll llm-pure tests passed.' : `\n${failures} test(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main();
