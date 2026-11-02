// doctor/agent-fit.ts: the agent-loop judgements DJ Doc makes about the live
// primary and the swap dialog makes about the incoming one. One module, so the
// two cannot hold the legs to different bars.
//
// Pinned here: each predicate's threshold and the edge on either side of it —
// the 8192 Ollama context floor (0 = provider default, other providers exempt),
// the 11B model-class line (code names always, small only with agentic picks),
// the ≥ 5-sample p90 and its index, and the deadline ratio's unset guard.
//
// Pure, no state dir.
// Run: npm test -- doctor-agent-fit

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_DEADLINE_WARN_RATIO,
  AGENT_LATENCY_MIN_SAMPLES,
  AGENT_NUM_CTX_FLOOR,
  agentDeadlineRatio,
  contextWindowTooSmall,
  latencyP90,
  modelClassConcern,
} from '../src/doctor/agent-fit.js';

test('context window: only an Ollama window below the floor', () => {
  assert.equal(AGENT_NUM_CTX_FLOOR, 8192);
  assert.equal(contextWindowTooSmall('ollama', 4096), 4096);
  assert.equal(contextWindowTooSmall('ollama', '8191'), 8191);
  assert.equal(contextWindowTooSmall('ollama', 8192), null);
  assert.equal(contextWindowTooSmall('ollama', 0), null, '0 is the provider default');
  assert.equal(contextWindowTooSmall('ollama', undefined), null);
  assert.equal(contextWindowTooSmall('openai-compatible', 4096), null);
});

test('model class: code names always, small models only with agentic picks', () => {
  assert.deepEqual(modelClassConcern('ollama:qwen2.5-coder:32b', false), { kind: 'code' });
  assert.deepEqual(modelClassConcern('gemma3:4b', true), { kind: 'small', sizeB: 4 });
  assert.equal(modelClassConcern('gemma3:4b', false), null);
  assert.deepEqual(modelClassConcern('ollama:mistral:10.7b', true), { kind: 'small', sizeB: 10.7 });
  assert.equal(modelClassConcern('ollama:qwen3:14b', true), null, '11B and up pass');
  assert.equal(modelClassConcern('', true), null);
});

test('latency p90: successful timed rows only, at least five of them', () => {
  assert.equal(AGENT_LATENCY_MIN_SAMPLES, 5);
  const ok = (ms: number, model = 'a') => ({ ok: true, ms, model });
  assert.equal(latencyP90([ok(1), ok(2), ok(3), ok(4)]), null, 'four rows are too few');
  assert.equal(latencyP90([ok(5), ok(1), ok(4), ok(2), ok(3)]), 5, 'floor(5 × 0.9) = index 4');
  const ten = Array.from({ length: 10 }, (_, i) => ok((i + 1) * 100));
  assert.equal(latencyP90(ten), 1000, 'index 9 of 10');
  const mixed = [...ten, { ok: false, ms: 99999 }, { ok: true, ms: 0 }, null, { ok: true }];
  assert.equal(latencyP90(mixed), 1000, 'failed, zero, missing and untimed rows are not latency');
  const two = [...Array.from({ length: 5 }, () => ok(10, 'a')), ...Array.from({ length: 5 }, () => ok(90, 'b'))];
  assert.equal(latencyP90(two, c => c.model === 'a'), 10, 'the include filter selects one leg');
});

test('deadline ratio: p90 over the deadline, null when the deadline is unset', () => {
  assert.equal(AGENT_DEADLINE_WARN_RATIO, 0.8);
  assert.equal(agentDeadlineRatio(36000, 45000), 0.8);
  assert.equal(agentDeadlineRatio(36000, '45000'), 0.8);
  assert.equal(agentDeadlineRatio(36000, 0), null);
  assert.equal(agentDeadlineRatio(36000, undefined), null);
});
