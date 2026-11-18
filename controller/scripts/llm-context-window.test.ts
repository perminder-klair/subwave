import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextMeasurements } from '../src/llm/internal/telemetry/context-window.js';

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
