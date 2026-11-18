// settings.llm.reasoningEffort / llm.fallback.reasoningEffort: the level
// "On" asks for (issue #2296, option A). Read only while llm.reasoning is on,
// and only on a leg schemas/reasoning.ts reasoningEffortOffered() accepts.
// The rules pinned here:
//   1. 'default' (and an absent or unknown value) is byte-identical to the
//      per-call options develop sent before the field, on every provider, both
//      reasoning states and forced/unforced calls (fixture snapshot), with one
//      announced exception (#2357): a native-Anthropic manual-thinking Claude
//      leg with reasoning on and no forced tool sends the fixed
//      MANUAL_THINKING_DEFAULT_BUDGET (1,024) instead of the SDK's medium;
//   2. a leg that can't express a level sends exactly that too, whatever level
//      is saved;
//   3. each offered provider's level reaches the wire, in the SDK's own field;
//   4. manual-thinking Claude (the SDK's supportsAdaptiveThinking:false set)
//      takes a fixed 1,024 (default and low) / 2,048 / 4,096 budget with top-level `reasoning`
//      unset, adaptive and unknown ids take the effort, and a proxy never gets
//      a budget;
//   5. forceNoThink beats every level;
//   6. OpenRouter's construction-time effort keys the client cache;
//   7. the one per-call helper never drops Google's safety options;
//   8. each leg reads its own level, a swap moves it, it survives a cold
//      load, and a bad value is refused on save.
//
// No credentials and no external host: fetch is stubbed.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { coldLoadSettings } from './test-utils/settings.js';
import { createTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-llm-reasoning-effort-'));
process.env.STATE_DIR = stateRoot;

const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
const { languageModel } = await import('../src/llm/internal/provider/registry.js');
const { primaryLeg, fallbackLeg } = await import('../src/llm/internal/provider/legs.js');
const { planLlmSwap } = await import('../src/settings/llm-swap.js');
const { llmCallOptions, reasoningFor, anthropicThinkingBudget } = await import('../src/llm/internal/provider/capabilities.js');
const {
  REASONING_EFFORTS, reasoningEffortOffered, manualThinkingClaudeModel, manualThinkingDefaultBudget,
  MANUAL_THINKING_DEFAULT_BUDGET,
} = await import('../src/schemas/reasoning.js');
const { openaiCompatibleGateway } = await import('../src/schemas/providers.js');
const { generateText } = await import('ai');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'reasoning-default-baseline.json'), 'utf8'));
const LEVELS = ['low', 'medium', 'high'] as const;

const ser = (o: unknown) => JSON.stringify(o, (_k, v) => (v === undefined ? '<undefined>' : v));
const rowCfg = (r: any[], extra: Record<string, unknown> = {}) => ({
  provider: r[0], model: r[2], reasoning: r[3] === 1, ...(r[1] ? { compatibleMode: r[1] } : {}),
  geminiSafety: { hateSpeech: true }, ...extra,
});

// The #2357 carve-out from the baseline: native Anthropic, a manual-thinking
// id, reasoning on, no forced tool. Exactly these rows change, and only to the
// fixed default budget.
const lowersDefaultBudget = (r: any[]) =>
  r[0] === 'anthropic' && manualThinkingClaudeModel(r[2]) && r[3] === 1 && r[4] === 0;
const DEFAULT_BUDGET_OUT = { reasoning: undefined, providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: 1024 } } } };

test('rule 1: default, absent and unknown levels send exactly what develop sent, on every row but the #2357 carve-out', () => {
  assert.ok(BASELINE.rows.length > 1000, 'the fixture covers the grid');
  assert.equal(MANUAL_THINKING_DEFAULT_BUDGET, 1024);
  let carved = 0;
  for (const r of BASELINE.rows) {
    const carve = lowersDefaultBudget(r);
    if (carve) {
      carved++;
      // What Default used to send there: the SDK's medium, 30% of the model max.
      assert.equal(ser(BASELINE.outputs[r[5]]), ser({ reasoning: 'medium' }), `${r.slice(0, 5).join(' | ')} was medium`);
    }
    const want = ser(carve ? DEFAULT_BUDGET_OUT : BASELINE.outputs[r[5]]);
    for (const extra of [{}, { reasoningEffort: 'default' }, { reasoningEffort: 'ultra' }, { reasoningEffort: 3 }]) {
      const got = ser(llmCallOptions(rowCfg(r, extra), { forceNoThink: r[4] === 1 }));
      assert.equal(got, want, `${r.slice(0, 5).join(' | ')} with ${JSON.stringify(extra)}`);
    }
  }
  assert.ok(carved > 0, 'the grid has manual-thinking Claude rows');
});

