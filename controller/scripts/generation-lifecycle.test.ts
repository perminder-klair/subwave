import assert from 'node:assert/strict';
import test from 'node:test';
import { generateText } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { createGenerationLifecycle } from '../src/llm/internal/core/generation.js';

const meta = { kind: 'test', leg: 'primary' as const, provider: 'test', modelLabel: 'test:model', targetId: 'target', timeoutMs: 30 };
test('a never-settling adapter is abandoned, aborted, and removed without SDK retries', async () => {
  const lifecycle = createGenerationLifecycle();
  let calls = 0;
  let signal: AbortSignal | undefined;
  const model = lifecycle.guard(new MockLanguageModelV3({ doGenerate: async (params) => {
    calls++;
    signal = params.abortSignal;
    return new Promise(() => {});
  } }), meta);
  const pending = generateText({ model, prompt: 'test' });
  await assert.rejects(pending, { code: 'PROVIDER_REQUEST_TIMEOUT' });
  assert.equal(calls, 1);
  assert.equal(signal?.aborted, true);
  assert.equal(lifecycle.snapshot().inFlightCount, 0);
  assert.equal(lifecycle.snapshot().status, 'fail');
});

const reply: Awaited<ReturnType<MockLanguageModelV3['doGenerate']>> = {
  content: [{ type: 'text' as const, text: 'ok' }],
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
  warnings: [],
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('caller cancellation is authoritative, even when an adapter ignores abort', async () => {
  const lifecycle = createGenerationLifecycle();
  let calls = 0;
  const controller = new AbortController();
  const reason = new Error('simple-segment budget exceeded');
  controller.abort(reason);
  const model = lifecycle.guard(new MockLanguageModelV3({ doGenerate: async () => {
    calls++;
    return new Promise(() => {});
  } }), { ...meta, timeoutMs: 1000 });
  await assert.rejects(generateText({ model, prompt: 'test', abortSignal: controller.signal }));
  assert.equal(calls, 0);
  assert.equal(lifecycle.snapshot().inFlightCount, 0);
  const live = new AbortController();
  const pending = generateText({ model, prompt: 'test', abortSignal: live.signal });
  await flush();
  live.abort(reason);
  await assert.rejects(pending, (err: any) => err.code === 'GENERATION_CANCELLED' && err.cause === reason);
  assert.equal(calls, 1);
  assert.equal(lifecycle.snapshot().status, 'idle');
});

test('stale active requests cannot be hidden by success; timeout evidence clears by newer success or five-minute expiry', async () => {
  let clock = 0;
  const lifecycle = createGenerationLifecycle(() => clock, () => clock);
  const parent = new AbortController();
  const hang = lifecycle.guard(new MockLanguageModelV3({ doGenerate: async () => new Promise(() => {}) }), { ...meta, timeoutMs: 1000 });
  const pending = generateText({ model: hang, prompt: 'test', abortSignal: parent.signal }).catch((e) => e);
  await flush();
  clock = 799;
  assert.equal(lifecycle.snapshot().status, 'ok');
  clock = 800;
  assert.equal(lifecycle.snapshot().status, 'fail');
  const good = lifecycle.guard(new MockLanguageModelV3({ doGenerate: async () => reply }), { ...meta, timeoutMs: 1000 });
  assert.equal((await generateText({ model: good, prompt: 'test' })).text, 'ok');
  assert.equal(lifecycle.snapshot().status, 'fail');
  parent.abort();
  await pending;
  assert.equal(lifecycle.snapshot().status, 'idle');

  const short = lifecycle.guard(new MockLanguageModelV3({ doGenerate: async () => new Promise(() => {}) }), meta);
  await assert.rejects(generateText({ model: short, prompt: 'test' }), { code: 'PROVIDER_REQUEST_TIMEOUT' });
  clock++;
  await generateText({ model: good, prompt: 'test' });
  assert.equal(lifecycle.snapshot().status, 'idle');
  await assert.rejects(generateText({ model: short, prompt: 'test' }));
  clock += 299_999;
  assert.equal(lifecycle.snapshot().status, 'fail');
  clock++;
  assert.equal(lifecycle.snapshot().status, 'idle');
});

test('late resolution or rejection is consumed and never clears timeout health', async () => {
  for (const rejectLate of [false, true]) {
    const lifecycle = createGenerationLifecycle();
    let complete!: (value: any) => void;
    const model = lifecycle.guard(new MockLanguageModelV3({ doGenerate: () => new Promise((resolve, reject) => {
      complete = rejectLate ? reject : resolve;
    }) }), meta);
    await assert.rejects(generateText({ model, prompt: 'test' }));
    complete(rejectLate ? new Error('late rejection') : reply);
    await flush();
    assert.equal(lifecycle.snapshot().status, 'fail');
    assert.equal(lifecycle.snapshot().inFlightCount, 0);
  }
});

test('synchronous adapter errors clean up, and concurrent target/role identities stay separate', async () => {
  const lifecycle = createGenerationLifecycle();
  const error = new Error('adapter failed');
  const broken = lifecycle.guard(new MockLanguageModelV3({ doGenerate: () => { throw error; } }), meta);
  await assert.rejects(generateText({ model: broken, prompt: 'test' }), error);
  assert.equal(lifecycle.snapshot().status, 'idle');
  const controller = new AbortController();
  const pending = ['target', 'other'].map((targetId, index) => generateText({
    model: lifecycle.guard(new MockLanguageModelV3({ doGenerate: async () => new Promise(() => {}) }), { ...meta, targetId, leg: index ? 'fallback' : 'primary', timeoutMs: 1000 }),
    prompt: 'SECRET PROMPT', abortSignal: controller.signal,
  }).catch((e) => e));
  await flush();
  const snapshot = lifecycle.snapshot();
  assert.equal(snapshot.inFlightCount, 2);
  assert.equal(snapshot.targets.length, 2);
  assert.equal(new Set(snapshot.requests.map((r) => r.requestId)).size, 2);
  assert.ok(!JSON.stringify(snapshot).includes('SECRET PROMPT'));
  controller.abort();
  await Promise.all(pending);
  assert.equal(lifecycle.snapshot().inFlightCount, 0);
});

test('cooperative transports cannot replace the winning timeout with AbortError', async () => {
  const lifecycle = createGenerationLifecycle();
  const model = lifecycle.guard(new MockLanguageModelV3({ doGenerate: (params) => new Promise((_resolve, reject) => {
    params.abortSignal!.addEventListener('abort', () => reject(new DOMException('transport aborted', 'AbortError')), { once: true });
  }) }), meta);
  await assert.rejects(generateText({ model, prompt: 'test' }), { code: 'PROVIDER_REQUEST_TIMEOUT' });
  assert.equal(lifecycle.snapshot().inFlightCount, 0);
});

test('abandoned tool-call results cannot execute a tool or publish SDK usage', async () => {
  const { tool } = await import('ai');
  const { z } = await import('zod');
  const lifecycle = createGenerationLifecycle();
  let finish!: (value: any) => void;
  let toolExecutions = 0;
  let finishes = 0;
  const model = lifecycle.guard(new MockLanguageModelV3({ doGenerate: () => new Promise((resolve) => { finish = resolve; }) }), meta);
  await assert.rejects(generateText({ model, prompt: 'test', tools: {
    emit: tool({ inputSchema: z.object({ ok: z.boolean() }), execute: async () => { toolExecutions++; return 'ok'; } }),
  }, onFinish: () => { finishes++; } }), { code: 'PROVIDER_REQUEST_TIMEOUT' });
  finish({ ...reply, content: [{ type: 'tool-call', toolCallId: 'late', toolName: 'emit', input: '{"ok":true}' }], finishReason: 'tool-calls' });
  await flush();
  assert.equal(toolExecutions, 0);
  assert.equal(finishes, 0);
  assert.equal(lifecycle.snapshot().status, 'fail');
});
