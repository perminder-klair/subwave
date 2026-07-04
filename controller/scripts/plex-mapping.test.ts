// Unit tests for the pure Plex → Song/Album/Artist mappers. No network: we feed
// representative `MediaContainer.Metadata` rows (the shape PMS returns for
// tracks/albums/artists) straight into the mappers and assert the projection.
// Run: part of `npm test` (tsx scripts/plex-mapping.test.ts).
//
// These pin the load-bearing bits of the Plex source that a live server can't
// be assumed for: ms→sec duration, the part-key → `song.path` capture that
// getPlayableUri depends on, the artist/album/year fallbacks, and the
// heuristic-ordering signals (viewCount/userRating) that back top-songs and
// starred.

import assert from 'node:assert/strict';
import { mapTrack, mapAlbum, mapArtist, partKeyOf, msToSec } from '../src/music/sources/plex.js';

let failures = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err: any) { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); }
}

// A track as PMS returns it inside /library/metadata/{id} or a hub.
const TRACK = {
  ratingKey: '54321',
  type: 'track',
  title: 'Ledger Lines',
  grandparentTitle: 'Test Cartel',
  grandparentRatingKey: '100',
  parentTitle: 'Neon Ledger',
  parentRatingKey: '200',
  parentYear: 2021,
  index: 2,
  duration: 212_000, // ms
  viewCount: 7,
  userRating: 8,
  thumb: '/library/metadata/200/thumb/1600000000',
  parentThumb: '/library/metadata/200/thumb/1600000000',
  Genre: [{ tag: 'Synthwave' }],
  Media: [{ Part: [{ key: '/library/parts/9/1600000000/file.mp3', file: '/data/music/x.mp3' }] }],
};

console.log('Plex mappers:');

test('msToSec: ms → rounded seconds, guards zero/negative/non-number', () => {
  assert.equal(msToSec(212_000), 212);
  assert.equal(msToSec(1499), 1);
  assert.equal(msToSec(0), undefined);
  assert.equal(msToSec(-5), undefined);
  assert.equal(msToSec('nope'), undefined);
});

test('partKeyOf: first media/part key, null when absent', () => {
  assert.equal(partKeyOf(TRACK), '/library/parts/9/1600000000/file.mp3');
  assert.equal(partKeyOf({}), null);
  assert.equal(partKeyOf({ Media: [{}] }), null);
});

test('mapTrack: core projection', () => {
  const s = mapTrack(TRACK);
  assert.equal(s.id, '54321');
  assert.equal(s.title, 'Ledger Lines');
  assert.equal(s.artist, 'Test Cartel');
  assert.equal(s.album, 'Neon Ledger');
  assert.equal(s.albumId, '200');
  assert.equal(s.artistId, '100');
  assert.equal(s.genre, 'Synthwave');
  assert.equal(s.duration, 212); // ms → sec
  assert.equal(s.index, 2);
});

test('mapTrack: part key is captured on `path` (getPlayableUri depends on it)', () => {
  assert.equal(mapTrack(TRACK).path, '/library/parts/9/1600000000/file.mp3');
});

test('mapTrack: year falls back to parentYear when track year absent', () => {
  assert.equal(mapTrack(TRACK).year, 2021);
  assert.equal(mapTrack({ ...TRACK, year: 2019 }).year, 2019); // track year wins
  assert.equal(mapTrack({ ...TRACK, parentYear: undefined }).year, undefined);
});

test('mapTrack: ratingKey coerced to string even when numeric', () => {
  const s = mapTrack({ ...TRACK, ratingKey: 54321 });
  assert.equal(s.id, '54321');
  assert.equal(typeof s.id, 'string');
});

test('mapTrack: heuristic signals default to 0 when missing', () => {
  const s = mapTrack({ ratingKey: '1', title: 't' }) as any;
  assert.equal(s._viewCount, 0);
  assert.equal(s._userRating, 0);
  assert.equal(s.path, undefined);
  assert.equal(s.duration, undefined);
});

test('mapTrack: originalTitle covers "various artists" compilations', () => {
  const s = mapTrack({ ratingKey: '2', title: 't', originalTitle: 'Guest MC' });
  assert.equal(s.artist, 'Guest MC');
});

test('mapAlbum: projection + addedAt(epoch sec) → ISO `created`', () => {
  const a = mapAlbum({
    ratingKey: '200', title: 'Neon Ledger', parentTitle: 'Test Cartel',
    parentRatingKey: '100', year: 2021, leafCount: 9, viewCount: 40,
    thumb: '/t', addedAt: 1_600_000_000,
  });
  assert.equal(a.id, '200');
  assert.equal(a.name, 'Neon Ledger');
  assert.equal(a.artist, 'Test Cartel');
  assert.equal(a.artistId, '100');
  assert.equal(a.year, 2021);
  assert.equal((a as any).songCount, 9);
  assert.equal(a.created, new Date(1_600_000_000 * 1000).toISOString());
});

test('mapArtist: projection', () => {
  const ar = mapArtist({ ratingKey: '100', title: 'Test Cartel', childCount: 3 });
  assert.equal(ar.id, '100');
  assert.equal(ar.name, 'Test Cartel');
  assert.equal(ar.albumCount, 3);
});

if (failures) { console.error(`\n${failures} Plex-mapper assertion(s) failed`); process.exit(1); }
else console.log('\nall Plex-mapper assertions passed');
