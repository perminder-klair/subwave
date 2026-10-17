import assert from 'node:assert/strict';
import { test } from 'node:test';
import { djLatencyMs, failedCallsNote } from './latency-gauge';

const llm = (over: object) => ({
  count: 120, ok: 117, failed: 3,
  latency: { p95: 45_000 }, okLatency: { p95: 4_200 }, agentTimeoutMs: 45_000,
  ...over,
});

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

test('the failed note shows failed / total while the ring holds a failure', () => {
  assert.deepEqual(failedCallsNote({ llm: llm({}) }), { failed: 3, total: 120 });
});

test('the failed note disappears once every failure has left the ring', () => {
  assert.equal(failedCallsNote({ llm: llm({ ok: 120, failed: 0 }) }), null);
  assert.equal(failedCallsNote(null), null);
  assert.equal(failedCallsNote({ llm: { count: 4 } }), null, 'an older controller without the field shows nothing');
});
