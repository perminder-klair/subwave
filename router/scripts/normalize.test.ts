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

test('explicitStatus passes through as the source said it, and absent stays absent', () => {
  const of = (v: unknown) => normSong({ id: 'x', title: 'X', explicitStatus: v }, codec, warn)!;
  assert.equal(of('explicit').explicitStatus, 'explicit');
  assert.equal(of('clean').explicitStatus, 'clean');
  // '' is the server's answer "read, untagged"; the controller judges a song that carries it.
  assert.equal(of('').explicitStatus, '');
  for (const junk of [undefined, null, 'EXPLICIT', 'e', 1, true]) {
    assert.equal('explicitStatus' in of(junk), false, `${String(junk)} is not a tag`);
  }
});

test('file format fields are kept only when positive', () => {
  const s = normSong({ id: 'f', title: 'F', samplingRate: 96000, bitDepth: '24', channelCount: 2 }, codec, warn)!;
  assert.equal(s.samplingRate, 96000);
  assert.equal(s.bitDepth, 24);
  assert.equal(s.channelCount, 2);
  // Navidrome reports bitDepth 0 for a lossy file: no file is "0-bit".
  const lossy = normSong({ id: 'l', title: 'L', samplingRate: 44100, bitDepth: 0, channelCount: -1 }, codec, warn)!;
  assert.equal(lossy.samplingRate, 44100);
  assert.equal('bitDepth' in lossy, false);
  assert.equal('channelCount' in lossy, false);
});

// The controller reads these off a Subsonic song (music/subsonic.ts and its
// callers). The router copies a fixed list of fields, so a field the controller
// starts reading is dropped silently behind the router unless it is added to
// normSong — and here. Each entry names its reader.
const CONTROLLER_SONG_FIELDS: Record<string, string> = {
  title: 'everywhere', album: 'everywhere', artist: 'everywhere', duration: 'picker, mix',
  track: 'library walk', discNumber: 'library walk', year: 'library walk', genres: 'library walk',
  artists: 'blocklist, credits', albumArtists: 'library walk', size: 'replaced-file signal',
  suffix: 'file-format.ts', bitRate: 'file-format.ts', path: 'navidrome-players real path',
  created: 'library walk', musicBrainzId: 'enrichment', replayGain: 'mix levelling',
  explicitStatus: 'explicit-policy.ts (clean shows)',
  samplingRate: 'file-format.ts', bitDepth: 'file-format.ts', channelCount: 'file-format.ts',
};

test('a full Navidrome song keeps every field the controller reads', () => {
  const navidromeChild = {
    id: 'nd1', title: 'Full', album: 'Al', albumId: 'al1', artist: 'Ar', artistId: 'ar1',
    artists: [{ id: 'ar1', name: 'Ar' }], albumArtists: [{ id: 'ar1', name: 'Ar' }],
    track: 3, discNumber: 2, year: 1999, genres: [{ name: 'Rock' }], size: 1234, contentType: 'audio/flac',
    suffix: 'flac', duration: 200, bitRate: 1411, path: 'Ar/Al/03 Full.flac', created: '2024-01-01T00:00:00Z',
    musicBrainzId: '0f8a4d3b-6f1c-4b0e-9d7e-2a1b3c4d5e6f', replayGain: { trackGain: -6.5, trackPeak: 0.98 },
    explicitStatus: 'explicit', samplingRate: 96000, bitDepth: 24, channelCount: 2,
  };
  const s = normSong(navidromeChild, codec, warn)! as unknown as Record<string, unknown>;
  for (const [field, reader] of Object.entries(CONTROLLER_SONG_FIELDS)) {
    assert.ok(s[field] !== undefined && s[field] !== '' && s[field] !== 0 || field === 'explicitStatus' && s[field] === '',
      `${field} (read by ${reader}) did not survive the router`);
  }
});
