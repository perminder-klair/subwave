// Pins the durable controller-log summary for successful LLM calls (#1435).
// Raw request capture is intentionally separate and may contain full prompts;
// this line is the small metadata-only record operators can grep over time.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { removeTempDir } from './test-utils/temp-dir.js';

const root = mkdtempSync(join(tmpdir(), 'subwave-llm-call-log-'));
process.env.STATE_DIR = root;

const { record } = await import('../src/llm/internal/telemetry/log.js');

function captureLog(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

test('a successful LLM call emits one grep-friendly metadata summary', () => {
  const lines = captureLog(() => record({
    kind: 'generateBanter',
    ok: true,
    ms: 7263,
    model: 'ollama:qwen3:8b',
    via: 'ai-sdk:tool',
    usage: { input: 1358, output: 33, total: 1391 },
    system: 'private system prompt',
    user: 'private user prompt',
    response: 'private model response',
  }));

  assert.deepEqual(lines, [
    '[generateBanter] ollama:qwen3:8b via ai-sdk:tool — 7263ms, 1358/33 tokens',
  ]);
  assert.doesNotMatch(lines[0], /private/);
});

test('a successful call does not invent zero tokens when usage is absent', () => {
  const lines = captureLog(() => record({
    kind: 'generateSegment',
    ok: true,
    ms: 804,
    model: 'openai:gpt-5-mini',
    via: 'ai-sdk',
  }));

  assert.deepEqual(lines, [
    '[generateSegment] openai:gpt-5-mini via ai-sdk — 804ms, token usage unavailable',
  ]);
});

test('failed calls do not duplicate the existing retry and failure logs', () => {
  const lines = captureLog(() => record({
    kind: 'pickNextTrack',
    ok: false,
    ms: 2000,
    model: 'ollama:qwen3:8b',
    via: 'ai-sdk:tool',
    error: 'fetch failed',
  }));

  assert.deepEqual(lines, []);
});

test.after(async () => {
  await removeTempDir(root);
});
