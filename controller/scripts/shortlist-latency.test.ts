import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeShortlistPicks } from '../src/stats.js';

test('shortlist warning stays conservative while its primary-pick sample warms up', () => {
  const summary = summarizeShortlistPicks([{ ms: 90_000, primary: true }, { ms: 500, primary: false }]);
  assert.equal(summary.count, 1);
  assert.equal(summary.warmingUp, true);
  assert.equal(summary.warningMs, 30_000);
});

test('shortlist warning follows p95 with headroom after five primary picks', () => {
  const summary = summarizeShortlistPicks([10_000, 12_000, 15_000, 17_000, 20_000].map(ms => ({ ms, primary: true })));
  assert.equal(summary.warmingUp, false);
  assert.equal(summary.latency.p95, 20_000);
  assert.equal(summary.warningMs, 30_000);
});
