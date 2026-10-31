// A file replaced at the same path keeps its track id (Navidrome derives the
// id from the path), so the walk's size change is the only signal that the
// audio is new: library-db.upsertTrackMeta reports it (keeping the old size),
// the walk clears every audio measurement of the track at its end
// (clearTrackAudio, behind decideReplacedClear's mass hold), the facet rows
// follow, and the walk drops the stem files (stem-cache.forgetStems).
// Metadata and the year stay.
//
// Run: npm test -- replaced-file

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const dir = createTempDir(join(tmpdir(), 'subwave-replaced-file-'));
process.env.STATE_DIR = dir;

const db = await import('../src/music/library-db.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });
const { checkFacets } = await import('../src/music/facet-check.js');
const stems = await import('../src/music/stem-cache.js');
const policy = await import('../src/music/replaced-file-policy.js');

after(async () => { db.close(); await removeTempDir(dir); });

const sql = (q: string) => db.getDb()!.prepare(q);
const rows = (id: string) =>
  (sql('SELECT facet, status FROM track_facet_status WHERE track_id = ? ORDER BY facet').all(id) as Array<{ facet: string; status: string }>)
    .map(r => `${r.facet}:${r.status}`);
const consistent = () => {
  const r = checkFacets();
  assert.ok(r.ok, JSON.stringify({ drift: r.drift, orphans: r.orphans }));
};
const meta = (size: number | null) => ({
  title: 'T', artist: 'A', album: 'B', duration: 214, filePath: 'A/B/01 - T.flac', fileSuffix: 'flac', fileSize: size,
});

function measured(id: string) {
  db.upsertTrackMeta(id, meta(1_000));
  db.upsertTrackAnalysis(id, { bpm: 100, musicalKey: 'C', loudnessLufs: -9, peakDb: -1, source: 'full' });
  db.writeFacetResults(id, {
    source: 'url',
    loudness: { loudnessLufs: -10, peakDb: -1 },
  });
  db.upsertTrackAudioVector(id, new Float32Array(db.AUDIO_EMBEDDING_DIM).fill(0.1));
  sql(`UPDATE tracks SET original_year = 1999, original_year_source = 'manual', stems_at = '2026-10-01T00:00:00Z',
         vocal_ranges_json = '[]', map_x = 1, map_y = 2 WHERE id = ?`).run(id);
  db.syncTrackFacets(id);
}

test('the replacement signal: a different size against a known one', () => {
  assert.equal(policy.fileReplaced(1_000, 2_000), true);
  assert.equal(policy.fileReplaced(1_000, 1_000), false);
  assert.equal(policy.fileReplaced(null, 2_000), false, 'a row walked before file facts existed is not a change');
  assert.equal(policy.fileReplaced(1_000, null), false, 'a writer without file facts says nothing about the file');
  assert.equal(policy.fileReplaced(0, 2_000), false);
});

test('the Navidrome signal: re-imported after the track was last measured', () => {
  // Production, 28 Oct: repaired at the exact same size, re-imported at 15:01,
  // last measured at 13:36. The size check alone missed it.
  assert.equal(policy.changedAfterMeasure('2026-10-28T15:01:20.771Z', '2026-10-28T13:36:32.777Z'), true);
  assert.equal(policy.changedAfterMeasure('2026-10-28T12:00:00Z', '2026-10-28T13:36:32.777Z'), false, 'measured after the import');
  assert.equal(policy.changedAfterMeasure('2026-10-28T15:01:20Z', null), false, 'never measured: nothing stale');
  assert.equal(policy.changedAfterMeasure(null, '2026-10-28T13:36:32Z'), false);
  assert.equal(policy.changedAfterMeasure('garbage', '2026-10-28T13:36:32Z'), false);
  assert.equal(policy.changesFloor(null), null, 'no mark: every song');
  assert.equal(policy.changesFloor('2026-10-28T15:00:00Z'), Date.parse('2026-10-28T15:00:00Z') - policy.CHANGE_MARK_MARGIN_MS);
});

test('a future-dated file is never a change, and a future mark reads as now', () => {
  // updatedAt is the file's mtime: a wrong clock on the device that wrote it.
  const now = Date.parse('2026-10-31T12:00:00Z');
  const measured = '2026-10-31T11:00:00Z';
  assert.equal(policy.changedAfterMeasure('2027-06-01T00:00:00Z', measured, now), false, 'past now + the margin');
  assert.equal(policy.changedAfterMeasure('2026-10-31T13:00:00Z', measured, now), true, 'inside the margin: clock skew, still a change');
  assert.equal(policy.changesFloor('2027-06-01T00:00:00Z', now), now - policy.CHANGE_MARK_MARGIN_MS);
  assert.equal(policy.capMark('2027-06-01T00:00:00Z', now), new Date(now).toISOString());
  assert.equal(policy.capMark('2026-10-30T00:00:00Z', now), '2026-10-30T00:00:00Z');
  assert.equal(policy.capMark(null, now), null);
});

test('a mass replacement is held, like a mass prune: nothing cleared without --confirm-replaced', () => {
  // A tag editor's "save all" changes every file's size and date.
  assert.deepEqual(policy.decideReplacedClear({ candidates: 5, knownTracks: 72_000, confirmed: false }), { clear: true });
  const held = policy.decideReplacedClear({ candidates: 40_000, knownTracks: 72_000, confirmed: false });
  assert.equal(held.clear, false);
  assert.match((held as { message: string }).message, /--confirm-replaced/);
  assert.deepEqual(policy.decideReplacedClear({ candidates: 40_000, knownTracks: 72_000, confirmed: true }), { clear: true });
  // The prune's threshold: max(200, 2 % of the library).
  assert.equal(policy.decideReplacedClear({ candidates: 1_440, knownTracks: 72_000, confirmed: false }).clear, true);
  assert.equal(policy.decideReplacedClear({ candidates: 1_441, knownTracks: 72_000, confirmed: false }).clear, false);
  assert.equal(policy.decideReplacedClear({ candidates: 200, knownTracks: 50, confirmed: false }).clear, true);
});

test('a held candidate keeps its old size, so the next walk finds it again', () => {
  measured('held');
  assert.equal(db.upsertTrackMeta('held', meta(3_000)), true);
  const t = sql('SELECT file_size, bpm FROM tracks WHERE id = ?').get('held') as { file_size: number; bpm: number };
  assert.equal(t.file_size, 1_000, 'not stored until the clear');
  assert.equal(t.bpm, 100, 'nothing is cleared by the upsert');
  assert.equal(db.upsertTrackMeta('held', meta(3_000)), true, 'the next walk sees it again');
  db.clearTrackAudio('held', 3_000);
  assert.equal(db.upsertTrackMeta('held', meta(3_000)), false, 'once cleared, the new size is the stored one');
  consistent();
});

test('lastMeasuredAt reads the newest analysis row', () => {
  measured('when');
  sql(`UPDATE track_facet_status SET at = '2026-10-01T00:00:00Z' WHERE track_id = 'when'`).run();
  sql(`UPDATE track_facet_status SET at = '2026-10-20T00:00:00Z' WHERE track_id = 'when' AND facet = 'loudness'`).run();
  assert.equal(db.lastMeasuredAt('when'), '2026-10-20T00:00:00Z');
  assert.equal(db.earliestMeasuredAt(), '2026-10-01T00:00:00Z');
  db.upsertTrackMeta('never', meta(10));
  assert.equal(db.lastMeasuredAt('never'), null);
  // The walk's Navidrome branch: same size, re-imported after the measure.
  assert.equal(db.upsertTrackMeta('when', meta(1_000)), false, 'the size alone says nothing');
  assert.ok(policy.changedAfterMeasure('2026-10-28T15:01:20Z', db.lastMeasuredAt('when')));
  db.clearTrackAudio('when');
  assert.equal(db.lastMeasuredAt('when'), null);
  assert.ok(db.needsAnalysisIds().includes('when'));
  consistent();
});

test('a walk reporting the same size keeps every measurement', () => {
  measured('same');
  const before = rows('same');
  assert.equal(db.upsertTrackMeta('same', meta(1_000)), false);
  assert.equal(db.upsertTrackMeta('same', { title: 'T' }), false, 'a non-walk writer passes no size');
  assert.deepEqual(rows('same'), before);
  assert.equal(db.getTrack('same')?.bpm, 100);
  consistent();
});

test('a replaced file: its audio analysis is due again, its metadata and year stay', () => {
  measured('swap');
  assert.ok(rows('swap').includes('loudness:ok') && rows('swap').includes('clap:ok') && rows('swap').includes('stems:ok'), rows('swap').join());
  assert.equal(db.upsertTrackMeta('swap', meta(2_000)), true);
  db.clearTrackAudio('swap', 2_000);
  const t = sql('SELECT * FROM tracks WHERE id = ?').get('swap') as Record<string, unknown>;
  for (const col of ['bpm', 'musical_key', 'analysis_version', 'loudness_lufs', 'peak_db',
    'outro_json', 'vocal_ranges_json', 'stems_at', 'audio_moods', 'map_x']) {
    assert.equal(t[col], null, `${col} is cleared`);
  }
  assert.equal(t.file_size, 2_000);
  assert.equal(t.title, 'T');
  assert.equal(t.original_year, 1999, 'the year is not an audio measurement');
  assert.equal(sql('SELECT COUNT(*) AS n FROM track_audio_vectors WHERE id = ?').get('swap')!.n, 0);
  assert.deepEqual(rows('swap'), [], 'no analysis row: every facet is due');
  assert.ok(db.needsAnalysisIds().includes('swap'), 'the next analysis run takes it');
  consistent();
});

test('a settled "silent" answer from the old file does not survive the replacement', () => {
  db.upsertTrackMeta('silent', meta(500));
  db.writeFacetResults('silent', { source: 'url', unmeasurable: { loudness: 'silent' } } as never);
  sql(`INSERT OR REPLACE INTO track_facet_status (track_id, facet, version, status, reason, attempts, source, at, unmeasurable_reason)
       VALUES ('silent', 'loudness', ?, 'unmeasurable', 'silent', 0, 'url', '2026-10-28', 'silent')`).run(db.FACET_VERSIONS.loudness);
  assert.equal(db.upsertTrackMeta('silent', meta(9_000_000)), true);
  db.clearTrackAudio('silent', 9_000_000);
  assert.ok(!rows('silent').some(r => r.endsWith(':unmeasurable')), rows('silent').join());
  consistent();
});

test('forgetStems drops the replaced tracks\' stem dirs, and never an offline root', async () => {
  const root = stems.stemsRoot();
  mkdirSync(join(root, 'swap'), { recursive: true });
  writeFileSync(join(root, 'swap', 'head-drums.wav'), 'x');
  mkdirSync(join(root, 'kept'), { recursive: true });
  // No marker, dirs on disk: an existing cache, adopted read-only = online.
  writeFileSync(join(root, stems.STEMS_MARKER), '');
  const r = await stems.forgetStems(['swap', 'absent']);
  assert.deepEqual([r.removed, r.failed], [1, 0]);
  assert.equal(existsSync(join(root, 'swap')), false);
  assert.equal(existsSync(join(root, 'kept')), true, 'only the named tracks');
  assert.deepEqual(await stems.forgetStems([]), { removed: 0, failed: 0 });
});
