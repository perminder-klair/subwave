// Provider credentials stay with the service they belong to, and a rotated key
// reaches the next call without a restart.
//
// Two rules, pinned on the wire rather than on resolved config alone:
//   - the embedding leg reuses the chat leg's inline key (and headers) only when
//     it talks to the SAME service — same provider and, for an operator-set
//     server, the same resolved base URL. A plain single-provider station keeps
//     the fallback it has always had.
//   - a key a builder captures at construction keys the client cache by
//     fingerprint, so a key saved through the secrets form (process.env)
//     replaces a cached client instead of being ignored until restart.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-credential-scope-'));
process.env.STATE_DIR = stateRoot;
for (const k of ['EMBEDDING_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'REQUESTY_API_KEY', 'OPENAI_BASE_URL']) {
  delete process.env[k];
}

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { languageModel, credentialSig, pinnedApiKey, chatBaseUrl } = await import('../src/llm/internal/provider/registry.js');
const { resolveEmbeddingCfg, embeddingModel } = await import('../src/llm/internal/provider/embedding.js');
const { embeddingSharesChatCredential } = await import('../src/llm/internal/provider/capabilities.js');
const { generateText, embed } = await import('ai');

async function coldLoad(llm: Record<string, unknown>, embedding: Record<string, unknown> = {}) {
  writeFileSync(path.join(stateRoot, 'settings.json'), JSON.stringify({ llm, embedding }));
  setCache(null);
  await settings.load();
}

interface Captured { url: string; auth: string; headers: Headers }

// Swap global fetch for one call, answering whatever shape the SDK asked for.
async function capture(run: () => Promise<unknown>): Promise<Captured> {
  const real = globalThis.fetch;
  let seen: Captured | null = null;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen = { url: String(url), auth: headers.get('authorization') || '', headers };
    const body = String(url).includes('/embeddings')
      ? { data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }], model: 'm', usage: { prompt_tokens: 1, total_tokens: 1 } }
      : {
          id: 'x', object: 'chat.completion', created: 1, model: 'm',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = real;
  }
  assert.ok(seen, 'the SDK made no request');
  return seen!;
}

const embedOnce = () => capture(() => embed({ model: embeddingModel(), value: 'probe' }));

test('the sharing rule: same provider, and for a configured server the same server', () => {
  const share = embeddingSharesChatCredential;
  // Vendor endpoints serve both legs.
  for (const p of ['openai', 'google', 'openrouter', 'requesty']) {
    assert.equal(share({ provider: p }, { provider: p }), true, p);
  }
  // Anthropic embeds through OpenAI; ollama takes no key; chat-only providers.
  for (const p of ['anthropic', 'ollama', 'deepseek', 'gateway']) {
    assert.equal(share({ provider: p }, { provider: p }), false, p);
  }
  assert.equal(share({ provider: 'anthropic' }, { provider: 'openai' }), false);
  assert.equal(share({ provider: 'openrouter' }, { provider: 'openai-compatible', baseUrl: 'http://a/v1' }), false);
  // Configured servers: equal resolved URLs only (a trailing slash is the same server).
  const a = 'https://llm.example/v1';
  assert.equal(share({ provider: 'openai-compatible', baseUrl: a }, { provider: 'openai-compatible', baseUrl: `${a}/` }), true);
  assert.equal(share({ provider: 'openai-compatible', baseUrl: a }, { provider: 'openai-compatible', baseUrl: 'http://embed:8090/v1' }), false);
  assert.equal(share({ provider: 'openai-compatible', baseUrl: '' }, { provider: 'openai-compatible', baseUrl: '' }), false);
  // locca's chat and embed defaults are different servers.
  assert.equal(chatBaseUrl({ provider: 'locca' }), 'http://host.docker.internal:8080/v1');
  assert.equal(share({ provider: 'locca', baseUrl: chatBaseUrl({ provider: 'locca' }) },
    { provider: 'locca', baseUrl: 'http://host.docker.internal:8090/v1' }), false);
});

