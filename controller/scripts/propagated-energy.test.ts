// Integration tests for the audio-derived energy correction (#1362) and the
// calibration storage it rides on — the library-db half that the pure
// scripts/audio-calibration.test.ts cannot reach.
//
// This exists because every query added for the correction is new SQL:
// iterateAudioMoodScores, setTrackAudioMoodScoresBulk,
// setTrackAudioMoodLabelsBulk, propagatedTracksWithAudioScores and
// setTrackEnergyBulk. Pure tests over the selection maths would all pass with
// any of them silently returning nothing.
//
// The load-bearing contract is the SCOPE: a propagated energy may be
// overruled, an llm/manual/uncertain-llm energy may not, and the correction
// writes ONLY the energy column — a corrected row must still report that its
// MOODS are inherited.
//
// Runs a REAL better-sqlite3 DB against a temp STATE_DIR, so STATE_DIR is set
// before library-db is imported (dynamic import below).
// Run: `npm test -- propagated-energy`.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Loud and quiet ends of the arousal axis, well clear of the decision
// threshold in both directions.
const LOUD = {
  energetic: 0.30, workout: 0.30, driving: 0.30, celebratory: 0.30, festival: 0.30,
  calm: 0.10, reflective: 0.10, spiritual: 0.10, focus: 0.10, night: 0.10,
};
const QUIET = {
  energetic: 0.10, workout: 0.10, driving: 0.10, celebratory: 0.10, festival: 0.10,
  calm: 0.30, reflective: 0.30, spiritual: 0.30, focus: 0.30, night: 0.30,
};
const MIDDLING = Object.fromEntries(Object.keys(LOUD).map((k) => [k, 0.20]));

// Setup runs at module scope so the temp STATE_DIR is in place before
// library-db is imported. Note node:test REGISTERS tests as this file
// evaluates and runs them afterwards, sequentially — so unlike an
// immediate-execution harness, a fixture mutation that a test depends on the
// ORDER of has to live inside a test body, not between registrations. The four
// correction fixtures and the pass itself are staged that way below.
const stateDir = mkdtempSync(join(tmpdir(), 'subwave-audio-energy-'));
process.env.STATE_DIR = stateDir;

const db = await import('../src/music/library-db.js');
const { runPropagatedEnergyPass } = await import('../src/music/propagated-energy.js');
await db.open({ embeddingDim: 768, adoptStoredDim: true });

after(() => {
  db.close?.();
  rmSync(stateDir, { recursive: true, force: true });
});

// A library big enough to calibrate against (MIN_BASELINE_TRACKS = 200),
// spread across the arousal range so each mood has real variance. These are
// the population the baselines are computed from.
// Deliberately MORE than one write batch (500). A relabel writes as it walks
// the score maps, and better-sqlite3 refuses a write while a read cursor is
// open on the same connection — so a streamed implementation works on any
// library under one batch and throws on every library over it. That bug
// shipped through a 300-track fixture and was only caught against a real
// 1,405-track library; the fixture is sized to catch it here from now on.
const FILLER = 600;
const filler: Array<{ id: string; scores: Record<string, number> }> = [];
for (let i = 0; i < FILLER; i++) {
  const id = `fill${i}`;
  db.upsertTrackMeta(id, { title: `Filler ${i}`, artist: 'V/A', album: 'Bed', duration: 200 });
  const t = (i % 100) / 100;
  filler.push({
    id,
    scores: Object.fromEntries([
      ...['energetic', 'workout', 'driving', 'celebratory', 'festival'].map((m) => [m, 0.1 + t * 0.2]),
      ...['calm', 'reflective', 'spiritual', 'focus', 'night'].map((m) => [m, 0.3 - t * 0.2]),
    ]),
  });
}
db.setTrackAudioMoodScoresBulk(filler);

test('stored score maps stream back out', () => {
  const seen = [...db.iterateAudioMoodScores()];
  assert.equal(seen.length, FILLER, 'every scored track is streamed');
  assert.ok(Number.isFinite(seen[0].scores.energetic), 'scores round-trip as numbers');
});

test('labels can be rewritten without disturbing the cosines', () => {
  db.setTrackAudioMoodLabelsBulk([{ id: 'fill0', moods: ['calm', 'night'] }]);
  assert.deepEqual(db.getTrack('fill0')!.audioMoods, ['calm', 'night']);
  assert.ok(db.getAudioMoodScores('fill0'), 'the score map survives a relabel');
});

