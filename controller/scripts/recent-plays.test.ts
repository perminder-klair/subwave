// Regression test for the count-based no-repeat guard's data source —
// queue.recentlyPlayedByCount(n) — and the events-backfill dedup that keeps the
// recent-plays sidecar from double-counting every play (live-repeats fix).
// Run: `tsx scripts/recent-plays.test.ts`.
//
// node:assert-via-tsx style, matching scripts/picker-recency-regression.ts and
// scripts/request-dedup.test.ts.

import assert from 'node:assert/strict';
import { queue } from '../src/broadcast/queue.js';

// recentlyPlayedByCount reads queue.current + queue._recentPlays only; no disk
// or Liquidsoap side effects, so no neutralising needed beyond a clean slate.
function setPlays(plays: any[]) {
  (queue as any).current = null;
  (queue as any)._recentPlays = plays;
}

// ── distinct counting ───────────────────────────────────────────────────────

// The sidecar holds TWO rows for one play after a restart: recordPlay logs it
// with an id (track-end), the events backfill logs an id-less copy (track-start)
// of the SAME song. recentlyPlayedByCount must collapse them so `n` means n
// distinct songs, not n rows. Here three rows describe TWO songs; n=2 must
// reach the second song (B) — proving the id-less duplicate of A did not burn a
// slot. If it counted rows, n=2 would stop at row 2 and B would be missing.
setPlays([
  { id: 'A', title: 'Song One', artist: 'Artist R', endedAt: '2026-06-26T18:00:00.000Z' },
  { id: null, title: 'Song One', artist: 'Artist R', endedAt: '2026-06-26T17:58:00.000Z' },
  { id: 'B', title: 'Song Two', artist: 'Artist S', endedAt: '2026-06-26T17:55:00.000Z' },
]);
const twoDistinct = queue.recentlyPlayedByCount(2);
assert(twoDistinct.ids.has('A'), 'first distinct track id present');
assert(twoDistinct.ids.has('B'), 'duplicate row must not consume a slot — second song must be reached');
assert(twoDistinct.keys.has('song one|artist r'), 'title|artist key recorded for blocking id-less candidates');
assert(twoDistinct.keys.has('song two|artist s'), 'second song key recorded');

// n=1 stops at the first distinct song; the duplicate and the later song are
// out of the window.
const oneDistinct = queue.recentlyPlayedByCount(1);
assert(oneDistinct.ids.has('A'), 'n=1 includes the most recent song');
assert(!oneDistinct.ids.has('B'), 'n=1 must not reach the second distinct song');

// n <= 0 disables the guard — empty sets.
assert.equal(queue.recentlyPlayedByCount(0).ids.size, 0, 'n=0 → no ids');
assert.equal(queue.recentlyPlayedByCount(0).keys.size, 0, 'n=0 → no keys');
assert.equal(queue.recentlyPlayedByCount(-5).ids.size, 0, 'negative n → no ids');

// The current (on-air) track is added on top of the N so a mid-song pick can't
// re-pick it, regardless of whether it's already in the sidecar.
setPlays([{ id: 'B', title: 'Song Two', artist: 'Artist S', endedAt: '2026-06-26T17:55:00.000Z' }]);
(queue as any).current = { track: { id: 'CUR', title: 'On Air', artist: 'Live' } };
const withCurrent = queue.recentlyPlayedByCount(1);
assert(withCurrent.ids.has('CUR'), 'current track id is always blocked');
assert(withCurrent.keys.has('on air|live'), 'current track key is always blocked');
assert(withCurrent.ids.has('B'), 'the N sidecar tracks are still blocked alongside current');

console.log('recent-plays count + dedup checks passed');
