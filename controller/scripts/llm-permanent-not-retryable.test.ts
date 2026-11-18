// A retired model or rejected key behind a retryable status must reach failover
// after ONE provider attempt. The AI SDK retries any APICallError flagged
// retryable (a 429/5xx) before the controller's own classifiers run; seen live
// through CLIProxyAPI relaying Anthropic's retirement of claude-3-5-haiku under
// a 429, at three attempts and ~12s per call on every pick, link and segment.
// The generation guard (every failover leg's model) clears the flag for errors
// the controller already calls permanent; transient errors keep SDK retries.
import assert from 'node:assert/strict';
import test from 'node:test';
import { APICallError, generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { guardGenerationModel } from '../src/llm/internal/core/generation.js';
import { isModelUnavailable, isTransient } from '../src/llm/internal/core/pure.js';

const RELAYED = 'auth_unavailable: no auth available (providers=claude, model=claude-3-5-haiku-20241022; last upstream error: not_found_error: model: claude-3-5-haiku-20241022); check Claude auth/key session and cooldown state via /v0/management/auth-files';

function apiError(statusCode: number, message: string): any {
  return new APICallError({ message, url: 'http://proxy.invalid/v1/chat/completions', requestBodyValues: {}, statusCode });
}

function guardedModel(fail: () => Error) {
  let calls = 0;
  const inner = new MockLanguageModelV4({
    doGenerate: async () => { calls++; throw fail(); },
  });
  const model = guardGenerationModel(inner as any, {
    kind: 'test', leg: 'primary', provider: 'openai-compatible', modelLabel: 'test', targetId: 'test', timeoutMs: 30_000,
  });
  return { model, calls: () => calls };
}

test('the relayed Anthropic retirement classifies as a gone model, never transient', () => {
  const err = apiError(429, RELAYED);
  assert.equal(isModelUnavailable(err), true);
  assert.equal(isTransient(err), false);
  // Anthropic direct: a 404 whose whole message is the id.
  assert.equal(isModelUnavailable(apiError(404, 'model: claude-3-5-haiku-20241022')), true);
  // The bare form is not enough without the 404, and other not_found errors stay out.
  assert.equal(isModelUnavailable(apiError(500, 'model: claude-3-5-haiku-20241022')), false);
  assert.equal(isModelUnavailable(apiError(404, 'not_found_error: file: abc123')), false);
  assert.equal(isModelUnavailable(apiError(429, 'auth_unavailable: no auth available (providers=claude)')), false);
});

test('a retired model behind a 429 costs one provider attempt, not three', async () => {
  const { model, calls } = guardedModel(() => apiError(429, RELAYED));
  await assert.rejects(generateText({ model, prompt: 'hi' }), (err: any) => isModelUnavailable(err));
  assert.equal(calls(), 1);
});

test('a rejected key behind a 5xx is not retried by the SDK either', async () => {
  const { model, calls } = guardedModel(() => apiError(503, 'invalid api key'));
  await assert.rejects(generateText({ model, prompt: 'hi' }));
  assert.equal(calls(), 1);
});

test('a transient 503 keeps the SDK retry', async () => {
  const { model, calls } = guardedModel(() => apiError(503, 'Service Unavailable'));
  await assert.rejects(generateText({ model, prompt: 'hi', maxRetries: 1 }));
  assert.equal(calls(), 2);
});
