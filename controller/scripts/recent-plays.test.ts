// Regression test for the count-based no-repeat guard's data source —
// queue.recentlyPlayedByCount(n) — and the events-backfill dedup that keeps the
// recent-plays sidecar from double-counting every play (live-repeats fix).
// Run: `tsx scripts/recent-plays.test.ts`.
//
// node:assert-via-tsx style, matching scripts/picker-recency-regression.ts and
// scripts/request-dedup.test.ts.

import assert from 'node:assert/strict';
import { queue, playAlreadyRecorded } from '../src/broadcast/queue.js';

const GAP = 15 * 60_000; // BACKFILL_DEDUP_MAX_GAP_MS

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

// ── events-backfill dedup (playAlreadyRecorded) ─────────────────────────────

// A recordPlay entry stamps endedAt at the track's END — ~2.5 min after the
// event's start `t` for a normal track. The same play must be recognised as
// already recorded (the old exact-timestamp key missed this and double-counted
// every play).
const start = '2026-06-26T18:00:00.000Z';
const startMs = new Date(start).getTime();
const endStamp = new Date(startMs + 2.5 * 60_000).toISOString();
assert.equal(
  playAlreadyRecorded(
    [{ id: 'A', title: 'Song One', artist: 'Artist R', endedAt: endStamp } as any],
    { title: 'Song One', artist: 'Artist R', t: start },
    GAP,
  ),
  true,
  'recordPlay end-stamp within a track length of the event start must dedup',
);

// A genuine replay 20 min later is NOT the same play — the first play's
// end-stamp falls outside the replay's [t, t+gap] window, so the replay keeps
// its own entry.
const replay = new Date(startMs + 20 * 60_000).toISOString();
assert.equal(
  playAlreadyRecorded(
    [{ id: 'A', title: 'Song One', artist: 'Artist R', endedAt: endStamp } as any],
    { title: 'Song One', artist: 'Artist R', t: replay },
    GAP,
  ),
  false,
  'a later replay spaced beyond a track length must not be merged away',
);

// Different track → never a match.
assert.equal(
  playAlreadyRecorded(
    [{ id: 'A', title: 'Song One', artist: 'Artist R', endedAt: endStamp } as any],
    { title: 'Song Two', artist: 'Artist S', t: start },
    GAP,
  ),
  false,
  'a different title|artist must not dedup',
);

// Idempotent across restarts: a prior backfill wrote an id-less copy stamped at
// the start `t`; re-running must recognise it (at == t, gap 0) and not add a
// third copy.
assert.equal(
  playAlreadyRecorded(
    [{ id: null, title: 'Song One', artist: 'Artist R', endedAt: start } as any],
    { title: 'Song One', artist: 'Artist R', t: start },
    GAP,
  ),
  true,
  'backfill must be idempotent — an existing start-stamped copy dedups on re-run',
);

console.log('recent-plays count + dedup checks passed');
