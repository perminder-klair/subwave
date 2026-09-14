// The DRAIN side of the show-boundary fade (#1574): `queue.resolveBoundaryCut`
// and the contracts hanging off it. show-boundary.test.ts drives the pure
// policy instead.

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
// A timed TAKEOVER, not a grid hour, so these assertions do not depend on when
// the suite runs: the grid names one show in all 168 slots, leaving the
// takeover's start (#930) as the only candidate.
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
    // showId null = a Default-programming takeover, so the show on air changes
    // at startedAt even though the grid never stops naming it.
    scheduleOverride: { showId: null, startedAt: boundaryMs, expiresAt: boundaryMs + 3_600_000 },
  });
}

// One track on air and one pick behind it: everything resolveBoundaryCut reads.
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

// The pick airs when the on-air track ends, so the boundary falls this many
// seconds into it. Same clock the drain reads, hence the tolerance below.
const expectedCueSec = () => (boundaryMs - (Date.now() + REMAINING_SEC * 1000)) / 1000;
const near = (actual: number | undefined, expected: number, what: string) =>
  assert.ok(actual != null && Math.abs(actual - expected) < 3,
    `${what}: expected ~${Math.round(expected)}s, got ${actual}`);

test('a pick that would cross the boundary is cut where the boundary falls', async () => {
  await seed({ station: true });
  const cut = cutFor(stage());
  assert.ok(cut, 'a 25-minute record over a show change is cut');
  near(cut?.cueOutSec, expectedCueSec(), 'the cue lands at the boundary');
  // The overshoot is the policy's own figure, not recomputed from the cue.
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
  // maybePushBed writes straight to next.txt, so nothing walking `upcoming`
  // sees the bed; uncounted, the cut lands BED_DELAY seconds early.
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
  // The ahead item has no usable duration, so the forecast is unknowable.
  assert.equal(cutFor(pick), null, 'an unknowable chain stays unknowable, bed or no bed');
});

test('a queued pause-and-talk break pushes the boundary cut back by its net delay', async () => {
  await seed({ station: true });
  const plain = cutFor(stage());
  const PAUSE_DELAY = 35;
  const paused = cutFor(stage({ pauseDelaySec: PAUSE_DELAY }));
  assert.ok(plain && paused, 'both pick shapes are cut');
  near(paused.cueOutSec - plain.cueOutSec, -PAUSE_DELAY,
    'the hidden break delays the track, so less of it plays before the boundary');
});

test('an armed cut is always earlier than the cap and the trim', async () => {
  await seed({ station: true });
  // A #447 cap stopping the track before the boundary leaves no overshoot.
  const early = Math.max(60, Math.floor(expectedCueSec() - 120));
  assert.equal(cutFor(stage(), early), null,
    'a track the cap already stops short of the boundary is left to the cap');

  // An armed cut beats every other stop-early offset by at least the
  // tolerance, which is what makes stripping the exit gestures safe.
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
  // Crash recovery re-drains the item, and the flag rides item.track, which
  // persists; leaving it would disarm gestures on a seam that is no longer a
  // boundary cut.
  await seed({ station: false });
  const again = queue.applyBoundaryStamps(pick, cutFor(pick));
  assert.equal(again, null, 'the switch went off, so nothing arms');
  assert.ok(!('showFade' in pick.track), 'and the stale flag is cleared, not left behind');
});

test('a boundary cut is a plain crossfade — every gesture stands down', () => {
  const liq = readFileSync(RADIO_LIQ, 'utf8');
  // Both sides of the seam: the incoming gestures reshape `a_source` too, and
  // would otherwise arm on the seams the outgoing gesture used to suppress.
  for (const flag of ['liq_washout', 'liq_loop', 'liq_sweep', 'liq_dissolve', 'liq_chop', 'liq_blend']) {
    const line = liq.split('\n').find(l => l.includes(`${flag}"] == "true"`));
    assert.ok(line, `radio.liq arms ${flag}`);
    assert.ok(line.includes('not boundary_fading'),
      `${flag} must stand down at a boundary cut — its line reads: ${line.trim()}`);
  }

  // The flag rides the OUTGOING track, and a stripped gesture leaves nothing
  // behind in the URI.
  const uri = getAnnotatedUri(
    { id: 'pick', title: 'The Long One', artist: 'B', showFade: true } as never,
    { cueOutSec: 300 } as never,
  );
  assert.match(uri, /liq_show_fade="true"/, 'the mixer is told why the track stops');
  assert.match(uri, /liq_cue_out="300"/, 'alongside the cut it explains');
  assert.doesNotMatch(uri, /liq_washout|liq_loop/, 'and no gesture the drain stripped');
});

test.after(() => rmSync(root, { recursive: true, force: true }));
