import assert from 'node:assert/strict';
import test from 'node:test';
import { agenticPickerContextWindow, contextWindowByKind, shortlistContextWindow, ContextMeasurements } from '../src/llm/internal/telemetry/context-window.js';

test('suggests a server context window from the peak successful shortlist picker prompt', () => {
  const result = shortlistContextWindow([
    { kind: 'djShortlistPick', ok: true, usage: { input: 11_989, output: 180 } },
    { kind: 'djShortlistPick', ok: true, usage: { input: 6_420, output: 170 } },
    { kind: 'djShortlistRepick', ok: true, usage: { input: 1_900, output: 120 } },
  ]);

  assert.deepEqual(result, {
    samples: 3,
    peakInputTokens: 11_989,
    pickerPeakInputTokens: 11_989,
    peakKind: 'djShortlistPick',
    suggestedTokens: 16_384,
    headroomPct: 25,
    responseReserveTokens: 1_024,
    message: 'Based on the largest successful prompt since this controller started, across the shortlist picker and every other LLM function that shares this context window.',
  });
});

test('reports average prompt context by LLM function without inventing missing usage', () => {
  const rows = contextWindowByKind([
    { kind: 'djAgentPick', ok: true, usage: { input: 4_000 } },
    { kind: 'djAgentPick', ok: true, usage: { input: 6_000 } },
    { kind: 'djAgentPick', ok: false, usage: { input: 99_999 } },
    { kind: 'djSegment', ok: true, usage: {} },
  ]);
  assert.deepEqual(rows, [
    { kind: 'djAgentPick', calls: 3, samples: 2, averageInputTokens: 5_000, peakInputTokens: 6_000 },
    { kind: 'djSegment', calls: 1, samples: 0, averageInputTokens: null, peakInputTokens: null },
  ]);
});

test('uses the largest Agentic Picker model step rather than its tool-loop total', () => {
  const calls = [
    { kind: 'djAgentPick', ok: true, usage: { input: 15_000 }, contextPeakInput: 7_000 },
    { kind: 'djAgentPick', ok: true, usage: { input: 19_000 }, contextPeakInput: 12_000 },
    { kind: 'djAgentPick', ok: true, via: 'ai-sdk:agent', usage: { input: 99_999 } },
  ];
  assert.equal(contextWindowByKind(calls)[0].averageInputTokens, 9_500);
  assert.equal(contextWindowByKind(calls)[0].samples, 2, 'old tool-loop totals are not a context-window sample');
  assert.deepEqual(agenticPickerContextWindow(calls), {
    samples: 2,
    peakInputTokens: 12_000,
    pickerPeakInputTokens: 12_000,
    peakKind: 'djAgentPick',
    suggestedTokens: 16_384,
    headroomPct: 25,
    responseReserveTokens: 1_024,
    message: 'Based on the largest successful prompt since this controller started, across Agentic Picker steps and every other LLM function that shares this context window.',
  });
});

test('context measurements keep peaks and averages after the debug ring would rotate', () => {
  const measurements = new ContextMeasurements();
  measurements.record({ kind: 'djShortlistPick', ok: true, usage: { input: 30_000 } });
  for (let i = 0; i < 120; i++) measurements.record({ kind: 'djLink', ok: true, usage: { input: 1000 } });
  assert.equal(measurements.snapshot().shortlist.suggestedTokens, 38_912);
  measurements.record({ kind: 'djShortlistPick', ok: true, usage: { input: 1000 } });
  const snapshot = measurements.snapshot();
  assert.equal(snapshot.shortlist.peakInputTokens, 30_000);
  assert.equal(snapshot.shortlist.samples, 2);
  assert.equal(snapshot.byKind.find(row => row.kind === 'djShortlistPick')?.averageInputTokens, 15_500);
  assert.equal(new ContextMeasurements().snapshot().shortlist.samples, 0);
});

test('one num_ctx serves every call, so a larger shared prompt sets the recommendation', () => {
  const calls = [
    { kind: 'djShortlistPick', ok: true, usage: { input: 5_000 } },
    { kind: 'djAgentPick', ok: true, contextPeakInput: 40_000 },
    { kind: 'djSegment', ok: true, usage: { input: 20_000 } },
  ];
  const shortlist = shortlistContextWindow(calls);
  assert.equal(shortlist.pickerPeakInputTokens, 5_000);
  assert.equal(shortlist.peakInputTokens, 20_000, 'a segment prompt the shortlist window must also hold');
  assert.equal(shortlist.peakKind, 'djSegment');
  assert.equal(shortlist.suggestedTokens, 26_624);
  // The other route's picker never sizes this route's window.
  assert.equal(agenticPickerContextWindow(calls).peakInputTokens, 40_000);
  assert.equal(agenticPickerContextWindow(calls).peakKind, 'djAgentPick');
  assert.equal(shortlistContextWindow([{ kind: 'djSegment', ok: true, usage: { input: 20_000 } }]).suggestedTokens, null,
    'no recommendation for a route that has not run yet');
});
