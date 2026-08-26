import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { effectiveShowNoRepeatWindow } from '../src/music/show-recency.js';

const makeTracks = (n: number) => Array.from({ length: n }, (_, i) => ({
  id: `track-${i + 1}`,
  title: `Track ${i + 1}`,
  artist: `Artist ${i + 1}`,
  genres: [i < 20 ? 'Jazz' : 'Rock'],
}));

const tracks = makeTracks(40);

// A strict playlist is its own catalogue for the hard no-repeat clamp. With
// only 21 distinct tracks the configured 100-track guard must self-disable so
// the relaxable recency cascade can cycle the show instead of falling out to
// unrelated library material.
assert.equal(
  effectiveShowNoRepeatWindow(100, 27_986, {
    show: { playlistStrict: true, filtersStrict: false },
    playlistTracks: tracks.slice(0, 21),
    excludedIds: null,
  }),
  0,
  'a 21-track strict playlist must clamp against 21, not the full library',
);

// The clamp is arithmetic, not a switch: pin both sides of it, or a regression
// that simply returned 0 for every strict playlist would satisfy the whole
// suite. Below the library ceiling the playlist's own 37.5% governs; above it
// the operator's configured window is already the smaller number and stands.
assert.equal(
  effectiveShowNoRepeatWindow(100, 27_986, {
    show: { playlistStrict: true, filtersStrict: false },
    playlistTracks: makeTracks(200),
    excludedIds: null,
  }),
  75,
  'a 200-track strict playlist clamps to floor(200 * 0.375), not the configured 100',
);
assert.equal(
  effectiveShowNoRepeatWindow(100, 27_986, {
    show: { playlistStrict: true, filtersStrict: false },
    playlistTracks: makeTracks(400),
    excludedIds: null,
  }),
  100,
  'a playlist wide enough to carry the configured window keeps it intact',
);

// Soft anchors and unresolved anchors still pick from the wider catalogue, so
// weakening their station-wide no-repeat window would be a regression.
for (const scope of [
  { show: { playlistStrict: false }, playlistTracks: tracks },
  { show: { playlistStrict: true }, playlistTracks: null },
]) {
  assert.equal(
    effectiveShowNoRepeatWindow(100, 27_986, { ...scope, excludedIds: null }),
    100,
    'non-strict or unresolved playlist anchors must remain library-scoped',
  );
}

// Strict music filters and excluded playlists narrow the real universe too.
// Twenty Jazz tracks remain in each case, which is below the minimum useful
// hard window and must therefore cycle under the relaxable guard.
assert.equal(
  effectiveShowNoRepeatWindow(100, 27_986, {
    show: { playlistStrict: true, filtersStrict: true, genres: ['Jazz'] },
    playlistTracks: tracks,
    excludedIds: null,
  }),
  0,
  'strict music filters must narrow the no-repeat clamp universe',
);
assert.equal(
  effectiveShowNoRepeatWindow(100, 27_986, {
    show: { playlistStrict: true, filtersStrict: true, genres: ['Pop Punk'] },
    playlistTracks: tracks.map((track, i) => ({
      ...track,
      genres: [i < 20 ? 'Pop' : 'Rock'],
    })),
    excludedIds: null,
    resolvedGenres: ['Pop'],
  }),
  0,
  'capacity must use the same resolved genre alias as candidate filtering',
);
assert.equal(
  effectiveShowNoRepeatWindow(100, 27_986, {
    show: { playlistStrict: true, filtersStrict: false },
    playlistTracks: tracks,
    excludedIds: new Set(tracks.slice(20).map(track => track.id)),
  }),
  0,
  'excluded playlist tracks must not inflate the no-repeat clamp universe',
);

// Different Subsonic ids for the same title/artist are one audible track. If
// counted separately these 40 rows would enable a 15-track hard window; as 20
// real songs the guard must switch off instead.
const duplicateRips = tracks.slice(0, 20).flatMap(track => [
  track,
  { ...track, id: `${track.id}-duplicate` },
]);
assert.equal(
  effectiveShowNoRepeatWindow(100, 27_986, {
    show: { playlistStrict: true, filtersStrict: false },
    playlistTracks: duplicateRips,
    excludedIds: null,
  }),
  0,
  'duplicate title/artist rips must count as one track for clamp capacity',
);

// The shared policy only fixes the live station if both selection paths call
// it. Pin that wiring so a later picker refactor cannot silently restore the
// library-wide clamp in one path while leaving the helper tests green.
for (const file of ['../src/music/picker.ts', '../src/broadcast/dj-agent.ts']) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  assert.match(source, /effectiveShowNoRepeatWindow\(/,
    `${file} must scope its hard no-repeat window through the shared show policy`);
  assert.match(source, /resolvedGenres:/,
    `${file} must use its resolved genre lock for show capacity`);
}

console.log('show recency checks passed');
