// "Swap with primary" (settings/llm-swap.ts + POST /settings/llm/swap): the
// backup LLM leg becomes the primary and vice versa in one save.
//
// Pinned here, each a different way the swap could quietly go wrong:
//   - every per-leg field moves, and swapping twice is the identity — run
//     through the REAL settings.update(), because its leg patch MERGES
//     providerBaseUrls and resolves redacted headers against the target leg;
//   - LLM_LEG_FIELDS is exactly the set of keys applyLlmLegPatch READS (a
//     recording Proxy, not a hand-written fixture), and every per-leg DEFAULTS
//     entry, so a new per-leg field cannot be added and left out of the swap;
//   - API keys and station-wide fields stay put (keys are per PROVIDER);
//   - an embedding leg that inherits from the primary keeps its connection,
//     inline key included, while one the operator set in the Library tagger is
//     untouched;
//   - an inherited inline key longer than embedding.apiKey holds is NOT pinned
//     (and says so) instead of the whole swap being refused over it;
//   - the route: no enabled backup is a 409 that writes nothing, the response
//     is the receipt alone (never update()'s raw `saved` with its secrets), and
//     the fit preview names exactly the pins the swap then writes.
//
// No credentials and no external host.

import assert from 'node:assert/strict';
import { createTempDir } from './test-utils/temp-dir.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-llm-swap-'));
process.env.STATE_DIR = stateRoot;
process.env.ADMIN_USER = 'test-admin';
process.env.ADMIN_PASS = 'test-pass';
delete process.env.EMBEDDING_API_KEY;

const settings = await import('../src/settings.js');
const { DEFAULTS } = await import('../src/settings/defaults.js');
const { applyLlmLegPatch, EMBEDDING_API_KEY_MAX } = await import('../src/settings/vocab.js');
const { buildLlmSwapPatch, planLlmSwap, LLM_LEG_FIELDS, LlmSwapError } = await import('../src/settings/llm-swap.js');
const { resolveEmbeddingCfg, embeddingInfoOf, embeddingBaseUrl } = await import('../src/llm/provider.js');

const PRIMARY = {
  provider: 'ollama',
  model: 'qwen3:14b',
  ollamaUrl: 'http://gpu-box:11434',
  providerBaseUrls: { 'openai-compatible': 'https://old.example/v1' },
  headers: {},
  compatibleMode: 'auto',
  reasoning: false,
  toolChoice: 'required',
  discoverySteps: 0,
  numCtx: 32768,
  repeatPenalty: 1.1,
  geminiSafety: { harassment: false, hate: false, sexual: false, dangerous: false, civic: false },
};
const BACKUP = {
  enabled: true,
  provider: 'openai-compatible',
  model: 'deepseek-v4-flash',
  ollamaUrl: '',
  providerBaseUrls: { 'openai-compatible': 'https://gateway.example/v1', locca: 'http://locca:8080/v1' },
  headers: { 'x-session': 'secret-session' },
  compatibleMode: 'hosted',
  reasoning: true,
  toolChoice: 'auto',
  discoverySteps: 3,
  numCtx: 8192,
  repeatPenalty: 1.0,
  geminiSafety: { harassment: true, hate: false, sexual: false, dangerous: false, civic: false },
};

async function reset(extra: Record<string, unknown> = {}) {
  const fbOff = { ...BACKUP, enabled: false };
  await settings.update({ llm: { ...PRIMARY, apiKey: '', fallback: fbOff }, embedding: { provider: '', ollamaUrl: '', apiKey: '', headers: {} } });
  // providerBaseUrls MERGE on save, so blank anything an earlier test added.
  await settings.update({
    llm: {
      providerBaseUrls: { 'openai-compatible': PRIMARY.providerBaseUrls['openai-compatible'], locca: '' },
      fallback: { ...BACKUP, providerBaseUrls: BACKUP.providerBaseUrls },
      maxOutputTokens: 2000,
      agentTimeoutMs: 60000,
    },
    ...extra,
  });
}

async function swap() {
  const patch = buildLlmSwapPatch(settings.get(), resolveEmbeddingCfg(), !!process.env.EMBEDDING_API_KEY);
  return (await settings.update(patch)).saved;
}

const leg = (l: Record<string, unknown>) =>
  Object.fromEntries(LLM_LEG_FIELDS.map(k => [k, l[k]]));

test('every per-leg field moves to the other leg', async () => {
  await reset();
  const before = settings.get().llm;
  const after = (await swap()).llm;
  assert.deepEqual(leg(after), leg(before.fallback), 'the backup became the primary');
  assert.deepEqual(leg(after.fallback), leg(before), 'the primary became the backup');
  assert.equal(after.fallback.enabled, true);
  assert.equal(after.baseUrl, 'https://gateway.example/v1', 'flat baseUrl re-derived for the new primary');
  assert.deepEqual(after.headers, { 'x-session': 'secret-session' }, 'raw header values moved, not the redaction');
});

