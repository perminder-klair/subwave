// LRCLIB's stored answers (library-db/lyrics.ts `lyrics_external`): hit and
// miss both kept, the v31 migration that creates the table, and the ID
// rotation carrying an answer to a track's new id. A real SQLite database, as
// in lyric-offsets.test.ts.
//
// Run: `npm test -- lyrics-external`.
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

const stateDir = createTempDir(join(tmpdir(), 'subwave-lyrics-external-'));
process.env.STATE_DIR = stateDir;

const db = await import('../src/music/library-db.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });

after(async () => {
  db.close();
  await removeTempDir(stateDir);
});

const hit = (lrc: string) => ({
  source: 'lrclib', syncedLrc: lrc, plainText: 'plain', instrumental: false, externalId: '42',
});
const miss = { source: 'lrclib', syncedLrc: null, plainText: null, instrumental: false, externalId: null };

test('a hit and a miss are both kept, and a second answer replaces the first', () => {
  assert.equal(db.getExternalLyrics('track-a'), null, 'never asked');
  db.setExternalLyrics('track-a', miss, new Date('2026-01-01T00:00:00Z'));
  assert.deepEqual(db.getExternalLyrics('track-a'), { ...miss, checkedAt: '2026-01-01T00:00:00.000Z' });

  db.setExternalLyrics('track-a', hit('[00:01.00]line'), new Date('2026-02-01T00:00:00Z'));
  assert.deepEqual(db.getExternalLyrics('track-a'), {
    ...hit('[00:01.00]line'), checkedAt: '2026-02-01T00:00:00.000Z',
  });

  db.setExternalLyrics('track-b', { ...miss, instrumental: true });
  assert.equal(db.getExternalLyrics('track-b')?.instrumental, true);
});

test('a v30 database gains the table on its next open, and an upgraded one is left alone', async () => {
  const raw = db.requireDb();
  assert.equal(raw.pragma('user_version', { simple: true }), 32);

  // The predecessor shape: every earlier migration, no lyrics_external.
  raw.exec('DROP TABLE lyrics_external');
  raw.pragma('user_version = 30');
  db.close();
  await db.open({ embeddingDim: 8, adoptStoredDim: true });
  assert.equal(db.requireDb().pragma('user_version', { simple: true }), 32);
  assert.equal(db.getExternalLyrics('track-a'), null, 'created empty');
  db.setExternalLyrics('track-c', hit('[00:02.00]kept'));

  db.close();
  await db.open({ embeddingDim: 8, adoptStoredDim: true });
  assert.equal(db.getExternalLyrics('track-c')?.syncedLrc, '[00:02.00]kept');
});

test('an ID rotation carries the answer to the new id, and an answer already on the new id wins', () => {
  for (const id of [OLD_HEX, NEW_HEX, OLD_FAIL, NEW_FAIL]) {
    db.upsertTrackMeta(id, { title: id, artist: 'A', album: 'B', year: 2000, duration: 200 });
  }
  db.setExternalLyrics(OLD_HEX, hit('[00:01.00]old id'));
  db.setExternalLyrics(OLD_FAIL, hit('[00:01.00]old fail'));
  db.setExternalLyrics(NEW_FAIL, hit('[00:01.00]new fail'));

  const result = db.adoptRotatedIds(new Set([NEW_HEX, NEW_FAIL]));
  assert.equal(result.adopted, 2);
  assert.equal(db.getExternalLyrics(NEW_HEX)?.syncedLrc, '[00:01.00]old id');
  assert.equal(db.getExternalLyrics(NEW_FAIL)?.syncedLrc, '[00:01.00]new fail');
  assert.equal(db.getExternalLyrics(OLD_HEX), null, 'nothing left on the old ids');
  assert.equal(db.getExternalLyrics(OLD_FAIL), null);
});
