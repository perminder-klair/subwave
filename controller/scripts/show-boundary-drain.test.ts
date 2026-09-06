// Pins the DRAIN side of the show-boundary fade (#1574) — everything
// scripts/show-boundary.test.ts cannot see, because that file drives the pure
// policy and this one drives `queue.resolveBoundaryCut` and the two contracts
// hanging off it.
//
// Four things regress here rather than in the policy:
//
//  - The three EXEMPTIONS. A listener request is an explicit ask, an unknowable
//    clock has no expected air time to measure from, and the switch may simply
//    be off. Each must fail toward today's behaviour — no cut — and each is
//    reached from a different line, so one of them going missing is silent.
//  - The BED. `maybePushBed` writes a bed straight to next.txt, so it is never
//    an `upcoming` entry and the air-time forecast walks past it. Uncounted,
//    the cut lands a whole link LATE and the track spills exactly the amount
//    the feature exists to stop.
//  - The cut is always EARLIER than the #447 cap and the trimmed tail, by at
//    least the tolerance. That is what makes it safe for the drain to strip the
//    exit gestures: the ending being stripped can never turn out to be the
//    cap's, which arms a washout of its own.
//  - A boundary cut is a PLAIN crossfade at both ends of the seam. radio.liq's
//    arming lines all stand down on liq_show_fade, and the annotation carries
//    the flag with no gesture beside it.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'subwave-boundary-drain-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const { queue } = await import('../src/broadcast/queue.js');
const { getAnnotatedUri } = await import('../src/music/subsonic.js');
const { BOUNDARY_TOLERANCE_SEC } = await import('../src/broadcast/show-boundary.js');

const here = dirname(fileURLToPath(import.meta.url));
const RADIO_LIQ = join(here, '..', '..', 'liquidsoap', 'radio.liq');

const REMAINING_SEC = 30;   // what is left of the on-air track
const TRACK_SEC = 25 * 60;  // the long record the feature exists for
// The boundary is placed with a timed TAKEOVER rather than a grid hour, and
// that is what makes these assertions independent of when the suite runs: the
// grid names the same show in all 168 slots, so the only candidate the scan can
// find is the takeover's start (#930 — not hour-aligned, which is exactly why
// it rides in as an extra candidate). A grid boundary would be somewhere in the
// next 60 minutes, and a run at HH:59 would land inside the minimum-play floor.
const boundaryMs = Date.now() + 600_000;

async function seed(opts: { station: boolean; showFade?: boolean | null }) {
  await settings.load();
  await settings.update({ timezone: 'UTC' });
  const personaId = settings.get().personas[0].id;
  const week: Record<number, (string | null)[]> = {};
  for (let d = 0; d < 7; d++) week[d] = Array(24).fill('long');
  await settings.update({
    fadeAtShowEnd: opts.station,
    shows: [{
      id: 'long', name: 'Long Player', topic: 'ambient', personaId,
      fadeAtShowEnd: opts.showFade ?? null,
    }],
    schedule: week,
    // showId null = an explicit Default programming takeover, so the show on
    // air changes at startedAt even though the grid never stops naming it.
    scheduleOverride: { showId: null, startedAt: boundaryMs, expiresAt: boundaryMs + 3_600_000 },
  });
}

// A queue with one track on air and one pick behind it. `resolveBoundaryCut`
// reads both, so the fixture is the whole world it sees.
function stage(item: Record<string, unknown> = {}) {
  queue.current = {
    track: { id: 'on-air', title: 'On air', artist: 'A', duration: 600 },
    startedAt: new Date(Date.now() - (600 - REMAINING_SEC) * 1000).toISOString(),
  } as never;
  const pick = {
    track: { id: 'pick', title: 'The Long One', artist: 'B', duration: TRACK_SEC },
    ...item,
  } as never;
  queue.upcoming = [pick];
  return pick as unknown as Parameters<typeof queue.resolveBoundaryCut>[0];
}

