import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-hosted-compat-'));
process.env.STATE_DIR = stateRoot;
process.env.ADMIN_USER = 'hosted-test';
process.env.ADMIN_PASS = 'hosted-test';

const { setCache, getRedacted } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { languageModel } = await import('../src/llm/internal/provider/registry.js');
const { buildEmbeddingModel, resolveEmbeddingCfg, embeddingModel } = await import('../src/llm/internal/provider/embedding.js');
const { needsToolCallObject, discoveryStepsFor, appliedRepeatPenalty } = await import('../src/llm/internal/provider/capabilities.js');
const { generateText, embed } = await import('ai');

const base = {
  provider: 'openai-compatible',
  model: 'vendor/chat',
  baseUrl: 'https://api.example/v1',
  headers: { 'api-key': 'test-secret' },
};

async function coldLoad(llm: Record<string, unknown>, embedding: Record<string, unknown> = {}) {
  writeFileSync(path.join(stateRoot, 'settings.json'), JSON.stringify({ llm: { ...base, ...llm }, embedding }));
  setCache(null);
  await settings.load();
}

test('hosted mode survives save and cold load independently for both legs', async () => {
  await coldLoad({ compatibleMode: 'hosted', fallback: {
    enabled: true, provider: 'openai-compatible', model: 'vendor/backup',
    baseUrl: 'https://backup.example/v1', compatibleMode: 'local',
  } });
  assert.equal(settings.get().llm.compatibleMode, 'hosted');
  assert.equal(settings.get().llm.fallback.compatibleMode, 'local');
  await settings.update({ llm: { compatibleMode: 'local', fallback: { compatibleMode: 'hosted' } } } as never);
  setCache(null);
  await settings.load();
  assert.equal(settings.get().llm.compatibleMode, 'local');
  assert.equal(settings.get().llm.fallback.compatibleMode, 'hosted');
  await assert.rejects(settings.update({ llm: { compatibleMode: 'other' } } as never), /compatibleMode/);
});

test('hosted mode uses native objects and skips local request extensions', async () => {
  await coldLoad({ compatibleMode: 'hosted', repeatPenalty: 1.2 });
  const cfg = { ...base, compatibleMode: 'hosted', repeatPenalty: 1.2 };
  assert.equal(needsToolCallObject(cfg), false);
  assert.equal(discoveryStepsFor(cfg), 3);
  assert.equal(appliedRepeatPenalty(cfg), null);
  assert.notEqual(languageModel(cfg), languageModel({ ...cfg, compatibleMode: 'local' }));

  const real = globalThis.fetch;
  let request: { headers: Headers; body: Record<string, unknown> } | undefined;
  globalThis.fetch = (async (_url, init) => {
    request = { headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
    return new Response(JSON.stringify({
      id: 'x', object: 'chat.completion', created: 1, model: cfg.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await generateText({ model: languageModel(cfg), prompt: 'hi', maxRetries: 0 });
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(request?.headers.get('api-key'), 'test-secret');
  assert.equal(request?.body.repeat_penalty, undefined);
  assert.equal(request?.body.chat_template_kwargs, undefined);
});

test('embedding headers survive cold load, are redacted, and reach the wire', async () => {
  await coldLoad({ compatibleMode: 'hosted' }, {
    provider: 'openai-compatible', model: 'vectors',
    headers: { 'api-key': 'embedding-secret' },
  });
  assert.deepEqual(settings.get().embedding.headers, { 'api-key': 'embedding-secret' });
  assert.deepEqual(getRedacted().embedding.headers, { 'api-key': 'set' });
  await settings.update({ embedding: { headers: { 'api-key': 'set' } } } as never);
  assert.equal(settings.get().embedding.headers['api-key'], 'embedding-secret');
  setCache(null);
  await settings.load();
  assert.equal(resolveEmbeddingCfg().headers?.['api-key'], 'embedding-secret');
  await assert.rejects(settings.update({ embedding: { headers: { 'bad header': 'x' } } } as never), /invalid header name/);

  const real = globalThis.fetch;
  let header = '';
  globalThis.fetch = (async (_url, init) => {
    header = new Headers(init?.headers).get('api-key') || '';
    return new Response(JSON.stringify({ data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }], model: 'vectors', usage: { prompt_tokens: 1, total_tokens: 1 } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await embed({ model: embeddingModel(), value: 'test' });
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(header, 'embedding-secret');
  assert.ok(buildEmbeddingModel(resolveEmbeddingCfg()));
});

test('embedding headers inherit the matching chat leg when no override is set', async () => {
  await coldLoad({ compatibleMode: 'hosted' }, { provider: 'openai-compatible', model: 'vectors' });
  assert.deepEqual(resolveEmbeddingCfg().headers, base.headers);
  await coldLoad({ compatibleMode: 'hosted' }, { provider: 'ollama' });
  assert.deepEqual(resolveEmbeddingCfg().headers, {});
});

test('model discovery sends the saved hosted service header', async () => {
  await coldLoad({ compatibleMode: 'hosted' });
  const express = (await import('express')).default;
  const { router } = await import('../src/routes/settings/llm.js');
  const app = express();
  app.use(router);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const authorization = `Basic ${Buffer.from('hosted-test:hosted-test').toString('base64')}`;
  const real = globalThis.fetch;
  let header = '';
  globalThis.fetch = (async (input, init) => {
    if (String(input) === 'https://api.example/v1/models') {
      header = new Headers(init?.headers).get('api-key') || '';
      return new Response(JSON.stringify({ data: [{ id: 'vendor/chat' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return real(input, init);
  }) as typeof fetch;
  try {
    const response = await fetch(`${baseUrl}/settings/llm/models?provider=openai-compatible&baseUrl=${encodeURIComponent(base.baseUrl)}`,
      { headers: { authorization } });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as { models: string[] }).models, ['vendor/chat']);
    assert.equal(header, 'test-secret');
  } finally {
    globalThis.fetch = real;
    server.close();
  }
});