test('swapping twice restores the starting legs exactly', async () => {
  await reset();
  const before = structuredClone(settings.get().llm);
  await swap();
  const back = (await swap()).llm;
  assert.deepEqual(leg(back), leg(before));
  assert.deepEqual(leg(back.fallback), leg(before.fallback));
  assert.equal(back.baseUrl, before.baseUrl);
  assert.equal(back.fallback.baseUrl, before.fallback.baseUrl);
});

test('API keys and station-wide fields stay put', async () => {
  await reset();
  await settings.update({ llm: { fallback: { provider: 'openai-compatible', apiKey: 'sk-gateway' } } });
  const before = structuredClone(settings.get().llm);
  const after = (await swap()).llm;
  assert.deepEqual(after.keys, before.keys, 'keys are per provider and follow it to whichever leg names it');
  assert.equal(after.keys['openai-compatible'], 'sk-gateway');
  assert.equal(after.maxOutputTokens, 2000);
  assert.equal(after.agentTimeoutMs, 60000);
});

test('LLM_LEG_FIELDS is every field applyLlmLegPatch reads, less the derived baseUrl', () => {
  // Record what the patch handler LOOKS AT: it writes a key only when the patch
  // carries it, so a hand-written fixture would miss a field added to the
  // handler but not to the fixture.
  const read = new Set<string>();
  const recorder = new Proxy({}, {
    get(_t, key) { if (typeof key === 'string') read.add(key); return undefined; },
    has(_t, key) { if (typeof key === 'string') read.add(key); return false; },
  });
  applyLlmLegPatch({}, recorder, 'llm');
  read.delete('baseUrl');
  assert.deepEqual([...read].sort(), [...LLM_LEG_FIELDS].sort(), 'a per-leg field the swap would leave behind');

  // The three-edits rule gives every per-leg field a DEFAULTS entry too.
  const perLeg = Object.keys(DEFAULTS.llm.fallback).filter(k => !['enabled', 'apiKey', 'baseUrl'].includes(k));
  assert.deepEqual(perLeg.sort(), [...LLM_LEG_FIELDS].sort());
});

test('an embedding leg inheriting the primary keeps its connection', async () => {
  await reset();
  const before = resolveEmbeddingCfg();
  assert.equal(before.provider, 'ollama');
  await swap();
  const after = resolveEmbeddingCfg();
  assert.equal(settings.get().llm.provider, 'openai-compatible');
  assert.equal(after.provider, before.provider);
  assert.equal(after.ollamaUrl, before.ollamaUrl);
  assert.equal(after.baseUrl, before.baseUrl);
  assert.deepEqual(after.headers, before.headers, 'the new primary\'s gateway headers did not leak in');
});

test('an embedding leg set in the Library tagger is untouched', async () => {
  await reset({ embedding: { provider: 'openai', model: 'text-embedding-3-small', ollamaUrl: '', headers: {} } });
  const own = structuredClone(settings.get().embedding);
  await swap();
  const e = settings.get().embedding;
  assert.equal(e.provider, own.provider);
  assert.equal(e.model, own.model);
  assert.deepEqual(e.headers, own.headers);
});

test('no enabled backup refuses to build a swap', async () => {
  await reset();
  await settings.update({ llm: { fallback: { enabled: false } } });
  assert.throws(() => buildLlmSwapPatch(settings.get(), resolveEmbeddingCfg()), LlmSwapError);
});

// The backup (an openai-compatible gateway) made primary, with an inline key
// and an embedding leg that inherits all of it.
async function gatewayPrimary(key: string) {
  await reset();
  await swap();
  await settings.update({
    llm: { apiKey: key },
    embedding: { provider: '', ollamaUrl: '', apiKey: '', headers: {}, providerBaseUrls: { 'openai-compatible': '', ollama: '' } },
  });
  const before = resolveEmbeddingCfg();
  assert.equal(before.provider, 'openai-compatible');
  assert.equal(before.apiKey, key, 'the embedding leg is using the chat leg\'s inline key');
  return before;
}

test('an inherited inline key is pinned with the rest of the connection', async () => {
  const before = await gatewayPrimary('sk-chat');
  const plan = planLlmSwap(settings.get(), resolveEmbeddingCfg());
  assert.deepEqual(plan.pinned, ['provider', 'providerBaseUrls', 'headers', 'apiKey']);
  assert.equal(plan.keyNotPinned, false);
  await settings.update(plan.patch);
  assert.equal(settings.get().llm.provider, 'ollama');
  const after = resolveEmbeddingCfg();
  assert.equal(after.apiKey, 'sk-chat');
  assert.equal(after.baseUrl, before.baseUrl);
  assert.deepEqual(after.headers, before.headers);
});

