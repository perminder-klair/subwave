// Unit tests for the pure stream-status transition helper in
// broadcast/listeners.ts. Run: `tsx scripts/listeners-status.test.ts` (folded
// into `npm run test`).
//
// statusAfterFailure decides the cached StreamStatus after a status-fetch
// failure. The branching is regression-critical: too eager and a transient
// stats-endpoint timeout flips the station "offline" and tears down a healthy
// listener (issue #461); too lax and a genuinely-down Icecast is pinned
// "online" forever. node:assert-via-tsx style, matching llm-pure.test.ts.

import assert from 'node:assert/strict';
import { statusAfterFailure, type StreamStatus } from '../src/broadcast/listeners.js';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

const LIMIT = 4;
const online: StreamStatus = { online: true, listeners: { current: 3, peak: 5 }, bitrate: 192 };

async function main() {
  console.log('statusAfterFailure (transient vs sustained outage):');

  await test('1st transient failure holds the last known online status', () => {
    const next = statusAfterFailure(online, 1, LIMIT, 5);
    assert.equal(next.online, true);              // not torn offline by one blip
    assert.equal(next.bitrate, 192);              // last known bitrate kept
    assert.equal(next.listeners.current, 3);      // last known count, NOT a flashed 0
    assert.equal(next.listeners.peak, 5);
  });

  await test('failures just below the limit still hold online', () => {
    const next = statusAfterFailure(online, LIMIT - 1, LIMIT, 5);
    assert.equal(next.online, true);
    assert.equal(next.listeners.current, 3);
  });

  await test('at the limit, a sustained outage reports offline', () => {
    const next = statusAfterFailure(online, LIMIT, LIMIT, 5);
    assert.equal(next.online, false);             // genuinely-down Icecast surfaces
    assert.equal(next.bitrate, null);
    assert.equal(next.listeners.current, 0);      // nobody's listening to a dead mount
    assert.equal(next.listeners.peak, 5);         // run's peak preserved
  });

  await test('past the limit stays offline', () => {
    const next = statusAfterFailure(online, LIMIT + 10, LIMIT, 5);
    assert.equal(next.online, false);
    assert.equal(next.listeners.current, 0);
  });

  await test('an already-offline prior status stays offline while transient', () => {
    const offline: StreamStatus = { online: false, listeners: { current: 0, peak: 2 }, bitrate: null };
    const next = statusAfterFailure(offline, 1, LIMIT, 2);
    assert.equal(next.online, false);             // never flips a cold start "online"
    assert.equal(next.listeners.peak, 2);
  });

  await test('peak is carried through (monotonic), not reset, on a transient hold', () => {
    const next = statusAfterFailure(online, 1, LIMIT, 9);
    assert.equal(next.listeners.peak, 9);
  });

  await test('does not mutate the previous status object', () => {
    const prev: StreamStatus = { online: true, listeners: { current: 3, peak: 5 }, bitrate: 192 };
    statusAfterFailure(prev, 1, LIMIT, 7);
    assert.equal(prev.listeners.peak, 5);         // input untouched
    assert.equal(prev.listeners.current, 3);
  });

  console.log(failures === 0 ? '\nAll listeners-status tests passed.' : `\n${failures} test(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main();