test('#2357: Default lowers only native manual-thinking Claude; adaptive ids, proxies, gateways and forced calls are unchanged', () => {
  for (const model of ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-1', 'claude-opus-4-20250514', 'claude-3-7-sonnet-latest']) {
    for (const extra of [{}, { reasoningEffort: 'default' }]) {
      const cfg = { provider: 'anthropic', model, reasoning: true, ...extra };
      assert.deepEqual(llmCallOptions(cfg), DEFAULT_BUDGET_OUT, `${model} ${JSON.stringify(extra)}`);
      assert.equal(anthropicThinkingBudget(cfg), 1024);
      assert.deepEqual(llmCallOptions(cfg, { forceNoThink: true }), { reasoning: 'none' }, `${model}: forced stays off`);
      assert.deepEqual(llmCallOptions({ ...cfg, reasoning: false }), { reasoning: 'none' }, `${model}: off stays off`);
    }
  }
  const unchanged: [Record<string, unknown>, unknown][] = [
    [{ provider: 'anthropic', model: 'claude-opus-4-7' }, { reasoning: 'medium' }],
    [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }, { reasoning: 'medium' }],
    [{ provider: 'anthropic', model: 'claude-sonnet-5-5' }, { reasoning: 'medium' }],
    [{ provider: 'anthropic', model: 'claude-unknown-9' }, { reasoning: 'medium' }],
    [{ provider: 'openai-compatible', compatibleMode: 'hosted', model: 'claude-sonnet-4-5' }, { reasoning: 'medium' }],
    [{ provider: 'requesty', model: 'anthropic/claude-sonnet-4-5' }, { reasoning: undefined }],
    [{ provider: 'gateway', model: 'anthropic/claude-sonnet-4.5' }, { reasoning: undefined }],
  ];
  for (const [leg, want] of unchanged) {
    const cfg = { ...leg, reasoning: true, reasoningEffort: 'default' };
    assert.deepEqual(llmCallOptions(cfg), want, JSON.stringify(leg));
    assert.equal(anthropicThinkingBudget(cfg), null, `${JSON.stringify(leg)}: no budget`);
  }
});

test('rule 2: a leg that cannot express a level sends the default whatever level is saved', () => {
  let hidden = 0;
  for (const r of BASELINE.rows) {
    if (reasoningEffortOffered(rowCfg(r), openaiCompatibleGateway(r[0])?.openaiCompatible.reasoning)) continue;
    hidden++;
    for (const reasoningEffort of LEVELS) {
      assert.equal(ser(llmCallOptions(rowCfg(r, { reasoningEffort }), { forceNoThink: r[4] === 1 })),
        ser(BASELINE.outputs[r[5]]), `${r.slice(0, 5).join(' | ')} @ ${reasoningEffort}`);
    }
  }
  assert.ok(hidden > 100, 'the grid has hidden legs to check');
});

