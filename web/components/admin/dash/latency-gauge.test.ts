import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deadlineFallbacks, djLatencyMs, failedCallsNote, latencyZone } from './latency-gauge';

const llm = (over: object) => ({
  count: 120, ok: 117, failed: 3, deadlineHits: 0,
  latency: { p95: 45_000 }, okLatency: { p95: 4_200 }, agentTimeoutMs: 45_000,
  ...over,
});

// The strip as it settles: the needle at the reading, the redline at the deadline.
const settled = (stats: Parameters<typeof djLatencyMs>[0]) => {
  const latencyMs = djLatencyMs(stats);
  return latencyZone({ latencyMs, needleMs: latencyMs ?? 0, redlineMs: 45_000, fallbacks: deadlineFallbacks(stats) });
};

test('the gauge reads successful calls only, so a timed-out call does not pin it to the redline', () => {
  assert.equal(djLatencyMs({ llm: llm({}) }), 4_200);
});

test('a ring with no successful call gives no reading rather than a failure duration', () => {
  assert.equal(djLatencyMs({ llm: llm({ count: 2, ok: 0, failed: 2, okLatency: { p95: 0 } }) }), null);
});

test('an empty ring or no /stats yet gives no reading', () => {
  assert.equal(djLatencyMs(null), null);
  assert.equal(djLatencyMs({ llm: llm({ count: 0, ok: 0, failed: 0 }) }), null);
});

test('an older controller without okLatency keeps its all-calls reading', () => {
  assert.equal(djLatencyMs({ llm: { count: 10, latency: { p95: 9_000 } } }), 9_000);
});

test('shortlist selection keeps reading its own primary picks', () => {
  assert.equal(djLatencyMs({ trackSelection: 'shortlist', shortlist: { count: 5, latency: { p95: 12_000 } }, llm: llm({}) }), 12_000);
  assert.equal(djLatencyMs({ trackSelection: 'shortlist', shortlist: { count: 0 }, llm: llm({}) }), null);
});

test('a DJ hitting its fallbacks still redlines while the needle reads a fast model', () => {
  // The review's scenario: 120 calls, 8 at the 45s deadline, the rest ~4s.
  const stats = { llm: llm({ ok: 112, failed: 8, deadlineHits: 8 }) };
  assert.deepEqual(settled(stats), { zone: 'fallbacks', warn: true });
  assert.equal(djLatencyMs(stats), 4_200, 'the needle still shows the truth about successful calls');
});

test('red fires at the share of deadline hits that used to carry the all-calls p95 there', () => {
  // A full ring: p95 is sorted[114], so it took 6 of 120 at the deadline.
  assert.equal(deadlineFallbacks({ llm: llm({ deadlineHits: 5 }) }), false);
  assert.equal(deadlineFallbacks({ llm: llm({ deadlineHits: 6 }) }), true);
  // A ring of 20 or fewer: one hit was the p95, and still is the share.
  assert.equal(deadlineFallbacks({ llm: llm({ count: 20, deadlineHits: 1 }) }), true);
  assert.equal(deadlineFallbacks({ llm: llm({ count: 21, deadlineHits: 1 }) }), false);
  assert.equal(deadlineFallbacks({ llm: llm({ count: 21, deadlineHits: 2 }) }), true);
});

test('failures that did not run out the deadline do not redline the gauge', () => {
  assert.deepEqual(settled({ llm: llm({ ok: 100, failed: 20, deadlineHits: 0 }) }), { zone: 'nominal', warn: false });
});

test('every call timing out shows fallbacks, not "no data"', () => {
  assert.deepEqual(settled({ llm: llm({ count: 3, ok: 0, failed: 3, deadlineHits: 3, okLatency: { p95: 0 } }) }), {
    zone: 'fallbacks',
    warn: true,
  });
});

test('no fallback signal on Track Shortlist or from an older controller', () => {
  assert.equal(deadlineFallbacks({ trackSelection: 'shortlist', shortlist: { count: 5 }, llm: llm({ deadlineHits: 60 }) }), false);
  assert.equal(deadlineFallbacks({ llm: { count: 10, failed: 5, latency: { p95: 45_000 } } }), false);
  assert.equal(deadlineFallbacks(null), false);
});

test('the needle alone still drives redline, rising, nominal and no data', () => {
  const zone = (latencyMs: number | null) =>
    latencyZone({ latencyMs, needleMs: latencyMs ?? 0, redlineMs: 30_000, fallbacks: false });
  assert.deepEqual(zone(30_000), { zone: 'redline', warn: true });
  assert.deepEqual(zone(24_001), { zone: 'rising', warn: false });
  assert.deepEqual(zone(24_000), { zone: 'nominal', warn: false });
  assert.deepEqual(zone(null), { zone: 'no data', warn: false });
});

test('the failed note shows failed / total while the ring holds a failure', () => {
  const note = failedCallsNote({ llm: llm({ ok: 112, failed: 8, deadlineHits: 6 }) });
  assert.equal(note?.failed, 8);
  assert.equal(note?.total, 120);
  assert.match(note!.title, /6 at the agent deadline/);
  assert.match(note!.title, /successful calls only/);
});

test('on Track Shortlist the note says it counts all LLM calls, not picks', () => {
  const note = failedCallsNote({ trackSelection: 'shortlist', shortlist: { count: 5 }, llm: llm({}) });
  assert.match(note!.title, /all LLM calls/);
  assert.match(note!.title, /Track Shortlist primary picks/);
  assert.doesNotMatch(note!.title, /agent deadline/);
});

test('the failed note disappears once every failure has left the ring', () => {
  assert.equal(failedCallsNote({ llm: llm({ ok: 120, failed: 0 }) }), null);
  assert.equal(failedCallsNote(null), null);
});

test('an older controller shows no note: its needle still reads every call', () => {
  // `ok` and `failed` predate okLatency, so a real older controller sends them.
  assert.equal(failedCallsNote({ llm: { count: 10, ok: 8, failed: 2, latency: { p95: 9_000 } } }), null);
});
