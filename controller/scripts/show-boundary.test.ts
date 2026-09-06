// Pins the show-boundary fade (#1574) — the policy that stops a 20-30 minute
// track from spilling into the next show.
//
// Five properties are load-bearing, and each is a real way this regresses:
//
//  - OFF is the default, at BOTH levels. A settings.json written before the key
//    existed must sound byte-identical, and a show that never expressed an
//    opinion must inherit rather than read as an explicit "no" — which is what
//    a plain boolean field would have made it.
//  - The scan walks the STATION clock. Schedule slots fire at the hours the
//    operator painted them in (#353), and zones at :30/:45 mean "plus one hour"
//    is not reliably the next hour there.
//  - The cut is an ABSOLUTE offset, so a head-trimmed track's cue_out is
//    measured from byte zero — the same shape liq_cue_out already carries.
//  - The tolerance and the minimum-play floor both matter, in opposite
//    directions: a small overrun is not worth an early ending, and a boundary
//    that lands seconds into a track would leave a stub.
//  - A takeover's start/expiry are boundaries too, and they are not
//    hour-aligned, so the grid scan alone cannot see them.
//
// STATE_DIR is redirected at a throwaway dir BEFORE the first import so
// settings.load()/update() touch nothing real — same shape as
// scripts/clock-policy.test.ts.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-showboundary-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const {
  stationHourBoundaries,
  nextShowChangeMs,
  resolveBoundaryCueSec,
  nextShowBoundaryMs,
  fadeAtShowEndActive,
  BOUNDARY_TOLERANCE_SEC,
  BOUNDARY_MIN_PLAY_SEC,
} = await import('../src/broadcast/show-boundary.js');

const HOUR = 3_600_000;
const MIN = 60_000;
// 2026-01-15 09:00:00 UTC, a Thursday — well clear of any DST step in the zones
// used below, so the assertions measure the scan and not a transition.
const T0 = Date.UTC(2026, 0, 15, 9, 0, 0);

// A `minuteAt` for a zone at a whole-minute offset from UTC, which is all the
// scan ever needs to know about a zone.
const minuteAtOffset = (offsetMin: number) => (ms: number) =>
  ((Math.floor(ms / MIN) + offsetMin) % 60 + 60) % 60;

// ── the station-clock scan ───────────────────────────────────────────────────

test('hour boundaries are listed on the station clock, not the process clock', () => {
  const utc = stationHourBoundaries(T0, T0 + 3 * HOUR, minuteAtOffset(0));
  assert.deepEqual(utc, [T0 + HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR],
    'whole-hour zone: the next three hour marks');

  // India (UTC+5:30): the station's hour lands 30 minutes off the UTC hour, and
  // a scan that added 3 600 000 ms to "now" would report the wrong instants.
  const ist = stationHourBoundaries(T0, T0 + 2 * HOUR, minuteAtOffset(330));
  assert.deepEqual(ist, [T0 + 30 * MIN, T0 + 90 * MIN],
    'a :30 zone puts the boundary on the half hour of the UTC clock');

  // The window is half-open at the bottom and closed at the top: a boundary
  // exactly at `from` has already passed, one exactly at `to` still counts.
  assert.deepEqual(stationHourBoundaries(T0, T0 + HOUR, minuteAtOffset(0)), [T0 + HOUR],
    'a boundary exactly at the horizon is included');
  assert.deepEqual(stationHourBoundaries(T0, T0, minuteAtOffset(0)), [],
    'an empty window lists nothing');
  assert.deepEqual(stationHourBoundaries(T0, T0 - HOUR, minuteAtOffset(0)), [],
    'an inverted window lists nothing');
});

test('the first candidate that changes the show is the boundary', () => {
  const minuteAt = minuteAtOffset(0);
  // Grid: this hour is "a", the next two are "b".
  const keyAt = (ms: number) => (ms < T0 + HOUR ? 'a' : 'b');
  assert.equal(
    nextShowChangeMs({ fromMs: T0, horizonMs: 3 * HOUR, keyAt, minuteAt }),
    T0 + HOUR,
    'the grid change one hour out',
  );
  // A horizon that stops short of the change sees nothing.
  assert.equal(
    nextShowChangeMs({ fromMs: T0, horizonMs: 30 * MIN, keyAt, minuteAt }),
    null,
    'no change inside the horizon → null',
  );
  // The same show either side of an hour mark is not a boundary.
  assert.equal(
    nextShowChangeMs({ fromMs: T0, horizonMs: 3 * HOUR, keyAt: () => 'a', minuteAt }),
    null,
    'a show running across an hour mark is not a change',
  );
  // Coming off a show onto default programming IS a change.
  assert.equal(
    nextShowChangeMs({
      fromMs: T0,
      horizonMs: 3 * HOUR,
      keyAt: (ms) => (ms < T0 + 2 * HOUR ? 'show:a' : 'default'),
      minuteAt,
    }),
    T0 + 2 * HOUR,
    'a show ending into default programming is a boundary',
  );
});

