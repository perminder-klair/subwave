// settings.llm.repeatPenalty — the operator's repetition floor for the
// body-injection providers (openai-compatible / locca → llama.cpp, vLLM,
// LM Studio). Issue #1327: configured at 1.15, llama.cpp logged 1.000 on every
// request.
//
// The reported mechanism (the AI SDK putting repeat_penalty:1.0 on the body, so
// openAICompatibleFetch's `=== undefined` guard refused to overwrite it) was
// NOT the cause — @ai-sdk/openai has no repeat_penalty field at all, and the
// last case below pins that. The cause was settings.load()'s llm block, which
// composes explicitly rather than spreading DEFAULTS: `repeatPenalty` was never
// listed, so update() wrote it to settings.json, it worked in memory for that
// process, and the next cold load silently dropped it — after which
// appliedRepeatPenalty() returned null, nothing was injected, and llama.cpp
// used its own 1.0 default. Hence a COLD-LOAD round trip, not just a clamp
// check: an in-process assertion passes on the broken code.
//
// No credentials and no external host — the one wire case runs against a
// capturing fetch.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// STATE_DIR is redirected at a throwaway dir BEFORE the first import of
// anything config-derived (same pattern as scripts/compat-tts-params.test.ts).
const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-repeat-penalty-'));
process.env.STATE_DIR = stateRoot;

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { appliedRepeatPenalty } = await import('../src/llm/internal/provider/capabilities.js');
const { openAICompatibleFetch, languageModel } = await import('../src/llm/internal/provider/registry.js');
const { generateText } = await import('ai');
const { createOpenAI } = await import('@ai-sdk/openai');

const SETTINGS_PATH = path.join(stateRoot, 'settings.json');

const BASE_LLM = {
  provider: 'openai-compatible',
  model: 'qwen3-8b',
  baseUrl: 'http://127.0.0.1:8080/v1',
};

// Load a hand-written settings.json the way a controller restart would.
async function coldLoad(llm: Record<string, unknown>) {
  writeFileSync(SETTINGS_PATH, JSON.stringify({ llm: { ...BASE_LLM, ...llm } }));
  setCache(null);
  await settings.load();
  return settings.get().llm;
}

test('a configured repeat penalty survives a controller restart', async () => {
  const llm = await coldLoad({ repeatPenalty: 1.15 });
  assert.equal(llm.repeatPenalty, 1.15);
  // The value only matters insofar as it reaches the wire injector.
  assert.equal(appliedRepeatPenalty(llm), 1.15);
});

test('the fallback leg keeps its own penalty across a restart', async () => {
  const llm = await coldLoad({
    repeatPenalty: 1.15,
    fallback: { enabled: true, provider: 'locca', model: 'gemma', repeatPenalty: 1.3 },
  });
  assert.equal(llm.fallback.repeatPenalty, 1.3);
  assert.equal(appliedRepeatPenalty(llm.fallback), 1.3);
});

test('a stored penalty is clamped, and junk falls back to the default', async () => {
  assert.equal((await coldLoad({ repeatPenalty: 9 })).repeatPenalty, 2.0);
  assert.equal((await coldLoad({ repeatPenalty: 0.4 })).repeatPenalty, 1.0);
  // A string is not a number — clampRepeatPenalty refuses to guess.
  assert.equal((await coldLoad({ repeatPenalty: '1.4' })).repeatPenalty, 1.15);
  // Absent (a settings.json written before the field existed) → the default.
  assert.equal((await coldLoad({})).repeatPenalty, 1.15);
  // 1.0 is OFF: stored and honoured, but never injected (a no-op on the wire).
  const off = await coldLoad({ repeatPenalty: 1.0 });
  assert.equal(off.repeatPenalty, 1.0);
  assert.equal(appliedRepeatPenalty(off), null);
});

test('saving a penalty then restarting keeps it — the operator story', async () => {
  await coldLoad({ repeatPenalty: 1.15 });
  await settings.update({ llm: { repeatPenalty: 1.4 } } as any);
  assert.equal(settings.get().llm.repeatPenalty, 1.4, 'applies immediately');

  // Restart: drop the in-memory cache and re-read what update() persisted.
  setCache(null);
  await settings.load();
  assert.equal(settings.get().llm.repeatPenalty, 1.4, 'and survives the restart');
});

test('changing the penalty rebuilds the model — it is bound at construction', () => {
  // openAICompatibleFetch captures the penalty ONCE when the wrapper is built,
  // so a cache signature that ignores it hands back the instance carrying the
  // old value and the edit reads as "ignored" until a restart.
  const at115 = languageModel({ ...BASE_LLM, repeatPenalty: 1.15 });
  assert.equal(languageModel({ ...BASE_LLM, repeatPenalty: 1.15 }), at115, 'unchanged → cached');
  assert.notEqual(languageModel({ ...BASE_LLM, repeatPenalty: 1.4 }), at115, 'changed → rebuilt');
});

test('the configured penalty is what lands on the wire', async () => {
  const cfg = { ...BASE_LLM, repeatPenalty: 1.15, reasoning: false };
  let sent: any = null;
  const capture: any = async (_url: any, init: any) => {
    sent = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        id: 'x', object: 'chat.completion', created: 1, model: cfg.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const provider = createOpenAI({
    baseURL: cfg.baseUrl,
    apiKey: 'unused',
    name: 'openai-compatible',
    fetch: openAICompatibleFetch(cfg, capture, false),
  });
  await generateText({ model: provider.chat(cfg.model), prompt: 'hi' });
  assert.equal(sent.repeat_penalty, 1.15);

  // #1327's premise, pinned: the SDK contributes no repeat_penalty of its own,
  // not even a no-op 1.0 — the key is on the body only because we put it there.
  // So the `=== undefined` guard in openAICompatibleFetch cannot be what drops
  // an operator's value; if this ever flips, the guard becomes real and the
  // injector needs to start overriding an SDK-supplied default.
  let bare: any = null;
  const captureBare: any = async (_url: any, init: any) => {
    bare = JSON.parse(init.body);
    return capture(_url, init);
  };
  const noPenalty = createOpenAI({
    baseURL: cfg.baseUrl,
    apiKey: 'unused',
    name: 'openai-compatible',
    fetch: captureBare,
  });
  await generateText({ model: noPenalty.chat(cfg.model), prompt: 'hi', temperature: 0.9, topP: 0.9 });
  assert.equal(bare.repeat_penalty, undefined);
});
