// When a stem answer stamps stems_at (#2238, music/stem-stamp-policy.ts), and
// the miss count's storage (tracks.stems_tail_misses).
//
// Pinned here:
// - a proven tail that did not land leaves the track unstamped, so the
//   backfill separates it again, until the TAIL_STEM_MISS_LIMIT-th miss in a
//   row, which stamps it: an unprovable tail never holds a slot forever;
// - no tail to cut (tail_stems_landed absent: an unproven tail, or an older
//   analyzer) stamps exactly as before;
// - the count is written with the answer, cleared by a landed tail and by
//   every clear that resets stems_at.
//
// Run: `npm test -- stem-stamp-policy`.

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-stem-stamp-'));
process.env.STATE_DIR = stateRoot;

const { stemStampDecision, TAIL_STEM_MISS_LIMIT } = await import('../src/music/stem-stamp-policy.js');
const db = await import('../src/music/library-db.js');
await db.open({ embeddingDim: 768, adoptStoredDim: true });

after(async () => {
  db.close();
  await removeTempDir(stateRoot);
});

test('no tail to cut stamps as before', () => {
  assert.deepEqual(stemStampDecision({ stemsCached: true, tailStems: null, priorTailMisses: null }),
    { stamp: true, tailMisses: null });
  // A failed head write is still an attempt, as it always was.
  assert.deepEqual(stemStampDecision({ stemsCached: false, tailStems: null, priorTailMisses: null }),
    { stamp: true, tailMisses: null });
  assert.deepEqual(stemStampDecision({ stemsCached: true, tailStems: true, priorTailMisses: 2 }),
    { stamp: true, tailMisses: null });
});

test('no attempt never stamps and leaves the count', () => {
  assert.deepEqual(stemStampDecision({ stemsCached: null, tailStems: null, priorTailMisses: 2 }), { stamp: false });
  assert.deepEqual(stemStampDecision({ stemsCached: null, tailStems: false, priorTailMisses: 1 }), { stamp: false });
});

test('a proven tail that did not land retries, up to the bound', () => {
  assert.equal(TAIL_STEM_MISS_LIMIT, 3);
  let prior: number | null = null;
  const stamps: boolean[] = [];
  for (let i = 0; i < TAIL_STEM_MISS_LIMIT; i++) {
    const d = stemStampDecision({ stemsCached: true, tailStems: false, priorTailMisses: prior });
    stamps.push(d.stamp);
    prior = d.tailMisses ?? null;
  }
  assert.deepEqual(stamps, [false, false, true]);
  assert.equal(prior, TAIL_STEM_MISS_LIMIT);
  // A tail-only facet answer (no stems_cached) counts as the attempt.
  assert.deepEqual(stemStampDecision({ stemsCached: null, tailStems: false, priorTailMisses: null, okAnswer: true }),
    { stamp: false, tailMisses: 1 });
});

function addTrack(id: string): void {
  db.upsertTrackMeta(id, { title: `Song ${id}`, artist: 'A', album: 'B', duration: 200, fileSize: 5_000_000 });
}

test('the miss count rides the facet write, and a landed tail clears it', () => {
  addTrack('t1');
  db.writeFacetResults('t1', { source: 'full', stemsTailMisses: 1 });
  assert.equal(db.trackStemTailMisses('t1'), 1);
  db.writeFacetResults('t1', { source: 'full', stemsTailMisses: 2 });
  assert.equal(db.trackStemTailMisses('t1'), 2);
  // A write that does not decide leaves it.
  db.writeFacetResults('t1', { source: 'full' });
  assert.equal(db.trackStemTailMisses('t1'), 2);
  db.writeFacetResults('t1', { source: 'full', stems: { attempted: true }, stemsTailMisses: null });
  assert.equal(db.trackStemTailMisses('t1'), null);
});

test('the miss count rides the flat write', () => {
  addTrack('t2');
  db.upsertTrackAnalysis('t2', { bpm: 120, stemsAttempted: false, stemsTailMisses: 1 });
  assert.equal(db.trackStemTailMisses('t2'), 1);
  db.upsertTrackAnalysis('t2', { bpm: 120 });
  assert.equal(db.trackStemTailMisses('t2'), 1);
  db.upsertTrackAnalysis('t2', { bpm: 120, stemsAttempted: true, stemsTailMisses: null });
  assert.equal(db.trackStemTailMisses('t2'), null);
});

test('the clears that reset stems_at reset the count', () => {
  addTrack('t3');
  db.writeFacetResults('t3', { source: 'full', stemsTailMisses: 2 });
  db.clearTrackAudio('t3', 6_000_000);
  assert.equal(db.trackStemTailMisses('t3'), null);
  assert.equal(db.trackFileSize('t3'), 6_000_000);

  db.writeFacetResults('t3', { source: 'full', stemsTailMisses: 2 });
  db.clearAnalysis({ clearStems: false });
  assert.equal(db.trackStemTailMisses('t3'), 2);
  db.clearAnalysis({ clearStems: true });
  assert.equal(db.trackStemTailMisses('t3'), null);
});