const NO_TRIM = { cueInSec: null, cueOutSec: null };
const cutFor = (pick: Parameters<typeof queue.resolveBoundaryCut>[0], maxDurationSec: number | null = null) =>
  queue.resolveBoundaryCut(pick, TRACK_SEC, NO_TRIM, maxDurationSec);

// Where the cut SHOULD land: the pick airs when the on-air track ends, so the
// boundary falls that many seconds into it. Computed from the same clock the
// drain reads, hence the tolerance on every comparison against it.
const expectedCueSec = () => (boundaryMs - (Date.now() + REMAINING_SEC * 1000)) / 1000;
const near = (actual: number | undefined, expected: number, what: string) =>
  assert.ok(actual != null && Math.abs(actual - expected) < 3,
    `${what}: expected ~${Math.round(expected)}s, got ${actual}`);

test('a pick that would cross the boundary is cut where the boundary falls', async () => {
  await seed({ station: true });
  const cut = cutFor(stage());
  assert.ok(cut, 'a 25-minute record over a show change is cut');
  near(cut?.cueOutSec, expectedCueSec(), 'the cue lands at the boundary');
  // The overshoot is what the booth log reports, and it is the policy's own
  // figure rather than something the drain recomputes from the cue.
  near(cut?.overshootSec, TRACK_SEC - expectedCueSec(), 'the prevented spill rides along');
});

test('the three exemptions each fail toward leaving the track alone', async () => {
  await seed({ station: true });
  assert.equal(cutFor(stage({ requestedBy: 'a listener' })), null,
    'a listener request is an explicit ask and plays in full');

  const pick = stage();
  queue.current = null;
  assert.equal(cutFor(pick), null,
    'no on-air clock means no expected air time to measure a boundary from');

  await seed({ station: false });
  assert.equal(cutFor(stage()), null, 'the station default off leaves every show alone');

  await seed({ station: true, showFade: false });
  assert.equal(cutFor(stage()), null, 'a show can opt out of a station default that is on');

  await seed({ station: false, showFade: true });
  assert.ok(cutFor(stage()), 'and can opt in with the station default off');
});

test('a queued bed pushes the cut back by exactly what it delays the track', async () => {
  await seed({ station: true });
  const plain = cutFor(stage());
  // maybePushBed hands the bed straight to next.txt, so nothing that walks
  // `upcoming` can see it. Left uncounted this cut lands BED_DELAY seconds
  // early and the track spills that far into the next show.
  const BED_DELAY = 45;
  const bedded = cutFor(stage({ bedded: true, bedDelaySec: BED_DELAY }));
  assert.ok(plain && bedded, 'both pick shapes are cut');
  near(bedded.cueOutSec - plain.cueOutSec, -BED_DELAY,
    'the bed delays the track, so LESS of it plays before the boundary');

  // A bed on an item AHEAD in the chain delays this one just as much.
  queue.current = {
    track: { id: 'on-air', title: 'On air', artist: 'A', duration: 600 },
    startedAt: new Date(Date.now() - (600 - REMAINING_SEC) * 1000).toISOString(),
  } as never;
  const ahead = { sent: true, bedded: true, bedDelaySec: BED_DELAY,
    track: { id: 'ahead', title: 'Ahead', artist: 'C', duration: 0 } } as never;
  const pick = { track: { id: 'pick', title: 'The Long One', artist: 'B', duration: TRACK_SEC } } as never;
  queue.upcoming = [ahead, pick];
  // The ahead item has no usable duration, so the forecast itself is unknowable
  // — the bed must not conjure one out of nothing.
  assert.equal(cutFor(pick), null, 'an unknowable chain stays unknowable, bed or no bed');
});

