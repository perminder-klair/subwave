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
import {
  combineCounts,
  combineGatedCounts,
  gatedCount,
  singleFlight,
  statusAfterFailure,
  type IcecastStatus,
} from '../src/broadcast/listeners.js';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

const LIMIT = 4;
const online: IcecastStatus = {
  online: true,
  listeners: { current: 3, peak: 5 },
  bitrate: 192,
  sampleRate: 44100,
  channels: 2,
};

async function main() {
  console.log('statusAfterFailure (transient vs sustained outage):');

  await test('1st transient failure holds the last known online status', () => {
    const next = statusAfterFailure(online, 1, LIMIT, 5);
    assert.equal(next.online, true);              // not torn offline by one blip
    assert.equal(next.bitrate, 192);              // last known bitrate kept
    assert.equal(next.sampleRate, 44100);         // last known stream shape kept
    assert.equal(next.channels, 2);
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
    assert.equal(next.sampleRate, null);          // stream shape cleared with the mount
    assert.equal(next.channels, null);
    assert.equal(next.listeners.current, 0);      // nobody's listening to a dead mount
    assert.equal(next.listeners.peak, 5);         // run's peak preserved
  });

  await test('past the limit stays offline', () => {
    const next = statusAfterFailure(online, LIMIT + 10, LIMIT, 5);
    assert.equal(next.online, false);
    assert.equal(next.listeners.current, 0);
  });

  await test('an already-offline prior status stays offline while transient', () => {
    const offline: IcecastStatus = { online: false, listeners: { current: 0, peak: 2 }, bitrate: null, sampleRate: null, channels: null };
    const next = statusAfterFailure(offline, 1, LIMIT, 2);
    assert.equal(next.online, false);             // never flips a cold start "online"
    assert.equal(next.listeners.peak, 2);
  });

  await test('peak is carried through (monotonic), not reset, on a transient hold', () => {
    const next = statusAfterFailure(online, 1, LIMIT, 9);
    assert.equal(next.listeners.peak, 9);
  });

  await test('does not mutate the previous status object', () => {
    const prev: IcecastStatus = { online: true, listeners: { current: 3, peak: 5 }, bitrate: 192, sampleRate: 44100, channels: 2 };
    statusAfterFailure(prev, 1, LIMIT, 7);
    assert.equal(prev.listeners.peak, 5);         // input untouched
    assert.equal(prev.listeners.current, 3);
  });

  // gatedCount — the same transient-vs-sustained doctrine applied to the number
  // the fail-open gates (djCallsAllowed, the idle monitor) act on. Issue #1256:
  // on the raw count a single 1.5s fetch timeout read as "unknown", both gates
  // fail open on unknown, and the idle pause released ~28s after engaging.
  console.log('\ngatedCount (blip vs outage, for the fail-open gates):');

  await test('a successful poll always wins, whatever came before', () => {
    assert.equal(gatedCount(2, 0, 0, LIMIT), 2);
    assert.equal(gatedCount(0, 7, 0, LIMIT), 0);   // a real 0 is an observation, not a hold
  });

  await test('one failed poll holds the last real reading (the #1256 regression)', () => {
    // The room was empty; one poll times out. Before the fix this read null,
    // the idle monitor failed open, and the pause released.
    assert.equal(gatedCount(null, 0, 1, LIMIT), 0);
  });

  await test('a blip while occupied holds the occupancy too', () => {
    assert.equal(gatedCount(null, 3, 1, LIMIT), 3);
  });

  await test('failures just below the limit still hold', () => {
    assert.equal(gatedCount(null, 0, LIMIT - 1, LIMIT), 0);
  });

  await test('at the limit a sustained outage reports unknown (fails open)', () => {
    assert.equal(gatedCount(null, 0, LIMIT, LIMIT), null);
    assert.equal(gatedCount(null, 3, LIMIT + 9, LIMIT), null);
  });

  await test('never polled reads unknown, not a fabricated 0', () => {
    assert.equal(gatedCount(null, null, 0, LIMIT), null);
    assert.equal(gatedCount(null, null, 2, LIMIT), null);
  });

  await test('recovery drops the hold immediately', () => {
    // Failure #3 holds 0; the next poll succeeds with 1 and that is what shows.
    assert.equal(gatedCount(null, 0, 3, LIMIT), 0);
    assert.equal(gatedCount(1, 0, 0, LIMIT), 1);
  });

  // combineCounts — the ONE place the Icecast and HLS legs meet. The null
  // handling is the whole point: unknown must not become 0, because the
  // fail-open gates read 0 as an empty room and would take the DJ off the air
  // during a stats outage; and a measured 0 must not become unknown, or the
  // fail-CLOSED scrobble gate would start submitting to an empty room.
  console.log('\ncombineCounts (Icecast sockets + HLS playlist polls):');

  await test('both legs add up', () => {
    assert.equal(combineCounts(2, 3), 5);
    assert.equal(combineCounts(0, 0), 0);
  });

  await test('an HLS-only audience is an audience (the Last.fm regression)', () => {
    // Nobody on the mp3 mount, two people on HLS. This used to read 0 and the
    // scrobble gate skipped every submission.
    assert.equal(combineCounts(0, 2), 2);
  });

  await test('one unknown leg lets the other stand alone', () => {
    assert.equal(combineCounts(null, 2), 2);   // Icecast blip, HLS still measured
    assert.equal(combineCounts(3, null), 3);   // HLS on but no access log to read
    assert.equal(combineCounts(null, 0), 0);
  });

  await test('two unknowns stay unknown, never a fabricated 0', () => {
    assert.equal(combineCounts(null, null), null);
  });

  await test('no HLS leg (switched off) leaves the Icecast figure exactly as it was', () => {
    // The byte-identical promise for every station that never turns HLS on:
    // a failed Icecast poll must stay UNKNOWN (a sparkline gap), not become 0.
    assert.equal(combineCounts(null, undefined), null);
    assert.equal(combineCounts(0, undefined), 0);
    assert.equal(combineCounts(4, undefined), 4);
  });

  // combineGatedCounts — the SAME two legs, the opposite failure direction, and
  // deliberately not the same function. Unifying them is the bug: the presence
  // check may treat an unreadable leg as nothing (a skipped scrobble), the DJ
  // gate may not (silence on a stats outage).
  console.log('\ncombineGatedCounts (fail-open: any unreadable leg is unknown):');

  await test('both legs readable adds up, same as the presence path', () => {
    assert.equal(combineGatedCounts(2, 3), 5);
    assert.equal(combineGatedCounts(0, 0), 0);   // measured empty on BOTH legs
    assert.equal(combineGatedCounts(0, 2), 2);
  });

  await test('one unreadable leg makes the whole figure unknown', () => {
    // A sustained Icecast outage with HLS measuring nobody is NOT an empty
    // room: the listeners it would have counted are the ones nobody can see.
    assert.equal(combineGatedCounts(null, 0), null);
    assert.equal(combineGatedCounts(0, null), null);
    assert.equal(combineGatedCounts(null, 3), null);
    assert.equal(combineGatedCounts(null, null), null);
  });

  await test('no HLS leg passes the gated Icecast figure straight through', () => {
    assert.equal(combineGatedCounts(null, undefined), null);
    assert.equal(combineGatedCounts(0, undefined), 0);
    assert.equal(combineGatedCounts(2, undefined), 2);
  });

  // singleFlight — the guard that keeps the 15s monitor, the idle monitor's 5s
  // refresh, and POST /request's on-demand refresh from running overlapping
  // polls. The race it exists to close: the failure path commits ~1.5s after
  // the success path (its fetch timeout), so a slow doomed poll could
  // overwrite the state a younger successful poll just wrote.
  console.log('\nsingleFlight (overlapping polls coalesce):');

  await test('concurrent callers join one in-flight run', async () => {
    let runs = 0;
    let release!: (n: number) => void;
    const poll = singleFlight(() => {
      runs++;
      return new Promise<number>((res) => { release = res; });
    });
    const a = poll();
    const b = poll();       // second caller while the first is still in flight
    release(7);
    assert.equal(await a, 7);
    assert.equal(await b, 7);
    assert.equal(runs, 1);  // one fetch served both — no overlapping commit
  });

  await test('a settled run re-arms: the next call polls afresh', async () => {
    let runs = 0;
    const poll = singleFlight(() => Promise.resolve(++runs));
    assert.equal(await poll(), 1);
    assert.equal(await poll(), 2);  // not pinned to the first result
  });

  await test('a failed run re-arms too — one rejection cannot wedge polling', async () => {
    let runs = 0;
    const poll = singleFlight(() =>
      ++runs === 1 ? Promise.reject(new Error('timeout')) : Promise.resolve(9)
    );
    const first = poll();
    const joined = poll();  // joiner sees the same rejection, not a hang
    await assert.rejects(first, /timeout/);
    await assert.rejects(joined, /timeout/);
    assert.equal(await poll(), 9);
    assert.equal(runs, 2);
  });

  console.log(failures === 0 ? '\nAll listeners-status tests passed.' : `\n${failures} test(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main();