test('an anthropic chat key never reaches the OpenAI embeddings endpoint', async () => {
  await coldLoad({ provider: 'anthropic', model: 'claude-x', keys: { anthropic: 'sk-ant-chat-only' } });
  assert.equal(resolveEmbeddingCfg().provider, 'anthropic');
  assert.equal(resolveEmbeddingCfg().apiKey, '');
  // OpenAI's own env var is what the documented setup supplies — it must be used.
  process.env.OPENAI_API_KEY = 'sk-openai-env';
  try {
    const seen = await embedOnce();
    assert.match(seen.url, /api\.openai\.com/);
    assert.equal(seen.auth, 'Bearer sk-openai-env');
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test('a single-provider station keeps reusing its chat key for embeddings', async () => {
  await coldLoad({ provider: 'openai', model: 'gpt-x', keys: { openai: 'sk-openai-inline' } });
  assert.equal(resolveEmbeddingCfg().apiKey, 'sk-openai-inline');
  assert.equal((await embedOnce()).auth, 'Bearer sk-openai-inline');

  // Same self-hosted server for both legs: key and headers follow.
  await coldLoad({
    provider: 'openai-compatible', model: 'chat', baseUrl: 'https://llm.example/v1',
    keys: { 'openai-compatible': 'sk-compat' }, headers: { 'x-route': 'tenant-a' },
  }, { provider: 'openai-compatible', model: 'vec' });
  const seen = await embedOnce();
  assert.match(seen.url, /^https:\/\/llm\.example\/v1\/embeddings/);
  assert.equal(seen.auth, 'Bearer sk-compat');
  assert.equal(seen.headers.get('x-route'), 'tenant-a');
});

test('a chat key and headers never follow to a different embedding server', async () => {
  await coldLoad({
    provider: 'openai-compatible', model: 'chat', baseUrl: 'https://llm.example/v1',
    keys: { 'openai-compatible': 'sk-compat' }, headers: { 'x-route': 'tenant-a' },
  }, { provider: 'openai-compatible', model: 'vec', baseUrl: 'http://embed.lan:8090/v1' });
  const seen = await embedOnce();
  assert.match(seen.url, /^http:\/\/embed\.lan:8090\/v1\/embeddings/);
  assert.equal(seen.auth, 'Bearer unused');
  assert.equal(seen.headers.get('x-route'), null);

  // A hosted chat provider plus a self-hosted embedding leg.
  await coldLoad({ provider: 'openrouter', model: 'x/y', keys: { openrouter: 'sk-or-chat' } },
    { provider: 'locca', model: 'nomic-embed-text' });
  assert.equal((await embedOnce()).auth, 'Bearer unused');

  // An explicit embedding key still wins wherever the leg points.
  process.env.EMBEDDING_API_KEY = 'sk-embed-own';
  try {
    assert.equal((await embedOnce()).auth, 'Bearer sk-embed-own');
  } finally {
    delete process.env.EMBEDDING_API_KEY;
  }
});

test('probe overrides are judged after they apply, not against the saved leg', async () => {
  await coldLoad({ provider: 'openai', model: 'gpt-x', keys: { openai: 'sk-openai-inline' } });
  assert.equal(resolveEmbeddingCfg({ provider: 'openrouter' }).apiKey, '');
  assert.equal(resolveEmbeddingCfg({ provider: 'openai' }).apiKey, 'sk-openai-inline');

  await coldLoad({
    provider: 'openai-compatible', model: 'chat', baseUrl: 'https://llm.example/v1',
    headers: { 'x-route': 'tenant-a' },
  }, { provider: 'openai-compatible' });
  // Empty unsaved rows inherit only for the same server.
  assert.deepEqual(resolveEmbeddingCfg({ headers: {} }).headers, { 'x-route': 'tenant-a' });
  assert.deepEqual(resolveEmbeddingCfg({ headers: {}, baseUrl: 'http://other:8090/v1' }).headers, {});
});

test('a requesty chat key saved after the client was built takes effect', async () => {
  await coldLoad({ provider: 'requesty', model: 'openai/gpt-x' });
  const ask = () => capture(() => generateText({ model: languageModel(), prompt: 'hi', maxRetries: 0 }));
  assert.equal((await ask()).auth, 'Bearer unused');
  process.env.REQUESTY_API_KEY = 'rq-first';
  try {
    assert.equal((await ask()).auth, 'Bearer rq-first');
    process.env.REQUESTY_API_KEY = 'rq-rotated';
    assert.equal((await ask()).auth, 'Bearer rq-rotated');
  } finally {
    delete process.env.REQUESTY_API_KEY;
  }
});

test('openrouter and requesty embedding clients pick up a rotated env key', async () => {
  for (const [provider, env] of [['openrouter', 'OPENROUTER_API_KEY'], ['requesty', 'REQUESTY_API_KEY']] as const) {
    await coldLoad({ provider: 'ollama' }, { provider });
    assert.equal((await embedOnce()).auth, 'Bearer unused', provider);
    process.env[env] = `${provider}-one`;
    try {
      assert.equal((await embedOnce()).auth, `Bearer ${provider}-one`, provider);
      process.env[env] = `${provider}-two`;
      assert.equal((await embedOnce()).auth, `Bearer ${provider}-two`, provider);
    } finally {
      delete process.env[env];
    }
  }
});

test('a cache signature carries a fingerprint, never the key', () => {
  assert.equal(credentialSig(''), '');
  const sig = credentialSig('sk-very-secret-value');
  assert.match(sig, /^[0-9a-f]{16}$/);
  assert.ok(!sig.includes('secret'));
  assert.notEqual(sig, credentialSig('sk-very-secret-valuf'));
  // The env key counts only where the builder pins it.
  process.env.REQUESTY_API_KEY = 'rq-env';
  process.env.OPENAI_API_KEY = 'sk-env';
  try {
    assert.equal(pinnedApiKey({ provider: 'requesty', apiKey: '' }), 'rq-env');
    assert.equal(pinnedApiKey({ provider: 'requesty', apiKey: 'inline' }), 'inline');
    assert.equal(pinnedApiKey({ provider: 'openai', apiKey: '' }), '');
  } finally {
    delete process.env.REQUESTY_API_KEY;
    delete process.env.OPENAI_API_KEY;
  }
});