test('a takeover start/expiry is a boundary the grid scan cannot see', () => {
  const minuteAt = minuteAtOffset(0);
  const pinAt = T0 + 20 * MIN; // deliberately NOT on an hour mark
  const keyAt = (ms: number) => (ms < pinAt ? 'a' : 'show:pinned');
  assert.equal(
    nextShowChangeMs({ fromMs: T0, horizonMs: 3 * HOUR, keyAt, minuteAt }),
    T0 + HOUR,
    'without the extra candidate the scan only finds the next hour mark',
  );
  assert.equal(
    nextShowChangeMs({ fromMs: T0, horizonMs: 3 * HOUR, keyAt, minuteAt, extra: [pinAt] }),
    pinAt,
    'the takeover instant wins because it comes first',
  );
  // Out-of-window extras are ignored rather than returned.
  assert.equal(
    nextShowChangeMs({
      fromMs: T0,
      horizonMs: 10 * MIN,
      keyAt,
      minuteAt,
      extra: [pinAt, T0 - HOUR, Number.NaN],
    }),
    null,
    'extras outside the horizon (and non-finite ones) are dropped',
  );
});

// ── where the cut lands ──────────────────────────────────────────────────────

test('the cut is an absolute offset at the boundary', () => {
  // A 25-minute track starting 5 minutes before the boundary: 20 minutes would
  // air inside the next show, so it is cut at the 5-minute mark.
  const cut = resolveBoundaryCueSec({
    startMs: T0,
    cueInSec: 0,
    playableSec: 25 * 60,
    boundaryMs: T0 + 5 * MIN,
  });
  assert.equal(cut?.cueOutSec, 300, 'cut where the boundary falls inside the track');
  // The overshoot rides back with the cue so the drain's log line doesn't
  // re-derive it: 25 minutes of track, 5 of them before the boundary.
  assert.equal(cut?.overshootSec, 20 * 60, 'the prevented spill comes back with the cut');

  // With a trimmed head the cut moves by exactly the skipped seconds: playback
  // starts at cue_in, but cue_out is measured from byte zero. A local
  // subtraction here cuts the track short by the trim.
  assert.equal(
    resolveBoundaryCueSec({
      startMs: T0,
      cueInSec: 12,
      playableSec: 25 * 60,
      boundaryMs: T0 + 5 * MIN,
    })?.cueOutSec,
    312,
    'a head trim shifts the absolute cue_out',
  );
});

test('small overruns are left alone, and a stub is never cut', () => {
  // Inside the tolerance → no cut. The incoming show's first pick has its own
  // latency; a minute of overhang is not worth an early ending.
  assert.equal(
    resolveBoundaryCueSec({
      startMs: T0,
      cueInSec: 0,
      playableSec: 600,
      boundaryMs: T0 + (600 - BOUNDARY_TOLERANCE_SEC) * 1000,
    }),
    null,
    'an overrun exactly at the tolerance is not cut',
  );
  assert.equal(
    resolveBoundaryCueSec({
      startMs: T0,
      cueInSec: 0,
      playableSec: 600,
      boundaryMs: T0 + (600 - BOUNDARY_TOLERANCE_SEC - 1) * 1000,
    })?.cueOutSec,
    600 - BOUNDARY_TOLERANCE_SEC - 1,
    'one second past the tolerance arms the cut',
  );
  // The boundary lands before the floor → leave it running. A record that
  // starts and stops is worse than the overrun.
  assert.equal(
    resolveBoundaryCueSec({
      startMs: T0,
      cueInSec: 0,
      playableSec: 25 * 60,
      boundaryMs: T0 + (BOUNDARY_MIN_PLAY_SEC - 1) * 1000,
    }),
    null,
    'a boundary inside the minimum-play floor leaves the track alone',
  );
  assert.equal(
    resolveBoundaryCueSec({
      startMs: T0,
      cueInSec: 0,
      playableSec: 25 * 60,
      boundaryMs: T0 + BOUNDARY_MIN_PLAY_SEC * 1000,
    })?.cueOutSec,
    BOUNDARY_MIN_PLAY_SEC,
    'exactly at the floor still cuts',
  );
});