test('an inherited key longer than embedding.apiKey holds is skipped, not a refused swap', async () => {
  const long = 'k'.repeat(EMBEDDING_API_KEY_MAX + 100);
  await gatewayPrimary(long);
  const plan = planLlmSwap(settings.get(), resolveEmbeddingCfg());
  assert.equal(plan.keyNotPinned, true);
  assert.ok(!plan.pinned.includes('apiKey'));
  // update() caps embedding.apiKey, so pinning this key threw and lost the swap.
  await settings.update(plan.patch);
  assert.equal(settings.get().llm.provider, 'ollama', 'the swap went through');
  assert.equal(settings.get().embedding.apiKey, '');
  assert.equal(settings.get().embedding.provider, 'openai-compatible', 'the rest is still pinned');
});

// --- the route --------------------------------------------------------------
const express = (await import('express')).default;
const { router } = await import('../src/routes/settings/core.js');
const app = express();
app.use(express.json());
app.use(router);
const server = createServer(app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
server.unref();
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const authorization = `Basic ${Buffer.from('test-admin:test-pass').toString('base64')}`;

test('POST /settings/llm/swap with no enabled backup is a 409 that writes nothing', async () => {
  await reset();
  await settings.update({ llm: { fallback: { enabled: false } } });
  const before = structuredClone(settings.get());
  const res = await fetch(`${base}/settings/llm/swap`, { method: 'POST', headers: { authorization } });
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /no backup LLM is enabled/);
  assert.deepEqual(settings.get().llm, before.llm);
  assert.deepEqual(settings.get().embedding, before.embedding);
});

test('POST /settings/llm/swap answers the receipt alone, never the raw saved settings', async () => {
  await gatewayPrimary('sk-chat');
  const res = await fetch(`${base}/settings/llm/swap`, { method: 'POST', headers: { authorization } });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const body = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['keyNotPinned', 'pinned', 'requiresRestart']);
  assert.ok(!text.includes('sk-chat') && !text.includes('secret-session'), 'no key or header value in the response');
  assert.equal(settings.get().llm.provider, 'ollama');
});

test('GET /settings/llm/swap/fit previews exactly the pins the swap writes', async () => {
  await gatewayPrimary('k'.repeat(EMBEDDING_API_KEY_MAX + 1));
  const fit = await fetch(`${base}/settings/llm/swap/fit`, { headers: { authorization } });
  assert.equal(fit.status, 200);
  const preview = ((await fit.json()) as { embedding: { pinned: string[]; keyNotPinned: boolean } }).embedding;
  const swapped = await fetch(`${base}/settings/llm/swap`, { method: 'POST', headers: { authorization } });
  const receipt = (await swapped.json()) as { pinned: string[]; keyNotPinned: boolean };
  assert.deepEqual(preview, { pinned: receipt.pinned, keyNotPinned: receipt.keyNotPinned });
  assert.deepEqual(preview, { pinned: ['provider', 'providerBaseUrls', 'headers'], keyNotPinned: true });
});

// A blank server URL reaches a built-in default only when a call is made, so
// the embedding leg was "inheriting" a server no setting names. Left blank by
// the pin, it would follow whatever server the incoming primary names.
test('an inherited blank Ollama URL is pinned to the default server it reaches', async () => {
  await reset();
  await settings.update({
    llm: {
      ollamaUrl: '',
      fallback: { provider: 'ollama', model: 'qwen3:14b', ollamaUrl: 'http://other-box:11434', compatibleMode: 'local' },
    },
  });
  const before = embeddingInfoOf(resolveEmbeddingCfg());
  assert.equal(before.provider, 'ollama');
  const res = await fetch(`${base}/settings/llm/swap`, { method: 'POST', headers: { authorization } });
  assert.equal(res.status, 200, await res.text());
  assert.equal(settings.get().llm.ollamaUrl, 'http://other-box:11434', 'the backup host is the primary now');
  assert.equal(embeddingInfoOf(resolveEmbeddingCfg()).ollamaUrl, before.ollamaUrl, 'embeddings stay on their server');
});

test('an inherited blank locca URL is pinned to the default embed server it reaches', async () => {
  await reset();
  await settings.update({
    llm: {
      provider: 'locca', model: 'chat-a', providerBaseUrls: { locca: '' },
      fallback: { provider: 'locca', model: 'chat-b', providerBaseUrls: { locca: 'http://other-box:8080/v1' }, compatibleMode: 'local' },
    },
  });
  const before = embeddingBaseUrl(resolveEmbeddingCfg());
  const res = await fetch(`${base}/settings/llm/swap`, { method: 'POST', headers: { authorization } });
  assert.equal(res.status, 200, await res.text());
  assert.equal(settings.get().llm.baseUrl, 'http://other-box:8080/v1', 'the backup server is the primary now');
  assert.equal(embeddingBaseUrl(resolveEmbeddingCfg()), before, 'embeddings stay on their server');
});
