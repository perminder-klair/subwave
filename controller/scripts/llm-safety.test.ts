// googleSafetyOptions (llm/internal/provider/capabilities.ts) — the per-call
// safety channel for the native `google` provider.
//
// ai-sdk reads safetySettings ONLY from per-call providerOptions: the
// model-construction argument is ignored, and `safetySettings` is resolved from the parsed
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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// STATE_DIR redirected BEFORE the first import of anything config-derived.
const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-gemini-safety-'));
process.env.STATE_DIR = stateRoot;
after(() => rmSync(stateRoot, { recursive: true, force: true }));

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { googleSafetyOptions } = await import('../src/llm/internal/provider/capabilities.js');
const { fallbackLeg } = await import('../src/llm/internal/provider/legs.js');
const { djText } = await import('../src/llm/internal/strategy/text.js');
const { djObject } = await import('../src/llm/internal/strategy/object.js');
const { djAgent } = await import('../src/llm/internal/strategy/agent.js');
const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
const { generateText } = await import('ai');
const { z } = await import('zod');

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

const BACKUP_FLAGS = {
  harassment: false, hateSpeech: true, sexuallyExplicit: false, dangerousContent: true,
};
const ALLOW_ALL = {
  harassment: false, hateSpeech: false, sexuallyExplicit: false, dangerousContent: false,
};
const GOOGLE_FALLBACK = { enabled: true, provider: 'google', model: 'gemini-2.5-flash' };

test('real saves preserve independent primary and fallback flags across cold loads', async () => {
  await coldLoad({ fallback: GOOGLE_FALLBACK });
  await settings.update({ llm: {
    geminiSafety: FULL.geminiSafety,
    fallback: { geminiSafety: BACKUP_FLAGS },
  } });
  const saved = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
  assert.deepEqual(saved.llm.geminiSafety, FULL.geminiSafety);
  assert.deepEqual(saved.llm.fallback.geminiSafety, BACKUP_FLAGS);
  assert.deepEqual(fallbackLeg()!.cfg.geminiSafety, BACKUP_FLAGS);

  setCache(null);
  await settings.load();
  assert.deepEqual(settings.get().llm.geminiSafety, FULL.geminiSafety);
  assert.deepEqual(fallbackLeg()!.cfg.geminiSafety, BACKUP_FLAGS);

  // A whole-map save can clear a box without changing the other leg.
  await settings.update({ llm: { fallback: { geminiSafety: { ...BACKUP_FLAGS, hateSpeech: false } } } });
  setCache(null);
  await settings.load();
  assert.deepEqual(fallbackLeg()!.cfg.geminiSafety, { ...BACKUP_FLAGS, hateSpeech: false });
  assert.deepEqual(settings.get().llm.geminiSafety, FULL.geminiSafety);
});

test('an older fallback defaults to allow without inheriting primary flags', async () => {
  const llm = await coldLoad({ geminiSafety: FULL.geminiSafety, fallback: GOOGLE_FALLBACK });
  assert.deepEqual(llm.fallback.geminiSafety, ALLOW_ALL);
  const out = googleSafetyOptions(fallbackLeg()!.cfg) as any;
  assert.ok(out.providerOptions.google.safetySettings.every((s: any) => s.threshold === 'BLOCK_NONE'));
});

test('fallback load repairs non-booleans and save refuses malformed maps', async () => {
  const llm = await coldLoad({ fallback: { ...GOOGLE_FALLBACK, geminiSafety: { harassment: 'yes', hateSpeech: 1, dangerousContent: true } } });
  assert.deepEqual(llm.fallback.geminiSafety, { ...ALLOW_ALL, dangerousContent: true });
  for (const geminiSafety of [null, 'yes', []]) {
    await assert.rejects(settings.update({ llm: { fallback: { geminiSafety } } }), /llm\.fallback\.geminiSafety must be an object map/);
  }
});

// Capture the real SDK request at the registry's fetch boundary. Every call is
// intercepted; credentials are fake and no external service is contacted.
async function captureRequests(run: () => Promise<unknown>, failPrimary = false) {
  const realFetch = globalThis.fetch;
  const requests: { url: string; body: Record<string, any> }[] = [];
  globalThis.fetch = (async (url, init) => {
    const target = String(url);
    requests.push({ url: target, body: JSON.parse(String(init?.body)) });
    if (failPrimary && target.startsWith('https://primary.example/')) {
      return new Response(JSON.stringify({ error: { message: 'review auth failure' } }), {
        status: 401, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = realFetch;
  }
  return requests;
}

const OUTPUT_SCHEMA = z.object({ ok: z.boolean() });
const calls = {
  text: () => djText({ system: 'test', prompt: 'hi' }),
  object: () => djObject({ system: 'test', prompt: 'hi', schema: OUTPUT_SCHEMA }),
  agent: () => djAgent({ system: 'test', messages: [{ role: 'user', content: 'hi' }], schema: OUTPUT_SCHEMA, maxSteps: 1 }),
};

for (const [kind, run] of Object.entries(calls)) {
  test(`${kind} sends primary Gemini thresholds on the real SDK request`, async () => {
    await coldLoad({ keys: { google: 'test-key' }, geminiSafety: FULL.geminiSafety });
    const requests = await captureRequests(run);
    assert.equal(requests.length, 1);
    const expected = (googleSafetyOptions(FULL) as any).providerOptions.google.safetySettings;
    assert.deepEqual(requests[0].body.safetySettings, expected);
  });

  test(`${kind} fails over with the saved fallback thresholds after cold load`, async () => {
    await coldLoad({ provider: 'openai-compatible', model: 'primary', baseUrl: 'https://primary.example/v1', keys: { google: 'test-key' } });
    await settings.update({ llm: {
      geminiSafety: FULL.geminiSafety,
      fallback: { ...GOOGLE_FALLBACK, geminiSafety: BACKUP_FLAGS },
    } });
    setCache(null);
    await settings.load();
    const requests = await captureRequests(run, true);
    const primary = requests.filter(r => r.url.startsWith('https://primary.example/'));
    const fallback = requests.filter(r => r.url.startsWith('https://generativelanguage.googleapis.com/'));
    assert.ok(primary.length > 0);
    assert.ok(primary.every(r => r.body.safetySettings === undefined), 'non-Google primary gets no safety options');
    assert.equal(fallback.length, 1);
    const expected = (googleSafetyOptions({ provider: 'google', geminiSafety: BACKUP_FLAGS }) as any).providerOptions.google.safetySettings;
    assert.deepEqual(fallback[0].body.safetySettings, expected);
  });
}

test('model-construction options are ignored by the Google SDK', async () => {
  const google = createGoogleGenerativeAI({ apiKey: 'test-key' });
  const safetySettings = (googleSafetyOptions(FULL) as any).providerOptions.google.safetySettings;
  const requests = await captureRequests(() => generateText({
    // Older integrations passed a second construction argument. The SDK ignores
    // it, which is why strategies must use per-call providerOptions instead.
    model: (google as any)('gemini-2.5-flash', { safetySettings }),
    prompt: 'hi', maxRetries: 0,
  }));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.safetySettings, undefined);
});
