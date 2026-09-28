// googleSafetyOptions (llm/internal/provider/capabilities.ts) — the per-call
// safety channel for the native `google` provider.
//
// ai-sdk reads safetySettings ONLY from per-call providerOptions: the
// model-construction options type carries a single `threshold` string, not a
// per-category list, and `safetySettings` is resolved from the parsed
// providerOptions in the request body builder. So the only channel that can
// express per-category thresholds is the one used here. Checked = block that
// category; unchecked/absent = allow. Every other provider gets {} (no-op
// spread), so call sites never name a provider.
//
// The cold-load half is the load-bearing one: settings.llm's section blocks
// compose explicitly and do NOT spread DEFAULTS, so a geminiSafety missing
// from load() would validate, save, and work all process — then silently
// vanish on the next restart. It has bitten twice upstream
// (tts.cloud.compatParams, llm.repeatPenalty), so pin it the way
// scripts/llm-repeat-penalty.test.ts does.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// STATE_DIR redirected BEFORE the first import of anything config-derived.
const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-gemini-safety-'));
process.env.STATE_DIR = stateRoot;

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { googleSafetyOptions } = await import('../src/llm/internal/provider/capabilities.js');

const FULL = {
  provider: 'google',
  geminiSafety: { harassment: true, hateSpeech: false, sexuallyExplicit: true, dangerousContent: false },
};

test('google leg carries all four thresholds with checked=block polarity', () => {
  const out = googleSafetyOptions(FULL) as any;
  const byCat = Object.fromEntries(out.providerOptions.google.safetySettings.map((s: any) => [s.category, s.threshold]));
  assert.deepEqual(byCat, {
    HARM_CATEGORY_HATE_SPEECH: 'BLOCK_NONE',
    HARM_CATEGORY_DANGEROUS_CONTENT: 'BLOCK_NONE',
    HARM_CATEGORY_SEXUALLY_EXPLICIT: 'BLOCK_MEDIUM_AND_ABOVE',
    HARM_CATEGORY_HARASSMENT: 'BLOCK_MEDIUM_AND_ABOVE',
  });
});

test('absent flags read as allow, never as block', () => {
  const out = googleSafetyOptions({ provider: 'google' }) as any;
  for (const s of out.providerOptions.google.safetySettings) {
    assert.equal(s.threshold, 'BLOCK_NONE');
  }
});

test('every other provider gets an empty object', () => {
  for (const provider of ['ollama', 'openai-compatible', 'openai', 'anthropic', 'deepseek', 'openrouter']) {
    assert.deepEqual(googleSafetyOptions({ provider, geminiSafety: FULL.geminiSafety }), {});
  }
  assert.deepEqual(googleSafetyOptions(null), {});
  assert.deepEqual(googleSafetyOptions(undefined), {});
});

// Load a hand-written settings.json the way a controller restart would.
const SETTINGS_PATH = path.join(stateRoot, 'settings.json');
async function coldLoad(llm: Record<string, unknown>) {
  writeFileSync(SETTINGS_PATH, JSON.stringify({
    llm: { provider: 'google', model: 'gemini-2.5-flash', ...llm },
  }));
  setCache(null);
  await settings.load();
  return settings.get().llm;
}

test('the operator\'s boxes survive a controller restart', async () => {
  const llm = await coldLoad({
    geminiSafety: { harassment: true, hateSpeech: false, sexuallyExplicit: true, dangerousContent: false },
  });
  assert.deepEqual(llm.geminiSafety, {
    harassment: true, hateSpeech: false, sexuallyExplicit: true, dangerousContent: false,
  });
});

test('a hand-edited non-boolean repairs to allow and never wedges boot', async () => {
  const llm = await coldLoad({ geminiSafety: { harassment: 'yes', hateSpeech: 1 } });
  assert.deepEqual(llm.geminiSafety, {
    harassment: false, hateSpeech: false, sexuallyExplicit: false, dangerousContent: false,
  });
});
