// When the Library page re-reads its counts on its own (coverage-poll.ts).
//
// Run: npm test -- coverage-poll

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COLD_START_MAX_READS, COVERAGE_POLL_MS, coveragePollMs } from './coverage-poll';

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
  assert.equal(coveragePollMs({ taggerRunning: false, data: { scanning: false }, reads: 1 }), COVERAGE_POLL_MS,
    'an older controller that omits the field reads the same');
  assert.equal(coveragePollMs({ taggerRunning: false, data: cold, reads: COLD_START_MAX_READS }), false,
    'bounded: a library that cannot be read stops asking');
});

test('no answer yet is the query\'s own retry, not a poll', () => {
  assert.equal(coveragePollMs({ taggerRunning: false, data: null, reads: 0 }), false);
});
