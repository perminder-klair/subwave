// "Swap fit" warnings (settings/llm-swap-fit.ts): what the incoming primary
// might trip over for the agentic routes the operator configured.
//
// Pinned here, each a different way a bad fit could slip through:
//   - a fine backup passes clean; a non-agentic route config silences every
//     check because there is nothing to fit;
//   - the Ollama context-window floor only fires for Ollama legs with a
//     nonzero window below 8192;
//   - code-specialised names always warn, small models only when picks is
//     agentic;
//   - thinking-mandatory models reject forced calls; toolChoice "auto" on the
//     leg weakens the agent loop;
//   - the agent deadline compares measured p90 against the station deadline,
//     needing ≥ 5 successful rows from the same model;
//   - null/undefined input degrades to the shipped all-agentic default.
//
// Pure function, no credentials, no external host.
// Run: npm test -- llm-swap-fit

import assert from 'node:assert/strict';
import test from 'node:test';

import { llmSwapFit } from '../src/settings/llm-swap-fit.js';

const llm = (
  fallback: Record<string, unknown>,
  routes: Record<string, string> = {},
): Record<string, unknown> & { fallback?: Record<string, unknown> } => ({
  trackSelection: 'agentic',
  requestMatching: 'agentic',
  segmentRuntime: 'agentic',
  agentTimeoutMs: 45000,
  ...routes,
  provider: 'ollama',
  model: 'qwen3:32b',
  fallback: { enabled: true, ...fallback },
});

const FINE = { provider: 'openai', model: 'gpt-5-mini' };

// --- 1 -------------------------------------------------------------------
test('a fine backup produces no warnings', () => {
  const fit = llmSwapFit(llm(FINE));
  assert.deepEqual(fit.warnings, []);
  assert.equal(fit.agenticRoutes.length, 3);
  assert.deepEqual(fit.target, { provider: 'openai', model: 'gpt-5-mini' });
});

// --- 2 -------------------------------------------------------------------
test('no agentic route silences every check even with a bad backup', () => {
  const fit = llmSwapFit(
    llm({ provider: 'ollama', model: 'qwen2.5-coder:7b', numCtx: 4096 }, {
      trackSelection: 'shortlist',
      requestMatching: 'direct',
      segmentRuntime: 'direct',
    }),
  );
  assert.deepEqual(fit.warnings, []);
  assert.deepEqual(fit.agenticRoutes, []);
});

// --- 3 -------------------------------------------------------------------
test('context-window floor: Ollama < 8192 warns, 8192 / 0 / non-Ollama do not', () => {
  const low = llmSwapFit(llm({ provider: 'ollama', model: 'qwen3:32b', numCtx: 4096 }));
  assert.equal(low.warnings.length, 1);
  assert.equal(low.warnings[0].check, 'context window');
  assert.ok(low.warnings[0].detail.includes('4096'));
  assert.ok(low.warnings[0].detail.includes('8192'));

  assert.equal(
    llmSwapFit(llm({ provider: 'ollama', model: 'qwen3:32b', numCtx: 8192 })).warnings.length, 0,
  );
  assert.equal(
    llmSwapFit(llm({ provider: 'ollama', model: 'qwen3:32b', numCtx: 0 })).warnings.length, 0,
  );
  assert.equal(
    llmSwapFit(llm({ provider: 'openai', model: 'qwen3:32b', numCtx: 4096 })).warnings.length, 0,
  );
});

// --- 4 -------------------------------------------------------------------
test('model class: code name always warns; small model only when picks is agentic', () => {
  const code = llmSwapFit(llm({ provider: 'ollama', model: 'qwen2.5-coder:32b' }));
  const codeW = code.warnings.filter(w => w.check === 'model class');
  assert.equal(codeW.length, 1);
  assert.ok(codeW[0].detail.includes('code-specialised'));

  const small = llmSwapFit(llm({ provider: 'ollama', model: 'gemma3:4b' }));
  const smallW = small.warnings.filter(w => w.check === 'model class');
  assert.equal(smallW.length, 1);
  assert.ok(smallW[0].detail.includes('~4B'));

  const noPicks = llmSwapFit(
    llm({ provider: 'ollama', model: 'gemma3:4b' }, { trackSelection: 'shortlist' }),
  );
  assert.equal(noPicks.warnings.filter(w => w.check === 'model class').length, 0);
});

// --- 5 -------------------------------------------------------------------
test('tool calling: thinking-mandatory rejects forced calls; toolChoice auto weakens', () => {
  const claude = llmSwapFit(llm({ provider: 'anthropic', model: 'claude-sonnet-5-5' }));
  const tc = claude.warnings.filter(w => w.check === 'tool calling');
  assert.equal(tc.length, 1);
  assert.ok(tc[0].detail.includes('rejects forced tool calls'));

  const auto = llmSwapFit(llm({ provider: 'openai', model: 'gpt-5-mini', toolChoice: 'auto' }));
  const tc2 = auto.warnings.filter(w => w.check === 'tool calling');
  assert.equal(tc2.length, 1);
  assert.ok(tc2[0].detail.includes('"auto"'));
});

// --- 6 -------------------------------------------------------------------
test('agent deadline: p90 ≥ 80 % of station deadline warns; guards filter correctly', () => {
  const rows40 = Array.from({ length: 6 }, () => ({ ok: true, ms: 40000, model: 'gpt-5-mini' }));
  const warn = llmSwapFit(llm(FINE), rows40);
  assert.equal(warn.warnings.length, 1);
  assert.equal(warn.warnings[0].check, 'agent deadline');
  assert.ok(warn.warnings[0].detail.includes('45s'));

  const rows10 = Array.from({ length: 6 }, () => ({ ok: true, ms: 10000, model: 'gpt-5-mini' }));
  assert.equal(llmSwapFit(llm(FINE), rows10).warnings.filter(w => w.check === 'agent deadline').length, 0);

  const other = Array.from({ length: 6 }, () => ({ ok: true, ms: 40000, model: 'other-model' }));
  assert.equal(llmSwapFit(llm(FINE), other).warnings.filter(w => w.check === 'agent deadline').length, 0);

  const few = Array.from({ length: 4 }, () => ({ ok: true, ms: 40000, model: 'gpt-5-mini' }));
  assert.equal(llmSwapFit(llm(FINE), few).warnings.filter(w => w.check === 'agent deadline').length, 0);

  const failed = Array.from({ length: 6 }, () => ({ ok: false, ms: 40000, model: 'gpt-5-mini' }));
  assert.equal(llmSwapFit(llm(FINE), failed).warnings.filter(w => w.check === 'agent deadline').length, 0);
});

// --- 7 -------------------------------------------------------------------
test('agenticRoutes list order and names for a single agentic route', () => {
  const fit = llmSwapFit(llm(FINE, { trackSelection: 'shortlist', requestMatching: 'direct' }));
  assert.deepEqual(fit.agenticRoutes, ['Segment runtime (DJ behaviour)']);
});

// --- 8 -------------------------------------------------------------------
test('null and undefined input degrade to the all-agentic shipped default', () => {
  for (const v of [null, undefined]) {
    const fit = llmSwapFit(v);
    assert.equal(fit.agenticRoutes.length, 3);
    assert.deepEqual(fit.target, { provider: '', model: '' });
    assert.deepEqual(fit.warnings, []);
  }
});
