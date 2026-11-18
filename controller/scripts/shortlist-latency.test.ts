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

test('LLM okLatency counts successful calls only; latency stays all-calls for the Stats page', async () => {
  const { summarizeLlm } = await import('../src/stats.js');
  const calls = [
    ...Array.from({ length: 19 }, (_, i) => ({ ok: true, ms: 1_000 + i * 100 })),
    { ok: false, ms: 45_000 },
  ];
  const s = summarizeLlm(calls);
  assert.equal(s.failed, 1);
  assert.equal(s.count, 20);
  assert.equal(s.latency.max, 45_000, 'all-calls figure unchanged');
  assert.equal(s.okLatency.max, 2_800);
  assert.equal(s.okLatency.p95, 2_800);
  const none = summarizeLlm([{ ok: false, ms: 45_000 }]);
  assert.deepEqual(none.okLatency, { avg: 0, p50: 0, p95: 0, max: 0 });
});
