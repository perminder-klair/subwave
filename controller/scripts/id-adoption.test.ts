// Tests for the Navidrome ID-rotation adoption path (music/id-rotation.ts +
// library-db/id-adoption.ts). Navidrome PR #5824 rewrites most media_file ids
// through a deterministic shape transform; before this feature, the sync walk
// would insert every track under its new id and pruneMissingTracks would
// hard-delete every old row — a whole library's worth of tags, analysis,
// vectors, plays attribution and stem dirs re-derived from zero.
//
// The load-bearing contract: an orphan is adopted ONLY when its canonical
// image differs AND is present in the freshly-walked live-id set. A genuinely
// deleted track (canonical image = itself, or image not live) falls through to
// the prune exactly as today, so the feature is inert until the operator's
// Navidrome actually performs the migration.
//
// Runs a REAL better-sqlite3 DB against a temp STATE_DIR, so STATE_DIR is set
// before library-db is imported (dynamic import below), matching
// scripts/stem-backfill.test.ts.
// Run: `tsx scripts/id-adoption.test.ts` (folded into `npm run test`).

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

// Golden pairs from Navidrome PR #5824's own tests (pinned in
// scripts/id-canonical.test.ts).
const OLD_HEX = 'e3b7fc2ae9447bbec37a13bf916e3cf6';
const NEW_HEX = '6VHl3uR4kss6sUPKA8Cwnk';
const OLD_NANO = 'zzzzzzzzzzzzzzzzzzzzzz';
const NEW_NANO = '3LyqmwQBm5IRqlVjNYASwb';
// 22-char base62 that fits 128 bits — canonicalId fixed point, stays live.
const KEEP = '0aaaaaaaaaaaaaaaaaaaaa';
// Hash-family id (fixed point) that vanished from Navidrome — must prune.
const GONE = '5cLJPkLA5DK2BADhoeotPk';

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'subwave-adopt-'));
  process.env.STATE_DIR = stateDir;

  const db = await import('../src/music/library-db.js');
  const stemCache = await import('../src/music/stem-cache.js');
  const rotation = await import('../src/music/id-rotation.js');
  await db.open({ embeddingDim: 8, adoptStoredDim: true });
  const sql = db.requireDb();

  // ---- seed the pre-rotation library ---------------------------------------
  db.upsertTrackMeta(OLD_HEX, { title: 'Old Title', artist: 'A', album: 'B', year: 1999, duration: 200 });
  db.upsertTrackTags(OLD_HEX, { moods: ['warm', 'dusty'], energy: 'medium', source: 'llm', confidence: 0.9 });
  db.upsertTrackEnrichment(OLD_HEX, { lastfmTags: ['classic rock'], lyricExcerpt: 'la la' });
  db.upsertTrackAnalysis(OLD_HEX, {
    bpm: 120, musicalKey: 'Am', introMs: 4200, loudnessLufs: -11.2, peakDb: -0.8,
    vocalRanges: [], outro: { ending: 'fade' } as never, stemsAttempted: true,
  });
  db.setOriginalYear(OLD_HEX, 1978); // MusicBrainz resolution — must outrank walk-time album-tag year
  // 1978 is the era the row resolves to at this point, so the write leaves
  // text_vector_dirty = 0 — the state the adoption must carry across.
  db.upsertTrackVector(OLD_HEX, [1, 2, 3, 4, 5, 6, 7, 8], 1978);
  db.upsertTrackAudioVector(OLD_HEX, new Float32Array(512).fill(0.25));
  db.recordPlay({
    trackId: OLD_HEX, title: 'Old Title', artist: 'A', album: 'B',
    playedAt: '2026-07-01T00:00:00.000Z', source: 'ai', requestedBy: null, showId: null, showName: null,
  });
  const oldStemsDir = stemCache.dirFor(OLD_HEX);
  mkdirSync(oldStemsDir, { recursive: true });
  writeFileSync(join(oldStemsDir, 'head-drums.flac'), Buffer.alloc(16));

  db.upsertTrackMeta(OLD_NANO, { title: 'Nano', artist: 'C', album: 'D', duration: 100 });
  db.upsertTrackTags(OLD_NANO, { moods: ['stale'], energy: 'low', source: 'llm' });

  db.upsertTrackMeta(KEEP, { title: 'Keeper', artist: 'E', album: 'F', duration: 90 });
  db.upsertTrackTags(KEEP, { moods: ['sunny'], energy: 'high', source: 'llm' });

  db.upsertTrackMeta(GONE, { title: 'Deleted', artist: 'G', album: 'H', duration: 80 });
  db.upsertTrackTags(GONE, { moods: ['gone'], energy: 'low', source: 'llm' });

  // ---- simulate the post-rotation walk -------------------------------------
  // Fresh walk metadata lands under the NEW ids (title changed to prove the
  // walk's copy wins), including an album-tag original year that must NOT beat
  // the carried MusicBrainz resolution.
  db.upsertTrackMeta(NEW_HEX, { title: 'Fresh Title', artist: 'A', album: 'B', year: 1999, originalYear: 1999, duration: 200 });
  db.upsertTrackMeta(NEW_NANO, { title: 'Nano', artist: 'C', album: 'D', duration: 100 });
  db.upsertTrackMeta(KEEP, { title: 'Keeper', artist: 'E', album: 'F', duration: 90 });
  // The new NANO row was already re-tagged (re-run / race shape) — its own
  // tags must survive adoption untouched.
  db.upsertTrackTags(NEW_NANO, { moods: ['fresh'], energy: 'high', source: 'llm' });

  const liveIds = new Set([NEW_HEX, NEW_NANO, KEEP]);
  const result = await rotation.adoptAndPrune(liveIds);

  console.log('adoption after a rotated walk:');

  await test('adopts both rotated tracks and prunes only the genuinely deleted one', () => {
    assert.equal(result.adopted, 2);
    assert.equal(result.pruned, 1);
    const ids = (sql.prepare('SELECT id FROM tracks ORDER BY id').all() as Array<{ id: string }>).map(r => r.id);
    assert.deepEqual(ids.sort(), [NEW_HEX, NEW_NANO, KEEP].sort());
  });

  await test('derived data rides onto the new row; walk metadata wins', () => {
    const row = sql.prepare('SELECT * FROM tracks WHERE id = ?').get(NEW_HEX) as Record<string, unknown>;
    assert.equal(row.title, 'Fresh Title');
    assert.deepEqual(JSON.parse(row.moods as string), ['warm', 'dusty']);
    assert.equal(row.energy, 'medium');
    assert.equal(row.bpm, 120);
    assert.equal(row.musical_key, 'Am');
    assert.equal(row.intro_ms, 4200);
    assert.equal(row.loudness_lufs, -11.2);
    assert.equal(row.vocal_ranges_json, '[]');
    assert.deepEqual(JSON.parse(row.outro_json as string), { ending: 'fade' });
    assert.ok(row.stems_at, 'stem attempt stamp carried');
    assert.deepEqual(JSON.parse(row.lastfm_tags as string), ['classic rock']);
    assert.equal(row.lyric_excerpt, 'la la');
  });

  await test('a carried MusicBrainz year outranks the walk-time album-tag year', () => {
    const row = sql.prepare('SELECT original_year, original_year_source FROM tracks WHERE id = ?').get(NEW_HEX) as Record<string, unknown>;
    assert.equal(row.original_year, 1978);
    assert.equal(row.original_year_source, 'musicbrainz');
  });

  await test('text and audio vectors move to the new id', () => {
    assert.equal(db.hasVector(NEW_HEX), true);
    assert.equal(db.hasVector(OLD_HEX), false);
    assert.ok(sql.prepare('SELECT 1 FROM track_audio_vectors WHERE id = ?').get(NEW_HEX));
    assert.equal(sql.prepare('SELECT 1 FROM track_audio_vectors WHERE id = ?').get(OLD_HEX), undefined);
  });

  await test('play history follows the track', () => {
    assert.ok(sql.prepare('SELECT 1 FROM plays WHERE track_id = ?').get(NEW_HEX));
    assert.equal(sql.prepare('SELECT 1 FROM plays WHERE track_id = ?').get(OLD_HEX), undefined);
  });

  await test('the stems dir is renamed to the new id', () => {
    assert.equal(existsSync(stemCache.dirFor(NEW_HEX)), true);
    assert.equal(existsSync(oldStemsDir), false);
    assert.equal(existsSync(join(stemCache.dirFor(NEW_HEX), 'head-drums.flac')), true);
  });

  await test('a new row that already carries its own tags is not clobbered', () => {
    const row = sql.prepare('SELECT moods FROM tracks WHERE id = ?').get(NEW_NANO) as { moods: string };
    assert.deepEqual(JSON.parse(row.moods), ['fresh']);
  });

  await test('an untouched live track keeps its data', () => {
    const row = sql.prepare('SELECT moods FROM tracks WHERE id = ?').get(KEEP) as { moods: string };
    assert.deepEqual(JSON.parse(row.moods), ['sunny']);
  });

  await test('the manifest records the confirmed map for the controller to apply', () => {
    const manifest = JSON.parse(readFileSync(join(stateDir, 'id-rotation.json'), 'utf8'));
    assert.equal(manifest.version, 1);
    assert.ok(manifest.at);
    assert.deepEqual(manifest.trackMap, { [OLD_HEX]: NEW_HEX, [OLD_NANO]: NEW_NANO });
  });

  console.log('idempotence and inertness:');

  await test('a second run over the same walk is a no-op', async () => {
    const again = await rotation.adoptAndPrune(liveIds);
    assert.equal(again.adopted, 0);
    assert.equal(again.pruned, 0);
    const row = sql.prepare('SELECT moods FROM tracks WHERE id = ?').get(NEW_HEX) as { moods: string };
    assert.deepEqual(JSON.parse(row.moods), ['warm', 'dusty']);
  });

  await test('without a rotation it behaves exactly like pruneMissingTracks', async () => {
    // KEEP vanishes from Navidrome; its id is a canonicalId fixed point, so
    // nothing maps and the row must be pruned, not adopted.
    const r = await rotation.adoptAndPrune(new Set([NEW_HEX, NEW_NANO]));
    assert.equal(r.adopted, 0);
    assert.equal(r.pruned, 1);
    assert.equal(sql.prepare('SELECT 1 FROM tracks WHERE id = ?').get(KEEP), undefined);
  });

  db.close();
  rmSync(stateDir, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall id-adoption tests passed');
}

await main();