test('an armed cut is always earlier than the cap and the trim', async () => {
  await seed({ station: true });
  // The #447 cap stopping this track BEFORE the boundary means there is no
  // overshoot left to cut — asking about the raw length would invent one.
  const early = Math.max(60, Math.floor(expectedCueSec() - 120));
  assert.equal(cutFor(stage(), early), null,
    'a track the cap already stops short of the boundary is left to the cap');

  // And when a cut IS armed it beats every other "stop early" offset by at
  // least the tolerance, which is what makes stripping the exit gestures safe:
  // the ending being stripped can never turn out to be the cap's own washout.
  const late = Math.ceil(expectedCueSec() + 10 * 60);
  const cut = cutFor(stage(), late);
  assert.ok(cut, 'a cap past the boundary still leaves the boundary to cut');
  assert.ok(cut.cueOutSec <= late - BOUNDARY_TOLERANCE_SEC,
    `the cut (${cut.cueOutSec}s) precedes the cap (${late}s) by at least the tolerance`);

  const trimmed = queue.resolveBoundaryCut(
    stage(), TRACK_SEC, { cueInSec: null, cueOutSec: late }, null,
  );
  assert.ok(trimmed && trimmed.cueOutSec <= late - BOUNDARY_TOLERANCE_SEC,
    'and precedes a trimmed tail by the same margin');
});

test('an armed cut stamps the flag and strips the gestures it invalidates', async () => {
  await seed({ station: true });
  const pick = stage();
  // Both exit gestures armed by applyMixTransition, as a DJ-mode seam would.
  Object.assign(pick.track, {
    washout: true, washoutAuto: true, washoutDelay: 0.3, loop: true, loopBar: 2,
  });
  const cut = queue.applyBoundaryStamps(pick, cutFor(pick));
  assert.ok(cut && cut > 0, 'the cue comes back for the arbitration');
  assert.equal(pick.track.showFade, true, 'the mixer is told why the track stops');
  for (const k of ['washout', 'washoutAuto', 'washoutDelay', 'loop', 'loopBar'] as const) {
    assert.ok(!(k in pick.track),
      `${k} must be stripped upstream — an old broadcast image ignores liq_show_fade, `
      + 'and the loop branch applies no fader at all');
  }
});

test('a re-drain takes a stale flag back off again', async () => {
  await seed({ station: true });
  const pick = stage();
  queue.applyBoundaryStamps(pick, cutFor(pick));
  assert.equal(pick.track.showFade, true, 'armed on the first drain');
  // The crash-recovery path: the process died between the URI write and
  // `sent`, so this item drains again — and by then the boundary may be gone.
  // The flag rides item.track, which persists, so leaving it would disarm the
  // gestures on a seam that is no longer a boundary cut at all.
  await seed({ station: false });
  const again = queue.applyBoundaryStamps(pick, cutFor(pick));
  assert.equal(again, null, 'the switch went off, so nothing arms');
  assert.ok(!('showFade' in pick.track), 'and the stale flag is cleared, not left behind');
});

test('a boundary cut is a plain crossfade — every gesture stands down', () => {
  const liq = readFileSync(RADIO_LIQ, 'utf8');
  // Both sides of the seam. The four on `b` matter as much as the two on `a`:
  // each of them reshapes `a_source` (sweep chokes it, blend high-passes it,
  // sweep/chop swap it onto the log fade that holds it HOT), and with
  // washing/looping forced false they would otherwise ARM on exactly the seams
  // where the outgoing gesture used to suppress them.
  for (const flag of ['liq_washout', 'liq_loop', 'liq_sweep', 'liq_dissolve', 'liq_chop', 'liq_blend']) {
    const line = liq.split('\n').find(l => l.includes(`${flag}"] == "true"`));
    assert.ok(line, `radio.liq arms ${flag}`);
    assert.ok(line.includes('not boundary_fading'),
      `${flag} must stand down at a boundary cut — its line reads: ${line.trim()}`);
  }

  // The annotation contract the strip relies on: the flag rides the OUTGOING
  // track, and a stripped gesture leaves nothing behind in the URI.
  const uri = getAnnotatedUri(
    { id: 'pick', title: 'The Long One', artist: 'B', showFade: true } as never,
    { cueOutSec: 300 } as never,
  );
  assert.match(uri, /liq_show_fade="true"/, 'the mixer is told why the track stops');
  assert.match(uri, /liq_cue_out="300"/, 'alongside the cut it explains');
  assert.doesNotMatch(uri, /liq_washout|liq_loop/, 'and no gesture the drain stripped');
});

test.after(() => rmSync(root, { recursive: true, force: true }));
