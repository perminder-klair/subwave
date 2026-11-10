// Album/artist blocks must reach their EXACT id tiers on LIBRARY-sourced
// candidates, not just on raw Subsonic songs. The name fallback keys on
// (album name, THAT TRACK'S artist), so on a compilation every track but the
// one the block was created from misses it.
//
// Pinned from both ends: the walk's ids survive the round trip through
// library.db, and a blocked album's other tracks are blocked by id.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const stateDir = mkdtempSync(join(tmpdir(), 'subwave-blocklist-album-id-'));
process.env.STATE_DIR = stateDir;

const db = await import('../src/music/library-db.js');
const library = await import('../src/music/library.js');
const blocklist = await import('../src/music/blocklist.js');

await library.load();
await blocklist.load();

// One various-artists compilation: same album id, different artist strings.
const COMP_ALBUM_ID = 'alb-comp-1';
db.upsertTrackMeta('t1', {
  title: 'Opener', artist: 'First Act', album: 'Sunshine Sampler',
  albumId: COMP_ALBUM_ID, artistId: 'art-first',
});
db.upsertTrackMeta('t2', {
  title: 'Second', artist: 'Second Act', album: 'Sunshine Sampler',
  albumId: COMP_ALBUM_ID, artistId: 'art-second',
});
db.upsertTrackTags('t1', { moods: ['sunny'], energy: 'medium', source: 'manual' });
db.upsertTrackTags('t2', { moods: ['sunny'], energy: 'medium', source: 'manual' });

test("the walk's album/artist ids round-trip through library.db", () => {
  const rec = db.getTrack('t2');
  assert.ok(rec);
  assert.equal(rec.albumId, COMP_ALBUM_ID);
  assert.equal(rec.artistId, 'art-second');
});

test('a metadata write without ids never clears the walked ones', () => {
  // The manual tag editor and the analyzer's top-up write TrackMeta with no
  // ids to offer, so this must COALESCE rather than overwrite.
  db.upsertTrackMeta('t2', { title: 'Second (Remaster)' });
  const rec = db.getTrack('t2');
  assert.equal(rec?.title, 'Second (Remaster)');
  assert.equal(rec?.albumId, COMP_ALBUM_ID, 'album id survived a partial write');
  assert.equal(rec?.artistId, 'art-second');
});

test('blocking a compilation album blocks EVERY track on it, not just the one it was created from', async () => {
  // The route resolves an album block from one track row, so the entry carries
  // that track's artist.
  await blocklist.add({
    type: 'album', id: COMP_ALBUM_ID, name: 'Sunshine Sampler', artist: 'First Act',
  });

  const t1 = db.getTrack('t1');
  const t2 = db.getTrack('t2');
  assert.equal(blocklist.isBlocked(t1), true);
  assert.equal(blocklist.isBlocked(t2), true, 'the other artists on the compilation are blocked too');

  // The id tier is what did it: strip the ids and the name fallback misses t2.
  const nameOnly = (r: any) => ({ id: r.id, title: r.title, artist: r.artist, album: r.album });
  assert.equal(blocklist.isBlocked(nameOnly(t1)), true, "name fallback still catches the block's own artist");
  assert.equal(blocklist.isBlocked(nameOnly(t2)), false, 'name fallback alone cannot see it — the id tier is load-bearing');

  const hit = blocklist.hitOf(t2);
  assert.equal(hit?.kind, 'entry');
  assert.equal(hit?.kind === 'entry' && hit.type, 'album');
});

test('the public mood source filters a compilation sibling by its album id', () => {
  const ids = library.songsByMood('sunny').map((track) => track.id);
  assert.equal(ids.includes('t2'), false, 'the differently credited sibling never reaches a mood candidate pool');
});

test('an artist block matches by id through a credit the name fallback cannot normalise', async () => {
  // A DUO credit: #1603's fallback splits a feature credit but never on `&`,
  // since Simon & Garfunkel is one act, so this is the shape only the id tier
  // reaches.
  db.upsertTrackMeta('t3', {
    title: 'Guest Spot', artist: 'Second Act & Somebody Else', album: 'Elsewhere',
    albumId: 'alb-other', artistId: 'art-second',
  });
  await blocklist.add({ type: 'artist', id: 'art-second', name: 'Second Act' });

  const t3 = db.getTrack('t3');
  assert.equal(blocklist.isBlocked(t3), true);
  assert.equal(
    blocklist.isBlocked({ id: 't3', artist: 'Second Act & Somebody Else' }),
    false,
    'the exact-name fallback cannot match a co-credit — the id tier is what does',
  );
  // The feature shape it CAN now reach, with no id on the row at all (#1603).
  assert.equal(blocklist.isBlocked({ id: 't4', artist: 'Somebody Else feat. Second Act' }), true);
});

test.after(() => {
  rmSync(stateDir, { recursive: true, force: true });
});