test('unknowable inputs never guess a cut', () => {
  const base = { startMs: T0, cueInSec: 0, playableSec: 1500 };
  assert.equal(resolveBoundaryCueSec({ ...base, boundaryMs: null }), null, 'no boundary → null');
  assert.equal(resolveBoundaryCueSec({ ...base, boundaryMs: Number.NaN }), null, 'NaN boundary → null');
  assert.equal(
    resolveBoundaryCueSec({ ...base, playableSec: 0, boundaryMs: T0 + 5 * MIN }),
    null,
    'no playable span → null',
  );
  assert.equal(
    resolveBoundaryCueSec({ ...base, startMs: Number.NaN, boundaryMs: T0 + 5 * MIN }),
    null,
    'no expected start → null',
  );
});

// ── the switch, against a real settings store ────────────────────────────────

async function seed(opts: { station: boolean; showFade: boolean | null }) {
  await settings.load();
  // UTC so the assertions name instants rather than an offset.
  await settings.update({ timezone: 'UTC' });
  const personaId = settings.get().personas[0].id;
  // The grid is Record<day, (string|null)[]>, not an array of arrays.
  const week: Record<number, (string | null)[]> = {};
  for (let d = 0; d < 7; d++) {
    const day: (string | null)[] = Array(24).fill(null);
    // Hours 9 and 10 (station clock) are "early"; 11 onward is default.
    day[9] = 'early';
    day[10] = 'early';
    week[d] = day;
  }
  await settings.update({
    fadeAtShowEnd: opts.station,
    shows: [
      {
        id: 'early',
        name: 'Early',
        topic: 'ambient',
        personaId,
        fadeAtShowEnd: opts.showFade,
      },
    ],
    schedule: week,
  });
  return personaId;
}

test('the switch is off by default and inherits per show', async () => {
  // A store that has never seen the key reads as off — the upgrade guarantee.
  await settings.load();
  assert.equal(settings.get().fadeAtShowEnd, false, 'absent key loads as off');
  assert.equal(settings.effectiveFadeAtShowEnd(null, {}), false, 'absent everywhere → off');

  // Inherit: the show says nothing, so the station default decides.
  assert.equal(settings.effectiveFadeAtShowEnd({ fadeAtShowEnd: null }, { fadeAtShowEnd: true }), true,
    'a show with no opinion inherits the station default');
  assert.equal(settings.effectiveFadeAtShowEnd({ fadeAtShowEnd: null }, { fadeAtShowEnd: false }), false,
    'inherit follows the default off too');
  // Override, in both directions.
  assert.equal(settings.effectiveFadeAtShowEnd({ fadeAtShowEnd: false }, { fadeAtShowEnd: true }), false,
    'a show can opt out of a station default that is on');
  assert.equal(settings.effectiveFadeAtShowEnd({ fadeAtShowEnd: true }, { fadeAtShowEnd: false }), true,
    'a show can opt in with the station default off');
});

test('a show round-trips its tri-state through save and load', async () => {
  await seed({ station: true, showFade: null });
  assert.equal(settings.get().shows[0].fadeAtShowEnd, null, 'null saves as inherit, not false');
  assert.equal(settings.resolveActiveShow(new Date(Date.UTC(2026, 0, 15, 9, 30)))?.fadeAtShowEnd, null,
    'the resolved show carries the field — dropping it disables the feature silently');
  assert.equal(fadeAtShowEndActive(new Date(Date.UTC(2026, 0, 15, 9, 30))), true,
    'inherited from the station default');

  await seed({ station: true, showFade: false });
  assert.equal(settings.get().shows[0].fadeAtShowEnd, false, 'an explicit false survives the round trip');
  assert.equal(fadeAtShowEndActive(new Date(Date.UTC(2026, 0, 15, 9, 30))), false,
    'the show opts out of the station default');
});

test('the live scan finds the grid boundary at the end of the show', async () => {
  await seed({ station: true, showFade: null });
  // 10:40 UTC, inside the show's last hour: the grid flips to default at 11:00.
  const at = Date.UTC(2026, 0, 15, 10, 40);
  assert.equal(nextShowBoundaryMs(at, 40 * 60), Date.UTC(2026, 0, 15, 11, 0),
    'the boundary is the hour the grid stops naming the show');
  // A horizon that ends before it sees nothing.
  assert.equal(nextShowBoundaryMs(at, 10 * 60), null, 'a short track never reaches the boundary');
  // Inside the show's FIRST hour the 10:00 mark is not a change — the same show
  // runs across it.
  assert.equal(
    nextShowBoundaryMs(Date.UTC(2026, 0, 15, 9, 40), 40 * 60),
    null,
    'an hour mark inside one show is not a boundary',
  );
});

test.after(() => rmSync(root, { recursive: true, force: true }));
