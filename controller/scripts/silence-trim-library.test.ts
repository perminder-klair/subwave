// music/silence-trim.ts — the LIBRARY-LOOKUP half of the dead-air trim.
//
// Split out from silence-trim.test.ts, which pins the policy arithmetic on
// tracks that carry their own measurements. That shape is the exception. In
// production NOTHING hands resolveSilenceTrim a track object with
// leadSilenceMs/tailSilenceMs on it: Subsonic songs have no such fields, and
// neither library projection that builds a pick candidate (library.slimTrack,
// the auto.m3u pool) carries them. Every real caller — the queue drain, the
// auto.m3u rewrite, the /now-playing clock — arrives with an id and recovers
// the measurement through library.get().
//
// So the projection IS the feature. library.get() is a hand-written field list,
// and a column missing from it doesn't degrade the trim, it disables it: the
// resolver reads undefined, treats it as "not measured", and stamps nothing
// however the operator sets the dial — with the analysis sitting in the row all
// along. That shipped once (the fields were added to the schema, the row mapper
// and the writer, but not to the projection) and no assertion in the policy
// suite could see it, because none of them went through a DB.
//
// This file goes through the DB on purpose. It is deliberately end-to-end from
// upsertTrackAnalysis to the cue points.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-silence-trim-lib-'));
process.env.STATE_DIR = stateRoot;
writeFileSync(
  path.join(stateRoot, 'settings.json'),
  JSON.stringify({ silenceTrim: { enabled: true, minGapMs: 1_500 } }),
);

const settings = await import('../src/settings.js');
await settings.load();

const db = await import('../src/music/library-db.js');
const library = await import('../src/music/library.js');
const { resolveSilenceTrim, shiftOnsetMs, playableSpanSec } = await import('../src/music/silence-trim.js');

await library.load();

// A 200s track with a 6s leading blank and a 9s trailing one, stored exactly
// the way an analysis pass stores it.
db.upsertTrackMeta('trimmed', {
  title: 'Trimmed', artist: 'A', album: 'Al', duration: 200,
} as never);
db.upsertTrackAnalysis('trimmed', {
  bpm: 120, musicalKey: 'C', introMs: 8_000, confidence: 1,
  leadSilenceMs: 6_000, tailSilenceMs: 9_000, tailStartMs: 191_000,
});

test('the analysis a pass wrote reaches the resolver through library.get', () => {
  // The shape every real caller passes: an id and a length, no measurements.
  const t = resolveSilenceTrim({ id: 'trimmed', duration: 200 });
  assert.equal(t.cueInSec, 5.75, 'head trim lost between the row and the resolver');
  assert.equal(t.cueOutSec, 191.25, 'tail trim lost between the row and the resolver');
});

test('library.get exposes the columns the resolver reads', () => {
  // The assertion above fails for many reasons; this one names the cause. Both
  // fields are optional on the projection's TYPE, so nothing but a test stops
  // them being dropped from the field list again.
  const rec = library.get('trimmed');
  assert.equal(rec.leadSilenceMs, 6_000);
  assert.equal(rec.tailSilenceMs, 9_000);
  assert.equal(rec.tailStartMs, 191_000);
});

test('the onset shift resolves through the library too', () => {
  // introMsOf / introMsFor / firstVocalMsFor and the bed's ramp budget all call
  // shiftOnsetMs with the same id-only track, so a broken projection silently
  // hands the DJ 8s of runway that is really 2.25s.
  assert.equal(shiftOnsetMs({ id: 'trimmed', duration: 200 }, 8_000), 2_250);
});

test('an un-analysed track resolves to no trim, not to zero', () => {
  db.upsertTrackMeta('plain', {
    title: 'Plain', artist: 'A', album: 'Al', duration: 200,
  } as never);
  assert.deepEqual(
    resolveSilenceTrim({ id: 'plain', duration: 200 }),
    { cueInSec: null, cueOutSec: null },
  );
});

test('a track object with its own fresh analysis outranks the stored row', () => {
  // Same precedence as queue.mixAnalysisFor: a pick carrying just-measured
  // values must not get a stale answer from the DB.
  const t = resolveSilenceTrim({
    id: 'trimmed', duration: 200, leadSilenceMs: 2_000, tailSilenceMs: 0, tailStartMs: null,
  });
  assert.equal(t.cueInSec, 1.75);
  assert.equal(t.cueOutSec, null);
});

// The whole-file `edges` facet: the same absolute floor, but measured over
// the whole decoded file rather than a 40 s head and a 20 s tail window, and
// ended on the decoded length rather than the container tag.
db.upsertTrackMeta('edged', { title: 'Edged', artist: 'A', album: 'Al', duration: 200 } as never);
db.upsertTrackAnalysis('edged', {
  bpm: 120, musicalKey: 'C', introMs: 8_000, confidence: 1,
  leadSilenceMs: 6_000, tailSilenceMs: 9_000, tailStartMs: 191_000,
});
db.writeFacetResults('edged', { source: 'url', edges: { leadMs: 3_000, tailMs: 12_000, durationMs: 201_000 } });

test('library.get exposes the edges facet', () => {
  const rec = library.get('edged');
  assert.equal(rec.edgeLeadMs, 3_000);
  assert.equal(rec.edgeTailMs, 12_000);
  assert.equal(rec.decodedDurationMs, 201_000);
});

test('stored edges outrank the window figures, ending on the decoded length', () => {
  const t = resolveSilenceTrim({ id: 'edged', duration: 200 });
  assert.equal(t.cueInSec, 2.75);
  // 201 s decoded − 12 s of trailing silence, + the 250 ms margin.
  assert.equal(t.cueOutSec, 189.25);
  assert.equal(playableSpanSec({ id: 'edged', duration: 200 }), 186.5);
});

test('window figures on the track object do not beat stored edges', () => {
  // A pick carrying the head/tail windows' answer is still the narrower
  // measurement; only edges on the object itself outrank the stored ones.
  const t = resolveSilenceTrim({
    id: 'edged', duration: 200, leadSilenceMs: 2_000, tailSilenceMs: 0, tailStartMs: 200_000,
  });
  assert.equal(t.cueInSec, 2.75);
  assert.equal(t.cueOutSec, 189.25);
  const own = resolveSilenceTrim({
    id: 'edged', duration: 200, edgeLeadMs: 2_000, edgeTailMs: 0, decodedDurationMs: 199_000,
  });
  assert.equal(own.cueInSec, 1.75);
  assert.equal(own.cueOutSec, null);
});

test('with the trim off, the playable span still ends on the decoded length', async () => {
  await settings.update({ silenceTrim: { enabled: false } } as never);
  try {
    assert.equal(playableSpanSec({ id: 'edged', duration: 200 }), 201);
  } finally {
    await settings.update({ silenceTrim: { enabled: true, minGapMs: 1_500 } } as never);
  }
});
