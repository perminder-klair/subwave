// broadcast/vocal-runway.ts — the runway a boundary-deferred spoken segment is
// timed against (#1622 FR 5a), and the two things it must not get wrong.
//
// 1. THE THREE STATES. `vocalRanges` is not a number with holes in it: a finite
//    onset is a measurement, `[]` (Infinity) is an analysed instrumental with
//    nothing to trample, and `null` is a track nobody has measured. Flattening
//    either of the last two into "0ms of runway" would refuse every boundary on
//    an un-analysed station, which is the opposite of the fail-open posture the
//    intro budget has always had.
//
// 2. ONE OPINION ABOUT ONE MEASUREMENT. The onset is measured from byte zero
//    and the drain may cut a leading blank off the same track, so it has to be
//    shifted onto the trimmed timeline. Two readers already applied that shift
//    (the bed's ramp budget, the link's firstVocalMsFor) and the comment at
//    queue.maybePushBed records what happened the one time they disagreed. The
//    agreement assertion below is the point of this file going through a real
//    DB rather than hand-built track objects: library.get()'s projection is a
//    hand-written field list, and a column dropped from it turns the whole
//    feature off in silence.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-vocal-runway-'));
process.env.STATE_DIR = stateRoot;
// The trim ON, so the onset shift is live and a leading blank actually costs
// runway. With it off shiftOnsetMs is the identity and half this file proves
// nothing.
writeFileSync(
  path.join(stateRoot, 'settings.json'),
  JSON.stringify({ silenceTrim: { enabled: true, minGapMs: 1_500 } }),
);

const settings = await import('../src/settings.js');
await settings.load();

const db = await import('../src/music/library-db.js');
const library = await import('../src/music/library.js');
const {
  vocalRunwayMs,
  segmentFitsRunway,
  VOCAL_RUNWAY_FLOOR_MS,
  VOCAL_RUNWAY_CEILING_MS,
} = await import('../src/broadcast/vocal-runway.js');
const { rampBudgetMs } = await import('../src/broadcast/bed-policy.js');
const { firstVocalMsFor, enforceIntroBudget } = await import('../src/llm/dj.js');

await library.load();

function storeTrack(
  id: string,
  analysis: Record<string, unknown>,
): void {
  db.upsertTrackMeta(id, { title: id, artist: 'A', album: 'Al', duration: 200 } as never);
  db.upsertTrackAnalysis(id, { bpm: 120, key: 'C', confidence: 1, ...analysis } as never);
}

// Vocals at 9s on a file with a 6s leading blank: 3.25s of real runway once the
// drain has cut the blank (6000ms gap - 250ms margin = 5.75s trimmed away).
storeTrack('trimmed', {
  introMs: 9_000,
  leadSilenceMs: 6_000,
  vocalRanges: [{ startMs: 9_000, endMs: 60_000 }],
});
// The same onset with nothing to trim.
storeTrack('plain', {
  introMs: 9_000,
  vocalRanges: [{ startMs: 9_000, endMs: 60_000 }],
});
// Analysed, no vocals anywhere — and a leading blank, so the shift gets a
// chance to turn Infinity into something finite if it is applied carelessly.
storeTrack('instrumental', { introMs: 4_000, leadSilenceMs: 6_000, vocalRanges: [] });
// Metadata only: never analysed.
db.upsertTrackMeta('unmeasured', { title: 'U', artist: 'A', album: 'Al', duration: 200 } as never);

test('the three vocal states survive the trip through the library', () => {
  assert.equal(vocalRunwayMs({ id: 'plain', duration: 200 }), 9_000);
  assert.equal(
    vocalRunwayMs({ id: 'instrumental', duration: 200 }),
    Infinity,
    'an analysed instrumental must stay Infinity — a leading blank is not a vocal onset',
  );
  assert.equal(
    vocalRunwayMs({ id: 'unmeasured', duration: 200 }),
    null,
    'un-analysed must stay null, never 0',
  );
  assert.equal(vocalRunwayMs(null), null);
  assert.equal(vocalRunwayMs({}), null, 'no id and no ranges is unknown, not zero');
});

test('the onset lands on the trimmed timeline, not on byte zero', () => {
  // 9s measured, 5.75s of leading blank cut by the drain.
  assert.equal(vocalRunwayMs({ id: 'trimmed', duration: 200 }), 3_250);
});

test('a track carrying fresh ranges outranks the stored row', () => {
  // Same precedence as silence-trim and queue.mixAnalysisFor: a pick holding
  // just-measured analysis must not get a stale answer from the DB.
  assert.equal(
    vocalRunwayMs({ id: 'plain', duration: 200, vocalRanges: [{ startMs: 4_000 }] }),
    4_000,
  );
});

