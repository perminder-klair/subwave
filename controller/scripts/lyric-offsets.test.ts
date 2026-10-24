// The operator's lyric timing offsets (library-db/lyrics.ts): one station-wide
// value per track, the v30 migration that creates their table, and the ID
// rotation carrying them to a track's new id. A real SQLite database, because
// an upsert or a migration that only works against a mocked handle proves
// nothing.
//
// Run: `npm test -- lyric-offsets`.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

// Golden 32-hex → base62 pairs from scripts/id-adoption.test.ts.
const OLD_HEX = 'e3b7fc2ae9447bbec37a13bf916e3cf6';
const NEW_HEX = '6VHl3uR4kss6sUPKA8Cwnk';
const OLD_FAIL = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const NEW_FAIL = '4V7sy1hL4SujOBMYLPtQuk';

const stateDir = createTempDir(join(tmpdir(), 'subwave-lyric-offsets-'));
process.env.STATE_DIR = stateDir;

const db = await import('../src/music/library-db.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });

after(async () => {
  db.close();
  await removeTempDir(stateDir);
});

const rows = () =>
  db.requireDb().prepare('SELECT track_id, offset_ms FROM lyric_offsets ORDER BY track_id').all();

test('one offset per track, shared by every reader', () => {
  assert.equal(db.getLyricOffset('track-a'), 0, 'no row reads as no correction');
  db.setLyricOffset('track-a', 2900);
  db.setLyricOffset('track-b', -400);
  assert.equal(db.getLyricOffset('track-a'), 2900);
  assert.equal(db.getLyricOffset('track-b'), -400);
  db.setLyricOffset('track-a', 1500);
  assert.equal(db.getLyricOffset('track-a'), 1500, 'a second save replaces the first');
  assert.deepEqual(rows(), [
    { track_id: 'track-a', offset_ms: 1500 },
    { track_id: 'track-b', offset_ms: -400 },
  ]);
});

test('resetting to zero removes the row rather than storing a zero', () => {
  db.setLyricOffset('track-a', 0);
  assert.equal(db.getLyricOffset('track-a'), 0);
  assert.deepEqual(rows(), [{ track_id: 'track-b', offset_ms: -400 }]);
  db.setLyricOffset('track-b', 0);
  assert.deepEqual(rows(), []);
});

test('a v29 database gains the table on its next open, and an upgraded one is left alone', async () => {
  const raw = db.requireDb();
  assert.equal(raw.pragma('user_version', { simple: true }), 30);
  db.setLyricOffset('kept', 700);

  // The predecessor shape: every earlier migration, no lyric_offsets.
  raw.exec('DROP TABLE lyric_offsets');
  raw.pragma('user_version = 29');
  db.close();
  await db.open({ embeddingDim: 8, adoptStoredDim: true });
  assert.equal(db.requireDb().pragma('user_version', { simple: true }), 30);
  assert.deepEqual(rows(), [], 'created empty');
  db.setLyricOffset('track-c', 1200);

  // Reopening at v30 must not recreate or clear it.
  db.close();
  await db.open({ embeddingDim: 8, adoptStoredDim: true });
  assert.equal(db.getLyricOffset('track-c'), 1200);
  db.setLyricOffset('track-c', 0);
});

test('an ID rotation carries the offset to the new id, and an offset already on the new id wins', () => {
  for (const id of [OLD_HEX, NEW_HEX, OLD_FAIL, NEW_FAIL]) {
    db.upsertTrackMeta(id, { title: id, artist: 'A', album: 'B', year: 2000, duration: 200 });
  }
  db.setLyricOffset(OLD_HEX, 2900);
  db.setLyricOffset(OLD_FAIL, 800);
  db.setLyricOffset(NEW_FAIL, -300);

  const result = db.adoptRotatedIds(new Set([NEW_HEX, NEW_FAIL]));
  assert.equal(result.adopted, 2);
  assert.deepEqual(rows(), [
    { track_id: NEW_FAIL, offset_ms: -300 },
    { track_id: NEW_HEX, offset_ms: 2900 },
  ], 'nothing left on the old ids');
});
