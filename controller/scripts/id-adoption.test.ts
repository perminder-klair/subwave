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
// Two more 32-hex → base62 pairs (same value-preserving branch as OLD_HEX),
// for the analyze-failure carry rules: OLD_FAIL's successor is un-analysed and
// must inherit the strikes; OLD_REDONE's successor analysed cleanly and must
// NOT have them resurrected.
const OLD_FAIL = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const NEW_FAIL = '4V7sy1hL4SujOBMYLPtQuk';
const OLD_REDONE = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const NEW_REDONE = '0swFTnex6snHrxlMKLfJgA';

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'subwave-adopt-'));
  process.env.STATE_DIR = stateDir;

  const db = await import('../src/music/library-db.js');
  const stemCache = await import('../src/music/stem-cache.js');
  const rotation = await import('../src/music/id-rotation.js');
  const { ROTATION_PREFIX } = await import('../src/music/tagger-progress.js');
  await db.open({ embeddingDim: 8, adoptStoredDim: true });
  const sql = db.requireDb();

  // ---- seed the pre-rotation library ---------------------------------------
  db.upsertTrackMeta(OLD_HEX, { title: 'Old Title', artist: 'A', album: 'B', year: 1999, duration: 200 });
  db.upsertTrackTags(OLD_HEX, { moods: ['warm', 'dusty'], energy: 'medium', source: 'llm', confidence: 0.9 });
  db.upsertTrackEnrichment(OLD_HEX, { lastfmTags: ['classic rock'], lyricExcerpt: 'la la' });
  db.upsertTrackAnalysis(OLD_HEX, {
    bpm: 120, musicalKey: 'Am', introMs: 4200, loudnessLufs: -11.2, peakDb: -0.8,
    vocalRanges: [], outro: { ending: 'fade' } as never, stemsAttempted: true,
    // Dead-air trim (#1470). Days of decode time on a real library, and the
    // columns landed AFTER the first version of the carry list was written —
    // the exact class of loss the derived carry set exists to stop.
    leadSilenceMs: 6_000, tailSilenceMs: 9_000, tailStartMs: 191_000,
  });
  db.setOriginalYear(OLD_HEX, 1978); // MusicBrainz resolution — must outrank walk-time album-tag year
  // 1978 is the era the row resolves to at this point, so the write leaves
  // text_vector_dirty = 0 — the state the adoption must carry across.
  db.upsertTrackVector(OLD_HEX, [1, 2, 3, 4, 5, 6, 7, 8], 1978);
  db.upsertTrackAudioVector(OLD_HEX, new Float32Array(512).fill(0.25));
  // …then something changed the row's era text, so the stored vector no longer
  // describes it (#1418 follow-up). The marker is NOT NULL DEFAULT 0, so a
  // fresh row's 0 looks like a real answer to every null-based merge rule —
  // it has to follow the VECTOR across, or the vector arrives looking clean and
  // is never replaced.
  sql.prepare('UPDATE tracks SET text_vector_dirty = 1 WHERE id = ?').run(OLD_HEX);
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

  // Two tracks that had failed analysis three times — out of every scope via
  // analysisFailureExclusion (#1315).
  for (const id of [OLD_FAIL, OLD_REDONE]) {
    db.upsertTrackMeta(id, { title: 'Broken', artist: 'I', album: 'J', duration: 111 });
    for (let i = 0; i < 3; i++) db.recordAnalysisFailure(id, 'decode failed');
  }

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

  db.upsertTrackMeta(NEW_FAIL, { title: 'Broken', artist: 'I', album: 'J', duration: 111 });
  db.upsertTrackMeta(NEW_REDONE, { title: 'Broken', artist: 'I', album: 'J', duration: 111 });
  // …and this one analysed cleanly under its new id, which is what NULLs the
  // failure trio. Adoption must not put the old row's three strikes back.
  db.upsertTrackAnalysis(NEW_REDONE, { bpm: 96, musicalKey: 'C', introMs: 1000 });

  const liveIds = new Set([NEW_HEX, NEW_NANO, KEEP, NEW_FAIL, NEW_REDONE]);
  // Capture stdout across the adoption so the [rotation] sentinel can be
  // asserted — it is what tells the live controller to migrate its state files
  // NOW rather than at the child's exit, hours later.
  const stdout: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => { stdout.push(args.map(String).join(' ')); };
  let result: { adopted: number; pruned: number };
  try {
    result = await rotation.adoptAndPrune(liveIds);
  } finally {
    console.log = realLog;
  }

  console.log('adoption after a rotated walk:');

  await test('adopts every rotated track and prunes only the genuinely deleted one', () => {
    assert.equal(result.adopted, 4);
    assert.equal(result.pruned, 1);
    const ids = (sql.prepare('SELECT id FROM tracks ORDER BY id').all() as Array<{ id: string }>).map(r => r.id);
    assert.deepEqual(ids.sort(), [NEW_HEX, NEW_NANO, KEEP, NEW_FAIL, NEW_REDONE].sort());
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

  // The columns whose absence from the old hand-written carry list was the
  // whole bug: measured once, expensive to remeasure, and invisible if lost —
  // `analysis_version` rides across too, so nothing would ever re-derive them.
  await test('dead-air trim measurements survive the rotation', () => {
    const row = sql.prepare(
      'SELECT lead_silence_ms, tail_silence_ms, tail_start_ms FROM tracks WHERE id = ?',
    ).get(NEW_HEX) as Record<string, unknown>;
    assert.equal(row.lead_silence_ms, 6_000);
    assert.equal(row.tail_silence_ms, 9_000);
    assert.equal(row.tail_start_ms, 191_000);
  });

  await test('analysis failures follow an un-analysed successor, and are not resurrected onto an analysed one', () => {
    const failed = sql.prepare(
      'SELECT analyze_error, analyze_fail_count FROM tracks WHERE id = ?',
    ).get(NEW_FAIL) as Record<string, unknown>;
    assert.equal(failed.analyze_fail_count, 3, 'three strikes keep the track out of scope');
    assert.equal(failed.analyze_error, 'decode failed');

    const redone = sql.prepare(
      'SELECT analyze_error, analyze_failed_at, analyze_fail_count, bpm FROM tracks WHERE id = ?',
    ).get(NEW_REDONE) as Record<string, unknown>;
    assert.equal(redone.bpm, 96, 'the successor kept its own clean analysis');
    assert.equal(redone.analyze_fail_count, null);
    assert.equal(redone.analyze_error, null);
    assert.equal(redone.analyze_failed_at, null);
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

  await test('the stale-vector marker rides with the vector it describes', () => {
    const moved = sql.prepare('SELECT text_vector_dirty FROM tracks WHERE id = ?').get(NEW_HEX) as { text_vector_dirty: number };
    assert.equal(moved.text_vector_dirty, 1, 'a carried vector keeps its refresh marker');
    // Nothing moved onto NANO (neither side had a vector), so it keeps its own.
    const untouched = sql.prepare('SELECT text_vector_dirty FROM tracks WHERE id = ?').get(NEW_NANO) as { text_vector_dirty: number };
    assert.equal(untouched.text_vector_dirty, 0);
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

  await test('a [rotation] sentinel asks the controller to migrate state files now', () => {
    const line = stdout.find((l) => l.startsWith(ROTATION_PREFIX));
    assert.ok(line, 'adoption must emit the sentinel, not wait for the child to exit');
    const payload = JSON.parse(line.slice(ROTATION_PREFIX.length));
    assert.equal(payload.adopted, 4);
    assert.ok(payload.at, 'stamped');
    // It has to follow the manifest write: the parent reads the file the
    // moment it sees this line.
    assert.ok(
      stdout.indexOf(line) > stdout.findIndex((l) => l.includes('[id-rotation] adopted')),
      'sentinel comes after the manifest is on disk',
    );
  });

  await test('the manifest records the confirmed map for the controller to apply', () => {
    const manifest = JSON.parse(readFileSync(join(stateDir, 'id-rotation.json'), 'utf8'));
    assert.equal(manifest.version, 1);
    assert.ok(manifest.at);
    assert.deepEqual(manifest.trackMap, {
      [OLD_HEX]: NEW_HEX, [OLD_NANO]: NEW_NANO,
      [OLD_FAIL]: NEW_FAIL, [OLD_REDONE]: NEW_REDONE,
    });
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
    const r = await rotation.adoptAndPrune(new Set([NEW_HEX, NEW_NANO, NEW_FAIL, NEW_REDONE]));
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
