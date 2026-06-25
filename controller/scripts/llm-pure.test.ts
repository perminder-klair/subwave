// Unit tests for the pure LLM helpers — the regression-critical bits of the
// llm/ rewrite. Run: `npm run test:llm` (tsx scripts/llm-pure.test.ts).
//
// These functions are side-effect-free and unit-pinned here so a wiring slip
// (a provider routed to the wrong path, a thinking knob flipped, the failover
// gate widened) fails an assert BEFORE it ever reaches a model. Matches the
// node:assert-via-tsx style of scripts/picker-recency-regression.ts.

import assert from 'node:assert/strict';
import { stripThinking, extractJson, usageOf, budgetMode, isUnreachable, isTransient, isQuotaOrAuthError } from '../src/llm/internal/core/pure.js';
import { withDeadline } from '../src/llm/internal/core/retry.js';
import { providerOptions, needsToolCallObject, repeatPenaltyApplies, appliedNumCtx } from '../src/llm/internal/provider/capabilities.js';
import { agentPlan } from '../src/llm/internal/strategy/plan.js';
import { introBudgetPhrase, enforceIntroBudget } from '../src/llm/internal/prompts/intro-budget.js';
import { embeddingBaseUrl } from '../src/llm/internal/provider/embedding.js';
import { DEFAULT_LOCCA_EMBED_BASE_URL } from '../src/llm/internal/provider/registry.js';
import { personaToneDirectives, normalizeDial, DIAL_NEUTRAL, validatePersonasStrict } from '../src/settings.js';
import { showMusicLean } from '../src/llm/internal/prompts/picker.js';

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
  await test('bare 429 (no quota signature) is transient, NOT unreachable, NOT quota/auth', () => {
    assert.equal(isTransient({ statusCode: 429 }), true);
    assert.equal(isUnreachable({ statusCode: 429 }), false);
    assert.equal(isQuotaOrAuthError({ statusCode: 429 }), false);
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

  // ---- quota/auth gate: failover-eligible, pulled OUT of same-leg retry (#438) ----
  console.log('isQuotaOrAuthError (quota/usage-limit/auth → fail over, not retry):');
  await test('Ollama Cloud weekly usage-limit 429 → quota/auth, NOT transient', () => {
    // The exact shape from issue #438: status 429 + a usage-limit message.
    const e: any = { statusCode: 429, message: 'you (acct) have reached your weekly usage limit, upgrade for higher limits: https://ollama.com/upgrade (ref: abc)' };
    assert.equal(isQuotaOrAuthError(e), true);
    assert.equal(isTransient(e), false);   // pulled OUT of same-leg retry
    assert.equal(isUnreachable(e), false);  // host is up, just refusing
  });
  await test('quota message with no status still classifies (AI SDK flattens status)', () => {
    const e: any = new Error('Insufficient quota — upgrade for higher limits');
    assert.equal(isQuotaOrAuthError(e), true);
    assert.equal(isTransient(e), false);
  });
  await test('401/403 are quota/auth (bad/missing API key never recovers on this leg)', () => {
    assert.equal(isQuotaOrAuthError({ statusCode: 401 }), true);
    assert.equal(isQuotaOrAuthError({ statusCode: 403 }), true);
    assert.equal(isQuotaOrAuthError({ message: 'Incorrect API key provided' }), true);
    assert.equal(isTransient({ statusCode: 401 }), false);
  });
  await test('cause.statusCode / cause.message are unwrapped', () => {
    assert.equal(isQuotaOrAuthError({ cause: { statusCode: 402 } }), true);
    assert.equal(isQuotaOrAuthError({ cause: { message: 'quota exceeded' } }), true);
  });
  await test('plain 5xx / socket errors are NOT quota/auth (still same-leg retry)', () => {
    assert.equal(isQuotaOrAuthError({ statusCode: 503 }), false);
    assert.equal(isQuotaOrAuthError({ code: 'ECONNRESET' }), false);
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
  await test('capability flags: tool-object covers ollama + locca + openai-compatible; repeat-penalty is Ollama-only', () => {
    assert.equal(needsToolCallObject({ provider: 'ollama' }), true);
    assert.equal(needsToolCallObject({ provider: 'openai' }), false);
    // locca + openai-compatible serve local GGUF models that don't explore under
    // native Output.object (explored=false on gemma-4-12b / qwen3.5-9b) — same as ollama.
    assert.equal(needsToolCallObject({ provider: 'locca' }), true);
    assert.equal(needsToolCallObject({ provider: 'openai-compatible' }), true);
    assert.equal(repeatPenaltyApplies({ provider: 'ollama' }), true);
    assert.equal(repeatPenaltyApplies({ provider: 'deepseek' }), false);
    assert.equal(repeatPenaltyApplies({ provider: 'locca' }), false);
    assert.equal(appliedNumCtx({ provider: 'ollama', model: 'qwen3', numCtx: 8192 }), 8192);
    assert.equal(appliedNumCtx({ provider: 'openai', model: 'gpt-4.1-mini', numCtx: 8192 }), null);
    assert.equal(appliedNumCtx({ provider: 'locca', model: 'qwen3', numCtx: 8192 }), null);
  });

  // ---- embedding base URL (the relative-/embeddings crash, #405 follow-up) ----
  console.log('embeddingBaseUrl(cfg):');
  await test('locca blank → dedicated EMBED default, never chat or a relative URL', () => {
    // Blank locca baseUrl must resolve to the dedicated embed server (8090), NOT
    // the chat default (8080) and NOT '' (which would make the SDK fetch
    // "/embeddings" → "Failed to parse URL"). This is what makes locca a
    // first-class embedding provider with no hand-typed URL.
    assert.equal(embeddingBaseUrl({ provider: 'locca', baseUrl: '' }), DEFAULT_LOCCA_EMBED_BASE_URL);
    assert.match(DEFAULT_LOCCA_EMBED_BASE_URL, /:8090\/v1$/);
    assert.equal(embeddingBaseUrl({ provider: 'locca', baseUrl: 'http://x:9000/v1' }), 'http://x:9000/v1');
    // openai-compatible has no sane default — blank stays '' so the builder errors.
    assert.equal(embeddingBaseUrl({ provider: 'openai-compatible', baseUrl: '' }), '');
    assert.equal(embeddingBaseUrl({ provider: 'openai-compatible', baseUrl: 'http://y:8090/v1' }), 'http://y:8090/v1');
  });

  // ---- agent plan routing ----
  console.log('agentPlan(cfg, schema, toolCount):');
  await test('routes each provider/shape to the right plan', () => {
    assert.equal(agentPlan({ provider: 'ollama' }, {}, 0), 'object-via-tool');
    assert.equal(agentPlan({ provider: 'ollama' }, {}, 3), 'done-tool');
    assert.equal(agentPlan({ provider: 'openai' }, {}, 0), 'native-no-tools');
    assert.equal(agentPlan({ provider: 'openai' }, {}, 3), 'native-then-done');
    // locca + openai-compatible serve local GGUF models (same class as Ollama), so
    // they take the forced tool-object / done-tool path, NOT the native path — local
    // llama.cpp models emit the object without exploring tools under native Output.object.
    assert.equal(agentPlan({ provider: 'locca' }, {}, 0), 'object-via-tool');
    assert.equal(agentPlan({ provider: 'locca' }, {}, 3), 'done-tool');
    assert.equal(agentPlan({ provider: 'openai-compatible' }, {}, 0), 'object-via-tool');
    assert.equal(agentPlan({ provider: 'openai-compatible' }, {}, 3), 'done-tool');
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

  // ---- daily token budget mode ----
  console.log('budgetMode (daily LLM token cap → normal/soft/hard):');
  await test('cap <= 0 (or non-finite) is always normal — the disabled default', () => {
    assert.equal(budgetMode({ used: 9_999_999, cap: 0, softPct: 80 }), 'normal');
    assert.equal(budgetMode({ used: 1, cap: -5, softPct: 80 }), 'normal');
    assert.equal(budgetMode({ used: 1, cap: NaN, softPct: 80 }), 'normal');
  });
  await test('used below soft threshold is normal', () => {
    assert.equal(budgetMode({ used: 700, cap: 1000, softPct: 80 }), 'normal');
  });
  await test('used at/above soft threshold but below cap is soft', () => {
    assert.equal(budgetMode({ used: 800, cap: 1000, softPct: 80 }), 'soft');
    assert.equal(budgetMode({ used: 999, cap: 1000, softPct: 80 }), 'soft');
  });
  await test('used at/above cap is hard', () => {
    assert.equal(budgetMode({ used: 1000, cap: 1000, softPct: 80 }), 'hard');
    assert.equal(budgetMode({ used: 5000, cap: 1000, softPct: 80 }), 'hard');
  });
  await test('softPct 0 or 100 disables the soft tier (straight to hard at cap)', () => {
    assert.equal(budgetMode({ used: 999, cap: 1000, softPct: 0 }), 'normal');
    assert.equal(budgetMode({ used: 999, cap: 1000, softPct: 100 }), 'normal');
    assert.equal(budgetMode({ used: 1000, cap: 1000, softPct: 0 }), 'hard');
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

  // ---- persona tone dials (humour / local colour / warmth) ----
  console.log('personaToneDirectives / normalizeDial:');
  await test('normalizeDial clamps to 0-10 int, neutral on garbage', () => {
    assert.equal(normalizeDial(7), 7);
    assert.equal(normalizeDial(-3), 0);
    assert.equal(normalizeDial(99), 10);
    assert.equal(normalizeDial(6.7), 7);
    assert.equal(normalizeDial('abc'), DIAL_NEUTRAL);
    assert.equal(normalizeDial(undefined), DIAL_NEUTRAL);
  });
  await test('neutral / missing dials append nothing (prompt stays byte-identical)', () => {
    assert.equal(personaToneDirectives({ humour: 5, localColour: 5, warmth: 5 }), '');
    assert.equal(personaToneDirectives({}), '');
    assert.equal(personaToneDirectives(null), '');
    assert.equal(personaToneDirectives({ humour: 4, localColour: 6 }), '');
  });
  await test('low/high bands append the matching directive, in dial order', () => {
    assert.match(personaToneDirectives({ humour: 9 }), /playful wit/);
    assert.match(personaToneDirectives({ humour: 1 }), /Play it straight/);
    assert.match(personaToneDirectives({ localColour: 10 }), /local setting/);
    assert.match(personaToneDirectives({ warmth: 0 }), /cool, dry distance/);
    const both = personaToneDirectives({ humour: 8, warmth: 8 });
    assert.ok(both.startsWith('\n\nTone:\n- '));
    assert.equal(both.split('\n- ').length, 3); // header + 2 bullets
  });
  // The save path (validatePersonasStrict) rebuilds each persona from a field
  // whitelist; if the dials aren't in it they are silently dropped on every
  // save and the feature is dead end-to-end. Pin that they round-trip.
  await test('validatePersonasStrict carries the dials through the save path', () => {
    const base = { name: 'Nova', soul: 'late-night', frequency: 'moderate',
      tts: { engine: 'piper', cloudProvider: 'openai', voice: '' } };
    const [saved] = validatePersonasStrict([{ ...base, humour: 9, localColour: 0, warmth: 99 }]);
    assert.equal(saved.humour, 9);
    assert.equal(saved.localColour, 0);
    assert.equal(saved.warmth, 10);            // clamped, same as normalizeDial
    const [bare] = validatePersonasStrict([base]);
    assert.equal(bare.humour, DIAL_NEUTRAL);   // absent dials default to neutral
    assert.equal(bare.localColour, DIAL_NEUTRAL);
    assert.equal(bare.warmth, DIAL_NEUTRAL);
  });

  // ---- showMusicLean: soft lean vs strict genre lock (shared by both pick paths) ----
  console.log('showMusicLean (soft lean vs strict genre lock):');
  const SOFT_GENRE_LINE = '\n\nMusic steer for this show — lean toward Jazz. These are preferences, not hard filters: break them only when the flow genuinely demands it.';
  await test('no show → empty string', () => {
    assert.equal(showMusicLean(null), '');
    assert.equal(showMusicLean(undefined), '');
  });
  await test('soft genre-only show is byte-for-byte the legacy line', () => {
    assert.equal(showMusicLean({ name: 'x', topic: 'y', genre: 'Jazz' }), SOFT_GENRE_LINE);
  });
  await test('genreStrict=false leaves the soft path unchanged', () => {
    assert.equal(showMusicLean({ name: 'x', topic: 'y', genre: 'Jazz', genreStrict: false }), SOFT_GENRE_LINE);
  });
  await test('strict genre is a hard rule, not a soft lean', () => {
    const out = showMusicLean({ name: 'x', topic: 'y', genre: 'Hip-Hop', genreStrict: true });
    assert.match(out, /Genre lock/);
    assert.match(out, /MUST be Hip-Hop/);
    assert.match(out, /do not pick other genres/);
    assert.doesNotMatch(out, /lean toward Hip-Hop/);
    assert.doesNotMatch(out, /Music steer/);     // no soft line when only the genre is pinned
  });
  await test('strict carries the never-starve escape hatch', () => {
    const out = showMusicLean({ name: 'x', topic: 'y', genre: 'Metal', genreStrict: true });
    assert.match(out, /no Metal track/i);        // can stray only to avoid dead air
  });
  await test('strict needs a genre — genreStrict alone is inert', () => {
    assert.equal(showMusicLean({ name: 'x', topic: 'y', genreStrict: true }), '');
    // energy still produces a soft line; no genre lock without a genre
    const out = showMusicLean({ name: 'x', topic: 'y', energy: 'high', genreStrict: true });
    assert.doesNotMatch(out, /Genre lock/);
    assert.match(out, /favour high-energy tracks/);
  });
  await test('strict genre coexists with soft era/energy steers', () => {
    const out = showMusicLean({ name: 'x', topic: 'y', genre: 'Soul', genreStrict: true, fromYear: 1970, toYear: 1979, energy: 'medium' });
    assert.match(out, /Genre lock for this show/);
    assert.match(out, /Music steer for this show — prefer tracks from 1970–1979; favour medium-energy tracks/);
    assert.doesNotMatch(out, /lean toward Soul/);  // genre is the hard rule, not a soft part
  });

  console.log(failures === 0 ? '\nAll llm-pure tests passed.' : `\n${failures} test(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main();