test('the picker predicate: offered and hidden legs', () => {
  const yes = [
    { provider: 'anthropic', model: 'claude-sonnet-4-5' }, { provider: 'anthropic', model: 'claude-opus-4-7' },
    { provider: 'openai', model: 'gpt-5' }, { provider: 'openai', model: 'o3-mini' },
    { provider: 'google', model: 'gemini-2.5-flash' }, { provider: 'deepseek', model: 'deepseek-v4-flash' },
    { provider: 'openrouter', model: 'qwen/qwen3-235b' }, { provider: 'gateway', model: 'openai/gpt-5' },
    { provider: 'requesty', model: 'anthropic/claude-sonnet-4-5' },
    { provider: 'openai-compatible', compatibleMode: 'hosted', model: 'claude-sonnet-4-5' },
  ];
  const no = [
    { provider: 'ollama', model: 'gpt-oss:20b' }, { provider: 'locca', model: 'qwen3' },
    { provider: 'openai-compatible', compatibleMode: 'local', model: 'claude-sonnet-4-5' },
    { provider: 'openai-compatible', compatibleMode: 'hosted', model: 'Qwen/Qwen3.6-35B-A3B-FP8' },
    { provider: 'openai-compatible', compatibleMode: 'auto', model: 'claude-sonnet-4-5' },
    { provider: 'google', model: 'gemma-3-27b-it' }, { provider: 'gateway', model: 'google/gemma-3-27b' },
    { provider: 'openai', model: 'gpt-4o' }, { provider: 'no-such-provider', model: 'x' }, null,
  ];
  for (const leg of yes) assert.equal(reasoningEffortOffered(leg, leg.provider === 'requesty' ? 'minimalWhenOff' : undefined), true, JSON.stringify(leg));
  for (const leg of no) assert.equal(reasoningEffortOffered(leg), false, JSON.stringify(leg));
  // A catalogue gateway follows its named rule.
  assert.equal(reasoningEffortOffered({ provider: 'x', model: 'gpt-4o' }, 'openaiModels'), false);
  assert.equal(reasoningEffortOffered({ provider: 'x', model: 'gpt-5' }, 'openaiModels'), true);
  assert.equal(reasoningEffortOffered({ provider: 'x', model: 'google/gemma-3' }, 'vendorRouted'), false);
  assert.deepEqual([...REASONING_EFFORTS], ['default', 'low', 'medium', 'high']);
});

test('manual vs adaptive Claude ids mirror the SDK (unknown ids are adaptive; 3-7 is manual)', () => {
  const manual = ['claude-sonnet-4-5', 'claude-sonnet-4-5-20250929', 'claude-opus-4-5', 'claude-haiku-4-5-20251001',
    'claude-opus-4-1', 'claude-opus-4-20250514', 'claude-sonnet-4-20250514', 'claude-sonnet-4@20250514',
    'claude-3-7-sonnet-latest', 'claude-3-5-haiku-latest', 'claude-3-haiku-20240307'];
  const adaptive = ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-sonnet-5',
    'claude-sonnet-5-5', 'claude-opus-5', 'claude-opus-5-5', 'claude-fable-5', 'claude-fable-5-1', 'claude-mythos-5',
    'claude-unknown-9', 'claude-sonnet-4', 'gpt-5', ''];
  for (const id of manual) assert.equal(manualThinkingClaudeModel(id), true, id);
  for (const id of adaptive) assert.equal(manualThinkingClaudeModel(id), false, id);
  // The hint's "default" number: the fixed default budget on every manual id (#2357).
  assert.equal(manualThinkingDefaultBudget('claude-sonnet-4-5'), 1024);
  assert.equal(manualThinkingDefaultBudget('claude-opus-4-1'), 1024);
  assert.equal(manualThinkingDefaultBudget('claude-3-7-sonnet-latest'), 1024);
  assert.equal(manualThinkingDefaultBudget('claude-opus-4-7'), null);
  assert.equal(manualThinkingDefaultBudget('gpt-5'), null);
});

