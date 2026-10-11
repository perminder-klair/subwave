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

// ── #1693: the hosted-mode wire contract ────────────────────────────────────
// Strict cloud endpoints (Mistral) reject unknown body fields with a 422
// extra_forbidden, and reject response_format json_schema alongside tools
// unless tool_choice is 'auto'. Hosted mode must never send any of the
// llama.cpp/vLLM extensions the local transport injects, on any path, and no
// strategy path may pair response_format with a forced tool_choice.

const { reasoningFor } = await import('../src/llm/internal/provider/capabilities.js');
const { tool } = await import('ai');
const { z } = await import('zod');

const LOCAL_ONLY_KEYS = [
  'chat_template_kwargs', 'reasoning_format', 'thinking', 'reasoning',
  'reasoning_effort', 'repeat_penalty', 'parallel_tool_calls',
] as const;

function assertHostedClean(body: Record<string, any>, where: string) {
  for (const key of LOCAL_ONLY_KEYS) {
    assert.equal(body[key], undefined, `${where}: hosted body carries local-only field ${key}`);
  }
}

const toolNames = (body: Record<string, any>): string[] =>
  Array.isArray(body.tools) ? body.tools.map((t: any) => t.function?.name) : [];

// Deterministic OpenAI chat-completion stand-in. A forced tool choice answers
// with a tool call (`done` when it is offered, else the first tool); a first
// unforced turn with tools calls the first discovery tool so the native path
// counts as explored; anything else answers the JSON object.
function chatReply(body: Record<string, any>): Response {
  const names = toolNames(body);
  const hasToolResult = (body.messages || []).some((m: any) => m.role === 'tool');
  let message: Record<string, unknown>;
  let finish = 'stop';
  const forced = body.tool_choice === 'required';
  if (names.length && (forced || !hasToolResult)) {
    const name = forced && names.includes('done') ? 'done' : names.find(n => n !== 'done') || names[0];
    const args = name === 'done' || name === 'emit' || name === 't' ? { id: 'a' } : { query: 'x' };
    message = { role: 'assistant', content: null, tool_calls: [{ id: `call${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
    finish = 'tool_calls';
  } else {
    message = { role: 'assistant', content: '{"id":"a"}' };
  }
  return new Response(JSON.stringify({
    id: 'x', object: 'chat.completion', created: 1, model: body.model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

// Runs fn with globalThis.fetch capturing every chat-completion body.
async function captureBodies(fn: () => Promise<unknown>): Promise<Record<string, any>[]> {
  const real = globalThis.fetch;
  const bodies: Record<string, any>[] = [];
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    return chatReply(body);
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
  return bodies;
}

const mistral = { provider: 'openai-compatible', baseUrl: 'https://api.mistral.ai/v1', compatibleMode: 'hosted', repeatPenalty: 1.2 };
const pickTool = () => tool({ description: 'pick', inputSchema: z.object({ id: z.string() }), execute: async () => 'ok' });

test('hosted mode sends no local-only fields on any transport variant (#1693)', async () => {
  for (const model of ['ministral-14b-latest', 'claude-sonnet-5-5']) {
    for (const reasoning of [false, true]) {
      for (const forceNoThink of [false, true]) {
        const cfg = { ...mistral, model, reasoning };
        const where = `${model} reasoning=${reasoning} forceNoThink=${forceNoThink}`;
        assert.equal(reasoningFor(cfg, { forceNoThink }), undefined, `${where}: reasoningFor`);
        const bodies = await captureBodies(async () => {
          await generateText({ model: languageModel(cfg, { forceNoThink }), prompt: 'hi', maxRetries: 0 });
          await generateText({
            model: languageModel(cfg, { forceNoThink }), prompt: 'hi', maxRetries: 0,
            tools: { t: pickTool() }, toolChoice: 'required',
          });
        });
        assert.equal(bodies.length, 2, where);
        assert.equal(bodies[1].tool_choice, 'required', `${where}: forced tool request reached the wire`);
        bodies.forEach(b => assertHostedClean(b, where));
      }
    }
  }
});

test('hosted fallback leg is clean on model, noThinkModel and objectViaToolCall (#1693)', async () => {
  const { fallbackLeg } = await import('../src/llm/internal/provider/legs.js');
  const { objectViaToolCall } = await import('../src/llm/internal/strategy/object-via-tool.js');
  await coldLoad({ provider: 'ollama', model: 'llama3', compatibleMode: 'local', fallback: {
    enabled: true, provider: 'openai-compatible', model: 'ministral-8b-latest',
    baseUrl: 'https://api.mistral.ai/v1', compatibleMode: 'hosted', repeatPenalty: 1.3,
  } });
  const leg = fallbackLeg();
  assert.ok(leg, 'fallback leg built');
  assert.equal(leg.cfg.compatibleMode, 'hosted');
  let emitted: unknown;
  const bodies = await captureBodies(async () => {
    for (const model of [leg.model, leg.noThinkModel]) {
      await generateText({ model, prompt: 'hi', maxRetries: 0 });
      await generateText({ model, prompt: 'hi', maxRetries: 0, tools: { t: pickTool() }, toolChoice: 'required' });
    }
    ({ object: emitted } = await objectViaToolCall(leg, { prompt: 'pick', schema: z.object({ id: z.string() }) }));
  });
  assert.deepEqual(emitted, { id: 'a' });
  assert.equal(bodies.length, 5);
  assert.ok(bodies.every(b => b.model === 'ministral-8b-latest'));
  assert.equal(bodies[4].tool_choice, 'required', 'objectViaToolCall forced the emit tool');
  bodies.forEach((b, i) => assertHostedClean(b, `fallback body ${i}`));
});

test('hosted strategy paths never pair response_format with a forced tool_choice (#1693 case D)', async () => {
  const { djAgent } = await import('../src/llm/internal/strategy/agent.js');
  const { djObject } = await import('../src/llm/internal/strategy/object.js');
  await coldLoad({ provider: 'openai-compatible', model: 'ministral-3b-latest', baseUrl: 'https://api.mistral.ai/v1',
    headers: {}, compatibleMode: 'hosted', repeatPenalty: 1.2, reasoning: false });
  const schema = z.object({ id: z.string() });
  const tools = () => ({
    search: tool({ description: 'search the library', inputSchema: z.object({ query: z.string() }), execute: async () => ({ ids: ['a'] }) }),
  });
  const agentArgs = () => ({
    system: 'You are a DJ.', messages: [{ role: 'user' as const, content: 'pick' }],
    tools: tools(), schema, providerDiscoveryBudget: true,
  });

  const native = await captureBodies(async () => {
    const out = await djAgent(agentArgs());
    assert.deepEqual(out.object, { id: 'a' });
  });
  const fellThrough = await captureBodies(async () => {
    const out = await djAgent({ ...agentArgs(), validate: () => false });
    assert.deepEqual(out.object, { id: 'a' });
  });
  const object = await captureBodies(async () => {
    const out = await djObject({ system: 'You are a DJ.', prompt: 'pick', schema });
    assert.deepEqual(out, { id: 'a' });
  });

  const all = [...native, ...fellThrough, ...object];
  all.forEach((b, i) => {
    assertHostedClean(b, `strategy body ${i}`);
    if (b.response_format !== undefined) {
      assert.ok(b.tool_choice === undefined || b.tool_choice === 'auto',
        `strategy body ${i}: response_format sent with tool_choice ${JSON.stringify(b.tool_choice)}`);
    }
    if (b.tool_choice === 'required') {
      assert.equal(b.response_format, undefined, `strategy body ${i}: forced tool_choice sent with response_format`);
    }
  });
  // Non-vacuity: the native path really sent json_schema next to tools, the
  // fall-through really forced a tool, and djObject really asked for json_schema.
  assert.ok(native.some(b => b.response_format?.type === 'json_schema' && toolNames(b).length > 0),
    'native djAgent sent json_schema with tools');
  assert.ok(fellThrough.some(b => b.tool_choice === 'required'), 'fall-through forced a tool call');
  assert.ok(fellThrough.some(b => toolNames(b).includes('done')), 'fall-through reached the done tool');
  assert.ok(object.some(b => b.response_format?.type === 'json_schema'), 'djObject sent json_schema');
});

test('local mode control still injects the llama.cpp extensions (#1693)', async () => {
  const cfg = { provider: 'openai-compatible', model: 'vendor/local-control', baseUrl: 'http://llama.local/v1',
    compatibleMode: 'local', reasoning: false, repeatPenalty: 1.2 };
  const [body] = await captureBodies(() => generateText({
    model: languageModel(cfg), prompt: 'hi', maxRetries: 0, tools: { t: pickTool() }, toolChoice: 'required',
  }));
  assert.equal(body.chat_template_kwargs?.enable_thinking, false);
  assert.equal(body.reasoning_format, 'deepseek');
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.deepEqual(body.reasoning, { enabled: false });
  assert.equal(body.repeat_penalty, 1.2);
  assert.equal(body.parallel_tool_calls, false);
});
