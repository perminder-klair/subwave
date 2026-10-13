// Loose plugin output becomes the full Subsonic shape the controller reads,
// with neutral defaults and published ids — and a malformed row is dropped,
// never thrown.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prefixedCodec } from '../src/host/ids.js';
import { list, normAlbum, normGenre, normLyrics, normSong } from '../src/host/normalize.js';

const codec = prefixedCodec('tt');
const warnings: string[] = [];
const warn = (m: string) => warnings.push(m);

test('a minimal song gets every field the controller reads', () => {
  const s = normSong({ id: 'a1', title: 'Hello' }, codec, warn)!;
  assert.equal(s.id, 'tt-a1');
  assert.equal(s.parent, '');
  assert.equal(s.isDir, false);
  assert.equal(s.type, 'music');
  assert.equal(s.coverArt, 'tt-a1');
  assert.equal(s.discNumber, 1);
  assert.equal(s.year, 0);
  assert.equal(s.genre, '');
  assert.deepEqual(s.genres, []);
  assert.equal(s.contentType, 'audio/mpeg');
  assert.equal(s.suffix, 'mp3');
  assert.equal(s.created, new Date(0).toISOString());
  assert.equal('replayGain' in s, false, 'an unmeasured track must not claim 0 dB');
  assert.equal('musicBrainzId' in s, false);
});

test('song fields are namespaced, coerced and derived', () => {
  const s = normSong(
    {
      id: 7,
      title: 'Seven',
      albumId: 'al',
      artistId: 'ar',
      artists: [{ id: 'ar', name: 'A' }, { id: 'ft', name: 'B' }, { name: '' }],
      genres: ['Rock', { name: 'rock' }, ' Jazz ', ''],
      duration: '183.6',
      suffix: 'FLAC',
      replayGain: { trackGain: -6.5, trackPeak: 'loud' },
      musicBrainzId: '  mbid  ',
    },
    codec,
    warn,
  )!;
  assert.equal(s.id, 'tt-7');
  assert.equal(s.albumId, 'tt-al');
  assert.equal(s.parent, 'tt-al');
  assert.equal(s.coverArt, 'tt-al', 'art falls back to the album');
  assert.equal(s.artistId, 'tt-ar');
  assert.deepEqual(s.artists, [{ id: 'tt-ar', name: 'A' }, { id: 'tt-ft', name: 'B' }]);
  assert.deepEqual(s.genres, [{ name: 'Rock' }, { name: 'Jazz' }], 'deduped case-insensitively');
  assert.equal(s.genre, 'Rock');
  assert.equal(s.duration, 184);
  assert.equal(s.contentType, 'audio/flac');
  assert.deepEqual(s.replayGain, { trackGain: -6.5 });
  assert.equal(s.musicBrainzId, 'mbid');
});

test('rows without a usable id are dropped and reported', () => {
  warnings.length = 0;
  const out = list([{ title: 'no id' }, null, 'string', { id: '' }, { id: 'ok', title: 'fine' }], (r) => normSong(r, codec, warn));
  assert.deepEqual(out.map((s) => s.id), ['tt-ok']);
  assert.ok(warnings.length >= 1);
});

test('a non-array answer is an empty list, not a crash', () => {
  assert.deepEqual(list(undefined, (r) => normSong(r, codec, warn)), []);
  assert.deepEqual(list({ id: 'x' }, (r) => normSong(r, codec, warn)), []);
});

test('albums keep compilation and release dates only when real', () => {
  const plain = normAlbum({ id: 'a', name: 'A' }, codec, warn)!;
  assert.equal('isCompilation' in plain, false);
  assert.equal('originalReleaseDate' in plain, false);
  const reissue = normAlbum(
    { id: 'b', name: 'B', isCompilation: true, originalReleaseDate: { year: 1971 }, releaseDate: { year: 2011, month: 13, day: 2 } },
    codec,
    warn,
  )!;
  assert.equal(reissue.isCompilation, true);
  assert.deepEqual(reissue.originalReleaseDate, { year: 1971, month: 1, day: 1 });
  assert.deepEqual(reissue.releaseDate, { year: 2011, month: 1, day: 2 }, 'an impossible month falls back to 1');
  assert.equal('originalReleaseDate' in normAlbum({ id: 'c', name: 'C', originalReleaseDate: { year: 0 } }, codec, warn)!, false);
});

test('genres accept strings or objects', () => {
  assert.deepEqual(normGenre('Rock'), { value: 'Rock', songCount: 0, albumCount: 0 });
  assert.deepEqual(normGenre({ name: 'Jazz', songCount: 3 }), { value: 'Jazz', songCount: 3, albumCount: 0 });
  assert.equal(normGenre({ name: '  ' }), undefined);
});

test('lyrics distinguish unknown song (undefined) from no lyrics (null)', () => {
  assert.equal(normLyrics(undefined), undefined);
  assert.equal(normLyrics(null), null);
  assert.equal(normLyrics({ lines: [] }), null);
  assert.deepEqual(normLyrics({ lines: ['a', '', 'b'] }), { displayArtist: '', displayTitle: '', lines: ['a', 'b'] });
});
