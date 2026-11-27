// When the Library page re-reads its counts on its own (coverage-poll.ts).
//
// Run: npm test -- coverage-poll

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLOCK_SETTLE_MAX_READS, COLD_START_MAX_READS, COVERAGE_POLL_MS, blockSettle, coveragePollMs, noteBlockWrite } from './coverage-poll';

const ready = { scanning: false, overview: { library: 72_936 } };

test('idle with figures: never polls (#1570)', () => {
  assert.equal(coveragePollMs({ taggerRunning: false, data: ready, reads: 5 }), false);
});

test('a run or an operator count polls', () => {
  assert.equal(coveragePollMs({ taggerRunning: true, data: ready, reads: 5 }), COVERAGE_POLL_MS);
  assert.equal(coveragePollMs({ taggerRunning: false, data: { ...ready, scanning: true }, reads: 5 }), COVERAGE_POLL_MS);
});

test('a controller just restarted (no snapshot yet) is asked again until the figures land', () => {
  const cold = { scanning: false, overview: null };
  assert.equal(coveragePollMs({ taggerRunning: false, data: cold, reads: 1 }), COVERAGE_POLL_MS);
  assert.equal(coveragePollMs({ taggerRunning: false, data: { scanning: false }, reads: 1 }), false,
    'an older controller never sends the field: nothing is coming, so nothing polls');
  assert.equal(coveragePollMs({ taggerRunning: false, data: cold, reads: COLD_START_MAX_READS }), false,
    'bounded: a library that cannot be read stops asking');
});

test('no answer yet is the query\'s own retry, not a poll', () => {
  assert.equal(coveragePollMs({ taggerRunning: false, data: null, reads: 0 }), false);
});

test('after a never-play write, asks again until a snapshot counted after it lands', () => {
  const writeAt = Date.parse('2026-10-31T02:00:10.000Z');
  const before = '2026-10-31T02:00:00.000Z';
  const settle = { writeAt, baseline: before, reads: 1 };
  const at = (computedAt: string) => ({ scanning: false, overview: { library: 9, computedAt } });
  // The controller answers the first read with the snapshot from before the write.
  assert.equal(coveragePollMs({ taggerRunning: false, data: at(before), reads: 6, settle }), COVERAGE_POLL_MS);
  assert.equal(coveragePollMs({ taggerRunning: false, data: at('2026-10-31T02:00:13.000Z'), reads: 7, settle: { ...settle, reads: 2 } }), false,
    'the recount landed: idle again');
  assert.equal(coveragePollMs({ taggerRunning: false, data: at(before), reads: 9, settle: { ...settle, reads: BLOCK_SETTLE_MAX_READS } }), false,
    'bounded: a server clock behind the browser\'s costs a few reads, not a poll');
});

test('a server clock ahead of the browser\'s cannot end the settle on the old snapshot', () => {
  const ahead = '2026-10-31T02:05:00.000Z';
  const settle = { writeAt: Date.parse('2026-10-31T02:00:10.000Z'), baseline: ahead, reads: 1 };
  assert.equal(coveragePollMs({ taggerRunning: false, data: { overview: { computedAt: ahead } }, reads: 3, settle }), COVERAGE_POLL_MS);
  assert.equal(coveragePollMs({ taggerRunning: false, data: { overview: { computedAt: '2026-10-31T02:05:04.000Z' } }, reads: 4, settle }), false);
});

test('the settle counts reads since the write, and leaves an older controller alone', () => {
  noteBlockWrite({ writeAt: 1, baseline: null, fromReads: 4 });
  assert.deepEqual(blockSettle(6), { writeAt: 1, baseline: null, reads: 2 });
  assert.equal(blockSettle(0)?.reads, 0, 'a query recreated since the write counts from zero');
  assert.equal(coveragePollMs({ taggerRunning: false, data: { scanning: false }, reads: 5, settle: blockSettle(5) }), false,
    'no overview in the answer: nothing to wait for');
});