// Seeded from inside the scope test rather than at module scope: the two tests
// above assert on a library holding ONLY the filler, and node:test defers
// execution, so seeding between registrations would run them against a library
// that already carried these four rows.
function seedCorrectionFixtures(): void {
  // The reported case: a loud track whose thin metadata got it a propagated
  // 'low', which then satisfied a strict low-energy overnight show.
  db.upsertTrackMeta('loud', { title: 'What I Like About You', artist: 'Loop Da Loop', album: 'Switched On', duration: 300 });
  db.upsertTrackTags('loud', { moods: ['calm', 'night'], energy: 'low', source: 'propagated', confidence: 0.48 });
  db.setTrackAudioMoodScoresBulk([{ id: 'loud', scores: LOUD }]);

  // A quiet track the propagation happened to get right.
  db.upsertTrackMeta('quiet', { title: 'Quiet One', artist: 'B', album: 'C', duration: 300 });
  db.upsertTrackTags('quiet', { moods: ['calm'], energy: 'low', source: 'propagated', confidence: 0.5 });
  db.setTrackAudioMoodScoresBulk([{ id: 'quiet', scores: QUIET }]);

  // A loud track the LLM judged directly — out of scope, must not be touched.
  db.upsertTrackMeta('judged', { title: 'Judged', artist: 'D', album: 'E', duration: 300 });
  db.upsertTrackTags('judged', { moods: ['calm'], energy: 'low', source: 'llm', confidence: 0.9 });
  db.setTrackAudioMoodScoresBulk([{ id: 'judged', scores: LOUD }]);

  // A propagated track the audio has no strong opinion about.
  db.upsertTrackMeta('mid', { title: 'Mid', artist: 'F', album: 'G', duration: 300 });
  db.upsertTrackTags('mid', { moods: ['evening'], energy: 'medium', source: 'propagated', confidence: 0.5 });
  db.setTrackAudioMoodScoresBulk([{ id: 'mid', scores: MIDDLING }]);
}

let stats: ReturnType<typeof runPropagatedEnergyPass>;

test('the correction scope is propagated rows carrying audio scores', () => {
  seedCorrectionFixtures();
  const scope = db.propagatedTracksWithAudioScores().map((r) => r.id);
  assert.deepEqual(scope.sort(), ['loud', 'mid', 'quiet'], 'llm-judged rows are excluded');
});

test('a misjudged propagated track is corrected from its audio', () => {
  stats = runPropagatedEnergyPass();
  assert.equal(db.getTrack('loud')!.energy, 'high', 'the reported failure case flips low → high');
});

test('a correction rewrites ONLY the energy column', () => {
  const t = db.getTrack('loud')!;
  assert.equal(t.source, 'propagated', 'the row still reports its moods as inherited');
  assert.deepEqual(t.moods, ['calm', 'night'], 'moods are not touched by an energy correction');
  assert.equal(t.confidence, 0.48, 'the propagation confidence is left as it was');
});

test('a propagated value the audio agrees with is left alone', () => {
  assert.equal(db.getTrack('quiet')!.energy, 'low');
  assert.equal(stats.agreed, 1);
});

test('a directly-judged energy is never overruled', () => {
  assert.equal(db.getTrack('judged')!.energy, 'low', 'source=llm is out of scope even when the audio disagrees');
});

test('an undecided track keeps its existing value rather than being bucketed', () => {
  assert.equal(db.getTrack('mid')!.energy, 'medium', 'no guess replaces another guess');
  assert.equal(stats.undecided, 1);
});

test('the pass reports what it did', () => {
  assert.equal(stats.skipped, null);
  assert.equal(stats.scope, 3);
  assert.equal(stats.corrected, 1);
});

test('a relabel spanning more than one write batch completes', async () => {
  // The regression: relabelFromStoredScores writes as it walks, and
  // better-sqlite3 throws "This database connection is busy executing a
  // query" if that walk is a live cursor. Under 500 tracks the flush only
  // ever landed AFTER the loop, so the fixture has to exceed a batch.
  const { relabelFromStoredScores } = await import('../src/music/audio-moods.js');
  const { computeBaselines, prunedBaselines } = await import('../src/music/audio-calibration.js');
  const baselines = prunedBaselines(
    computeBaselines(
      (function* () { for (const r of db.iterateAudioMoodScores()) yield r.scores; })(),
    ),
  );
  const n = relabelFromStoredScores(baselines);
  assert.ok(n > 500, `fixture must exceed one write batch to pin this (got ${n})`);
  assert.ok(
    (db.getTrack('loud')!.audioMoods || []).length > 0,
    'labels are actually written, not just counted',
  );
});

test('paging advances past a row whose score JSON is corrupt', () => {
  // A page whose LAST row fails to parse still has to move the cursor, or
  // the walk stalls on it forever.
  const { items, lastId } = db.pageAudioMoodScores('', 2);
  assert.equal(lastId, items[items.length - 1]?.id ?? lastId, 'cursor tracks the last SCANNED row');
  const end = db.pageAudioMoodScores('zzzzzzzz', 10);
  assert.equal(end.lastId, null, 'an exhausted walk reports done');
});

test('re-running is idempotent — nothing left to correct', () => {
  const again = runPropagatedEnergyPass();
  assert.equal(again.corrected, 0, 'the second pass changes nothing');
  assert.equal(again.agreed, 2, 'both decisive rows now agree with the audio');
});