test('rule 4: manual Claude takes fixed budgets with top-level reasoning unset; adaptive takes the level', () => {
  const budgets = { low: 1024, medium: 2048, high: 4096 };
  for (const model of ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-7-sonnet-latest']) {
    for (const level of LEVELS) {
      const o = llmCallOptions({ provider: 'anthropic', model, reasoning: true, reasoningEffort: level });
      assert.equal('reasoning' in o, true);
      assert.equal(o.reasoning, undefined, `${model} ${level}: never both`);
      assert.deepEqual(o.providerOptions, { anthropic: { thinking: { type: 'enabled', budgetTokens: budgets[level] } } }, `${model} ${level}`);
    }
  }
  for (const model of ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-unknown-9', 'claude-sonnet-5-5', 'claude-fable-5']) {
    for (const level of LEVELS) {
      const o = llmCallOptions({ provider: 'anthropic', model, reasoning: true, reasoningEffort: level });
      assert.deepEqual(o, { reasoning: level }, `${model} ${level}: the level, never a budget`);
    }
  }
  // A Claude proxy can only take reasoning_effort, so a manual id gets the level.
  for (const level of LEVELS) {
    const o = llmCallOptions({ provider: 'openai-compatible', compatibleMode: 'hosted', model: 'claude-sonnet-4-5', reasoning: true, reasoningEffort: level });
    assert.deepEqual(o, { reasoning: level });
  }
  // Reasoning off: no budget, the existing off-mapping.
  assert.deepEqual(llmCallOptions({ provider: 'anthropic', model: 'claude-sonnet-4-5', reasoning: false, reasoningEffort: 'high' }), { reasoning: 'none' });
  assert.deepEqual(llmCallOptions({ provider: 'anthropic', model: 'claude-sonnet-5-5', reasoning: false, reasoningEffort: 'high' }), { reasoning: 'minimal' });
});

test('rule 5: forceNoThink beats every level', () => {
  for (const level of LEVELS) {
    for (const model of ['claude-sonnet-4-5', 'claude-opus-4-7']) {
      const cfg = { provider: 'anthropic', model, reasoning: true, reasoningEffort: level };
      assert.deepEqual(llmCallOptions(cfg, { forceNoThink: true }), { reasoning: 'none' }, `${model} ${level}`);
      assert.equal(anthropicThinkingBudget(cfg, { forceNoThink: true }), null);
    }
    assert.equal(reasoningFor({ provider: 'deepseek', model: 'deepseek-v4-flash', reasoning: true, reasoningEffort: level }, { forceNoThink: true }), 'none');
    assert.equal(reasoningFor({ provider: 'requesty', model: 'openai/gpt-5', reasoning: true, reasoningEffort: level }, { forceNoThink: true }), 'minimal');
    assert.equal(reasoningFor({ provider: 'gateway', model: 'openai/gpt-5', reasoning: true, reasoningEffort: level }, { forceNoThink: true }), 'none');
    assert.equal(reasoningFor({ provider: 'gateway', model: 'anthropic/claude-sonnet-5.5', reasoning: true, reasoningEffort: level }, { forceNoThink: true }), 'minimal');
    assert.equal(reasoningFor({ provider: 'openai-compatible', compatibleMode: 'hosted', model: 'claude-sonnet-4-5', reasoning: true, reasoningEffort: level }, { forceNoThink: true }), 'none');
  }
});