test('the bed and the link read the same number off the same track', () => {
  // The rule this module exists for. rampBudgetMs is the bed's half (the
  // three-state read), firstVocalMsFor is the link's (the shift), and a third
  // spelling that agreed with neither is what shipped once before.
  for (const id of ['plain', 'trimmed']) {
    const track = { id, duration: 200 };
    assert.equal(
      vocalRunwayMs(track),
      firstVocalMsFor(track),
      `${id}: the deferred segment and the pick link disagree about the runway`,
    );
  }
  // The unshifted read is the input, not the answer — proving the shift is
  // ours and not something the caller is expected to remember.
  assert.equal(rampBudgetMs({ vocalRanges: library.get('trimmed').vocalRanges }), 9_000);
});

test('an unknown or instrumental runway never refuses a boundary', () => {
  // Fail open, both of them: this is what keeps a station with no Demucs pass
  // byte-identical to before the feature.
  assert.equal(segmentFitsRunway(30_000, null), true);
  assert.equal(segmentFitsRunway(30_000, Infinity), true);
});

test('a measured onset inside the band decides on the clip length', () => {
  assert.equal(segmentFitsRunway(5_000, 9_000), true, 'finishes with room to spare');
  assert.equal(segmentFitsRunway(9_000, 9_000), true, 'lands exactly on the onset');
  assert.equal(segmentFitsRunway(9_001, 9_000), false, 'one ms into the vocal is over');
});

test('a vocal entry under the floor refuses every clip', () => {
  // The floor's leniency belongs to the energy heuristic, not to a measured
  // vocal: below it the singer genuinely starts immediately.
  assert.equal(segmentFitsRunway(1_000, VOCAL_RUNWAY_FLOOR_MS - 1), false);
  assert.equal(segmentFitsRunway(1_000, 0), false);
  assert.equal(segmentFitsRunway(1_000, VOCAL_RUNWAY_FLOOR_MS), true);
});

test('runway past the ceiling constrains nothing, without needing a branch', () => {
  // The intro budget's upper guard holds here too, but it falls out of the clip
  // ceiling rather than being restated: anything that reaches the comparison is
  // shorter than CEILING and so shorter than a runway at or past it. Pinned
  // because re-adding it as a branch is the tempting, unreachable "symmetry".
  assert.equal(segmentFitsRunway(VOCAL_RUNWAY_CEILING_MS - 1, VOCAL_RUNWAY_CEILING_MS), true);
  assert.equal(segmentFitsRunway(VOCAL_RUNWAY_CEILING_MS - 1, 1_000_000), true);
  assert.equal(segmentFitsRunway(17_000, 16_999), false, 'inside the band it is still the clip that decides');
});

test('a clip past the ceiling airs rather than starving in the pending slot', () => {
  // Asked FIRST, and deliberately: no runway in the binding band could hold a
  // clip this long, so refusing boundaries for it would ride the pending slot
  // to PENDING_VOICE_MAX_AGE_MS and drop it unaired. Talking over the intro is
  // what a long segment already did; losing it entirely would be new damage.
  assert.equal(segmentFitsRunway(VOCAL_RUNWAY_CEILING_MS, 3_000), true);
  assert.equal(segmentFitsRunway(45_000, 100), true, 'even against the worst runway there is');
  assert.equal(segmentFitsRunway(VOCAL_RUNWAY_CEILING_MS - 1, 3_000), false, 'just inside the band still defers');
});

test('a clip with no measurable length is never held for it', () => {
  assert.equal(segmentFitsRunway(0, 3_000), true);
  assert.equal(segmentFitsRunway(NaN, 3_000), true);
});

test('the band is one fold shared with the intro budget', () => {
  // enforceIntroBudget's own guards key off these constants now, so a change to
  // the band moves the link trim and the segment hold together or not at all.
  assert.equal(
    enforceIntroBudget('Short line.', null, 1, VOCAL_RUNWAY_FLOOR_MS - 1),
    '',
    'a measured onset under the floor still drops a link',
  );
  assert.equal(enforceIntroBudget('Short line.', null, 1, VOCAL_RUNWAY_FLOOR_MS), 'Short line.');
  const long = 'a b c d e f g h i j k l m n o p q r s t u v w x y z';
  assert.equal(
    enforceIntroBudget(long, VOCAL_RUNWAY_CEILING_MS),
    long,
    'a runway at the ceiling constrains nothing',
  );
});
