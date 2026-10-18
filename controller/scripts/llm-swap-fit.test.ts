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
//   - it makes no judgement DJ Doc does not: a thinking-mandatory model or a
//     leg on toolChoice "auto" raises nothing here, as it raises nothing there;
//   - the agent deadline compares measured p90 against the station deadline,
//     needing ≥ 5 successful rows carrying the backup's EXACT leg label — a
//     prefix model's rows are not its rows, and when both legs share one label
//     no row can be attributed, so the check stays silent;
//   - a blank-model Ollama backup is judged by its resolved label;
//   - null/undefined input degrades to the shipped all-agentic default.
//
// Pure function, no credentials, no external host.
// Run: npm test -- llm-swap-fit

import assert from 'node:assert/strict';
import test from 'node:test';

import { llmSwapFit, type SwapFitLabels } from '../src/settings/llm-swap-fit.js';

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
test('no tool-calling judgement: DJ Doc makes none of the primary either', () => {
  const claude = llmSwapFit(llm({ provider: 'anthropic', model: 'claude-sonnet-5-5' }));
  assert.deepEqual(claude.warnings, []);
  const auto = llmSwapFit(llm({ provider: 'openai', model: 'gpt-5-mini', toolChoice: 'auto' }));
  assert.deepEqual(auto.warnings, []);
});

// --- 6 -------------------------------------------------------------------
const LABELS = { backup: 'openai:gpt-5-mini', primary: 'ollama:qwen3:32b' };
const rows = (n: number, ms: number, model: string, ok = true) =>
  Array.from({ length: n }, () => ({ ok, ms, model }));

test('agent deadline: p90 ≥ 80 % of station deadline warns; guards filter correctly', () => {
  const warn = llmSwapFit(llm(FINE), rows(6, 40000, 'openai:gpt-5-mini'), LABELS);
  assert.equal(warn.warnings.length, 1);
  assert.equal(warn.warnings[0].check, 'agent deadline');
  assert.ok(warn.warnings[0].detail.includes('45s'));

  const deadline = (calls: ReturnType<typeof rows>, labels: SwapFitLabels = LABELS) =>
    llmSwapFit(llm(FINE), calls, labels).warnings.filter(w => w.check === 'agent deadline').length;
  assert.equal(deadline(rows(6, 10000, 'openai:gpt-5-mini')), 0, 'fast enough');
  assert.equal(deadline(rows(6, 40000, 'ollama:qwen3:32b')), 0, "the primary's rows");
  assert.equal(deadline(rows(4, 40000, 'openai:gpt-5-mini')), 0, 'too few rows');
  assert.equal(deadline(rows(6, 40000, 'openai:gpt-5-mini', false)), 0, 'failed rows');
  assert.equal(deadline(rows(6, 40000, 'openai:gpt-5-mini'), {}), 0, 'no label to match');
});

test("agent deadline: a prefix model's rows are not the backup's", () => {
  // Backup gpt-5, primary gpt-5-mini: a substring match counted the primary's.
  const fit = llmSwapFit(
    llm({ provider: 'openai', model: 'gpt-5' }),
    rows(6, 40000, 'openai:gpt-5-mini'),
    { backup: 'openai:gpt-5', primary: 'openai:gpt-5-mini' },
  );
  assert.equal(fit.warnings.filter(w => w.check === 'agent deadline').length, 0);
});

test('agent deadline: both legs on one label (same model, two hosts) stays silent', () => {
  // The busy primary host's slow calls carry the same label as the backup's.
  const same = 'ollama:qwen3:32b';
  const fit = llmSwapFit(
    llm({ provider: 'ollama', model: 'qwen3:32b', ollamaUrl: 'http://spare:11434' }),
    rows(6, 40000, same),
    { backup: same, primary: same },
  );
  assert.equal(fit.warnings.filter(w => w.check === 'agent deadline').length, 0);
});

test('a blank-model Ollama backup is judged by its resolved label', () => {
  const labels = { backup: 'ollama:qwen2.5-coder:7b', primary: 'openai:gpt-5-mini' };
  const fit = llmSwapFit(llm({ provider: 'ollama', model: '' }), rows(6, 40000, labels.backup), labels);
  const checks = fit.warnings.map(w => w.check).sort();
  assert.deepEqual(checks, ['agent deadline', 'model class']);
  assert.ok(fit.warnings.find(w => w.check === 'model class')!.detail.startsWith('qwen2.5-coder:7b '));
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