// One request per case: capture the body, answer a 400 so the call ends there.
async function wireBody(cfg: Record<string, unknown>, forceNoThink = false): Promise<{ url: string; body: any }> {
  const real = globalThis.fetch;
  let url = ''; let body: any;
  globalThis.fetch = (async (u: unknown, init: { body?: unknown }) => {
    url = String(u);
    body = JSON.parse(String(init?.body));
    return new Response('{"error":{"message":"stop"}}', { status: 400, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await generateText({
      model: languageModel(cfg, { forceNoThink }), prompt: 'hi', maxOutputTokens: 100, maxRetries: 0,
      ...llmCallOptions(cfg, { forceNoThink }),
    } as never).catch(() => {});
  } finally {
    globalThis.fetch = real;
  }
  return { url, body };
}

test('rule 3: each offered provider sends the level in its own field', async () => {
  const on = (c: Record<string, unknown>, reasoningEffort = 'low') => ({ apiKey: 'k', reasoning: true, reasoningEffort, ...c });
  let w = await wireBody(on({ provider: 'openai', model: 'gpt-5' }, 'high'));
  assert.equal(w.body.reasoning?.effort, 'high', 'openai gpt-5');
  w = await wireBody(on({ provider: 'openai', model: 'gpt-4o' }, 'high'));
  assert.equal(w.body.reasoning, undefined, 'gpt-4-class: nothing');
  assert.equal(w.body.reasoning_effort, undefined, 'gpt-4-class: nothing');

  w = await wireBody(on({ provider: 'anthropic', model: 'claude-opus-4-7' }));
  assert.equal(w.body.output_config?.effort, 'low', 'adaptive claude effort');
  assert.equal(w.body.thinking?.type, 'adaptive');

  w = await wireBody(on({ provider: 'google', model: 'gemini-3.5-flash' }, 'high'));
  assert.equal(w.body.generationConfig?.thinkingConfig?.thinkingLevel, 'high', 'gemini 3');
  w = await wireBody(on({ provider: 'google', model: 'gemini-2.5-flash' }));
  assert.equal(typeof w.body.generationConfig?.thinkingConfig?.thinkingBudget, 'number', 'gemini 2.5 budget share');
  assert.ok(w.body.generationConfig.thinkingConfig.thinkingBudget > 0);

  w = await wireBody(on({ provider: 'deepseek', model: 'deepseek-v4-flash' }));
  assert.equal(w.body.reasoning_effort, 'low', 'deepseek');
  assert.deepEqual(w.body.thinking, { type: 'enabled' });

  w = await wireBody(on({ provider: 'requesty', model: 'anthropic/claude-sonnet-4-5' }, 'medium'));
  assert.equal(w.body.reasoning_effort, 'medium', 'requesty');

  // The Gateway serialises the call options to its own server, which maps the
  // level per vendor: `reasoning` in that body is the SDK boundary.
  w = await wireBody(on({ provider: 'gateway', model: 'anthropic/claude-sonnet-4.5' }, 'high'));
  assert.match(w.url, /ai-gateway/);
  assert.equal(w.body.reasoning, 'high', 'gateway');

  w = await wireBody(on({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' }, 'high'));
  assert.deepEqual(w.body.reasoning, { effort: 'high' }, 'openrouter construction-time effort');
  w = await wireBody(on({ provider: 'openrouter', model: 'qwen/qwen3-235b' }, 'high'), true);
  assert.deepEqual(w.body.reasoning, { enabled: false }, 'openrouter forced: suppressed at any level');

  w = await wireBody(on({ provider: 'openai-compatible', compatibleMode: 'hosted', baseUrl: 'https://proxy.example/v1', model: 'claude-sonnet-4-5' }));
  assert.equal(w.body.reasoning_effort, 'low', 'hosted Claude proxy');
  assert.equal(w.body.thinking, undefined, 'never a budget through a proxy');
});

test('rule 4 on the wire: manual Claude budgets, and forced calls switch thinking off', async () => {
  for (const [level, n] of [['low', 1024], ['medium', 2048], ['high', 4096]] as const) {
    const cfg = { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'k', reasoning: true, reasoningEffort: level };
    const { body } = await wireBody(cfg);
    assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: n }, level);
    assert.equal(body.max_tokens, 100 + n, `${level}: the SDK adds the budget to the cap`);
    assert.equal(body.output_config, undefined, `${level}: no effort alongside the budget`);
    const forced = await wireBody(cfg, true);
    assert.deepEqual(forced.body.thinking, { type: 'disabled' }, `${level}: forced`);
  }
  // Default is the fixed 1,024 budget (#2357), never the SDK's 19,200 medium,
  // whether the level is saved as default or absent (a pre-field "On").
  for (const extra of [{ reasoningEffort: 'default' }, {}]) {
    const cfg = { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'k', reasoning: true, ...extra };
    const { body } = await wireBody(cfg);
    assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 1024 }, JSON.stringify(extra));
    assert.equal(body.max_tokens, 1124);
    assert.equal(body.output_config, undefined);
    const forced = await wireBody(cfg, true);
    assert.deepEqual(forced.body.thinking, { type: 'disabled' }, 'default, forced');
  }
  // An adaptive id at Default keeps the SDK's adaptive medium effort.
  const adaptive = await wireBody({ provider: 'anthropic', model: 'claude-opus-4-7', apiKey: 'k', reasoning: true, reasoningEffort: 'default' });
  assert.equal(adaptive.body.thinking?.type, 'adaptive');
  assert.equal(adaptive.body.output_config?.effort, 'medium');
});

test('rule 6: OpenRouter effort keys the client cache; default shares the old instance', () => {
  const or = { provider: 'openrouter', model: 'qwen/qwen3-235b', apiKey: 'k', reasoning: true };
  const base = languageModel(or);
  assert.equal(languageModel({ ...or, reasoningEffort: 'default' }), base, 'default is the same client');
  const low = languageModel({ ...or, reasoningEffort: 'low' });
  const high = languageModel({ ...or, reasoningEffort: 'high' });
  assert.notEqual(low, base);
  assert.notEqual(high, low);
  assert.equal(languageModel({ ...or, reasoningEffort: 'low' }), low, 'cached');
  // Reasoning off: the level is never read, so no new client.
  assert.equal(languageModel({ ...or, reasoning: false, reasoningEffort: 'high' }), languageModel({ ...or, reasoning: false }));
});

test('rule 7: the combined helper never drops Google safety options', () => {
  const safety = { hateSpeech: true, harassment: true };
  for (const model of ['gemini-2.5-flash', 'gemini-3.5-flash', 'gemma-3-27b-it']) {
    for (const reasoning of [false, true]) {
      for (const reasoningEffort of REASONING_EFFORTS) {
        for (const forceNoThink of [false, true]) {
          const o = llmCallOptions({ provider: 'google', model, reasoning, reasoningEffort, geminiSafety: safety }, { forceNoThink });
          const s = (o.providerOptions as any)?.google?.safetySettings;
          assert.equal(s?.length, 4, `${model} ${reasoning} ${reasoningEffort} ${forceNoThink}`);
          assert.equal(s.find((x: any) => x.category === 'HARM_CATEGORY_HARASSMENT').threshold, 'BLOCK_MEDIUM_AND_ABOVE');
        }
      }
    }
  }
});

test('rule 8: both legs survive save and a cold load; a pre-field or unknown value loads default', async () => {
  await coldLoadSettings({ llm: { provider: 'anthropic', model: 'claude-sonnet-4-5', fallback: { enabled: true, provider: 'openai', model: 'gpt-5' } } });
  assert.equal(settings.get().llm.reasoningEffort, 'default', 'pre-field primary');
  assert.equal(settings.get().llm.fallback.reasoningEffort, 'default', 'pre-field fallback');
  await settings.update({ llm: { reasoning: true, reasoningEffort: 'low', fallback: { reasoning: true, reasoningEffort: 'high' } } } as never);
  setCache(null);
  await settings.load();
  assert.equal(settings.get().llm.reasoningEffort, 'low');
  assert.equal(settings.get().llm.fallback.reasoningEffort, 'high');

  await coldLoadSettings({ llm: { provider: 'anthropic', reasoningEffort: 'ultra', fallback: { reasoningEffort: 42 } } });
  assert.equal(settings.get().llm.reasoningEffort, 'default');
  assert.equal(settings.get().llm.fallback.reasoningEffort, 'default');
});

test('rule 8: a bad value is refused on save, on both legs', async () => {
  await coldLoadSettings({ llm: { provider: 'anthropic', model: 'claude-sonnet-4-5', reasoningEffort: 'low' } });
  await assert.rejects(settings.update({ llm: { reasoningEffort: 'max' } } as never), /llm\.reasoningEffort must be one of/);
  await assert.rejects(settings.update({ llm: { fallback: { reasoningEffort: true } } } as never), /llm\.fallback\.reasoningEffort must be one of/);
  assert.equal(settings.get().llm.reasoningEffort, 'low', 'unchanged after a refused save');
  // A level for a provider that can't use it is stored, so it survives a switch away and back.
  await settings.update({ llm: { provider: 'ollama', model: 'qwen3', reasoningEffort: 'high' } } as never);
  assert.equal(settings.get().llm.reasoningEffort, 'high');
  await settings.update({ llm: { provider: 'anthropic', model: 'claude-sonnet-4-5' } } as never);
  assert.equal(settings.get().llm.reasoningEffort, 'high');
});

test('rule 8: each leg reads its own level, and a swap moves it', async () => {
  await coldLoadSettings({ llm: {
    provider: 'anthropic', model: 'claude-sonnet-4-5', reasoning: true, reasoningEffort: 'low',
    fallback: { enabled: true, provider: 'anthropic', model: 'claude-sonnet-4-5', reasoning: true, reasoningEffort: 'high' },
  } });
  const p = primaryLeg();
  const f = fallbackLeg();
  assert.ok(f, 'fallback leg built');
  assert.equal(anthropicThinkingBudget(p.cfg), 1024);
  assert.equal(anthropicThinkingBudget(f!.cfg), 4096);

  const stored = { llm: {
    provider: 'anthropic', model: 'claude-sonnet-4-5', reasoning: true, reasoningEffort: 'low',
    fallback: { enabled: true, provider: 'openai', model: 'gpt-5', reasoning: true, reasoningEffort: 'high' },
  } };
  const { patch } = planLlmSwap(stored as never, { provider: 'ollama' });
  const llm = (patch as any).llm;
  assert.equal(llm.reasoningEffort, 'high');
  assert.equal(llm.fallback.reasoningEffort, 'low');
});

test('every strategy call site goes through the one helper: a manual Claude budget reaches free text, never a forced call', async () => {
  const { djAgent } = await import('../src/llm/internal/strategy/agent.js');
  const { djObject } = await import('../src/llm/internal/strategy/object.js');
  const { djText } = await import('../src/llm/internal/strategy/text.js');
  const { objectViaToolCall } = await import('../src/llm/internal/strategy/object-via-tool.js');
  const { tool } = await import('ai');
  const { z } = await import('zod');
  const schema = z.object({ id: z.string() });
  await coldLoadSettings({ llm: { provider: 'anthropic', model: 'claude-sonnet-4-5', reasoning: true, reasoningEffort: 'low', keys: { anthropic: 'k' } } });

  const real = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = (async (_u: unknown, init: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response('{"type":"error","error":{"type":"invalid_request_error","message":"stop"}}', { status: 400, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const kinds: Record<string, any[]> = {};
  const run = async (name: string, fn: () => Promise<unknown>) => {
    const from = bodies.length;
    await fn().catch(() => {});
    kinds[name] = bodies.slice(from);
  };
  try {
    await run('djText', () => djText({ system: 'You are a DJ.', prompt: 'say hi' }));
    await run('djObject', () => djObject({ system: 'You are a DJ.', prompt: 'pick', schema }));
    await run('objectViaToolCall', () => objectViaToolCall(primaryLeg(), { prompt: 'pick', schema }));
    await run('djAgent', () => djAgent({
      system: 'You are a DJ.', messages: [{ role: 'user' as const, content: 'pick' }], schema,
      tools: { search: tool({ description: 'search', inputSchema: z.object({ query: z.string() }), execute: async () => ({ ids: ['a'] }) }) },
    }));
  } finally {
    globalThis.fetch = real;
  }
  const budget = { type: 'enabled', budget_tokens: 1024 };
  assert.ok(kinds.djText.length, 'djText reached the wire');
  for (const b of kinds.djText) assert.deepEqual(b.thinking, budget, 'djText: free text thinks at the level');
  const isRecovery = (b: any) => JSON.stringify(b.messages).includes('Respond with a single JSON object only');
  const native = kinds.djObject.filter(b => !isRecovery(b));
  const recovery = kinds.djObject.filter(isRecovery);
  assert.ok(native.length && recovery.length, 'djObject native attempt and text recovery reached the wire');
  for (const b of native) assert.deepEqual(b.thinking, budget, 'djObject native: the operator choice');
  for (const b of recovery) assert.deepEqual(b.thinking, { type: 'disabled' }, 'djObject recovery: suppressed');
  for (const name of ['objectViaToolCall', 'djAgent']) {
    assert.ok(kinds[name].length, `${name} reached the wire`);
    for (const b of kinds[name]) assert.deepEqual(b.thinking, { type: 'disabled' }, `${name}: forced → thinking off`);
  }
  // No strategy spreads the two pieces itself any more.
  const dir = path.join(HERE, '..', 'src', 'llm', 'internal', 'strategy');
  for (const f of ['text.ts', 'object.ts', 'object-via-tool.ts', 'agent.ts']) {
    const src = readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(src, /reasoning:\s*reasoningFor\(|googleSafetyOptions\(/, f);
    assert.match(src, /\.\.\.llmCallOptions\(/, f);
  }
});
