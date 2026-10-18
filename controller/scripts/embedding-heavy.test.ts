// Unit tests for the embedding-model perf advisory's pure decision logic —
// isHeavyEmbeddingModel + isLocalEmbeddingProvider — that drive the doctor's
// "embedding model" warning (a heavy LOCAL model is the quiet cause of slow
// re-embeds on a CPU/NAS box). Name/string based and side-effect-free, pinned
// here so a regex slip (e.g. dropping the bge-m3 case, or flagging cloud
// providers) fails an assert before it ships.
// Run: `npm test -- embedding-heavy`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isHeavyEmbeddingModel, isLocalEmbeddingProvider } from '../src/llm/provider.js';

await test('the light homelab default is NOT heavy', () => {
  assert.equal(isHeavyEmbeddingModel('nomic-embed-text'), false);
  assert.equal(isHeavyEmbeddingModel('nomic-embed-text:latest'), false);
});
await test('other small models are NOT heavy', () => {
  assert.equal(isHeavyEmbeddingModel('all-minilm'), false);
  assert.equal(isHeavyEmbeddingModel('text-embedding-3-small'), false);
  assert.equal(isHeavyEmbeddingModel('text-embedding-004'), false);
});
await test('bge-m3 is heavy (the case that started this)', () => {
  assert.equal(isHeavyEmbeddingModel('bge-m3'), true);
  assert.equal(isHeavyEmbeddingModel('bge-m3:latest'), true);
});
await test('the *-large family is heavy', () => {
  assert.equal(isHeavyEmbeddingModel('mxbai-embed-large'), true);
  assert.equal(isHeavyEmbeddingModel('bge-large-en-v1.5'), true);
  assert.equal(isHeavyEmbeddingModel('text-embedding-3-large'), true);
});
await test('qwen embeddings are heavy', () => {
  assert.equal(isHeavyEmbeddingModel('qwen3-embedding'), true);
  assert.equal(isHeavyEmbeddingModel('qwen-embed'), true);
});
await test('unknown / empty names default to NOT heavy (no false alarms)', () => {
  assert.equal(isHeavyEmbeddingModel('some-random-model'), false);
  assert.equal(isHeavyEmbeddingModel(''), false);
  assert.equal(isHeavyEmbeddingModel(undefined as unknown as string), false);
});

await test('self-hosted providers are local', () => {
  assert.equal(isLocalEmbeddingProvider('ollama'), true);
  assert.equal(isLocalEmbeddingProvider('locca'), true);
  assert.equal(isLocalEmbeddingProvider('openai-compatible'), true);
});
await test('cloud providers are NOT local (never flagged for model weight)', () => {
  assert.equal(isLocalEmbeddingProvider('openai'), false);
  assert.equal(isLocalEmbeddingProvider('google'), false);
  assert.equal(isLocalEmbeddingProvider('openrouter'), false);
  assert.equal(isLocalEmbeddingProvider(''), false);
});
