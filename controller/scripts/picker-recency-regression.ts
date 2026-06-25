import assert from 'node:assert/strict';
import {
  DEFAULT_ARTIST_RECENCY_HOURS,
  DEFAULT_TRACK_RECENCY_HOURS,
  durationSeconds,
  filterPickerCandidates,
  recencyWindowsForLibrary,
} from '../src/music/recency.js';

const smallLibraryWindows = recencyWindowsForLibrary(10);
assert(
  smallLibraryWindows.trackHours < DEFAULT_TRACK_RECENCY_HOURS,
  `expected small-library track window to shrink below ${DEFAULT_TRACK_RECENCY_HOURS}h, got ${smallLibraryWindows.trackHours}h`,
);
assert(
  smallLibraryWindows.artistHours < DEFAULT_ARTIST_RECENCY_HOURS,
  `expected small-library artist window to shrink below ${DEFAULT_ARTIST_RECENCY_HOURS}h, got ${smallLibraryWindows.artistHours}h`,
);

const largeLibraryWindows = recencyWindowsForLibrary(80);
assert.equal(largeLibraryWindows.trackHours, DEFAULT_TRACK_RECENCY_HOURS);
assert.equal(largeLibraryWindows.artistHours, DEFAULT_ARTIST_RECENCY_HOURS);

const songs = [
  { id: 'song-1', title: 'One', artist: 'A' },
  { id: 'song-2', title: 'Two', artist: 'B' },
  { id: 'song-3', title: 'Three', artist: 'C' },
];

const recentArtists = new Set(songs.map((song) => song.artist.toLowerCase()));
const relaxed = filterPickerCandidates(songs, { recentArtists, cap: 2 });
assert(
  relaxed.length > 0,
  'expected picker filtering to relax recent artists instead of returning an empty candidate set',
);
assert.equal(relaxed.length, 2);

const strictWhenPossible = filterPickerCandidates(songs, {
  recentArtists: new Set(['a']),
  cap: 2,
});
assert.deepEqual(
  strictWhenPossible.map((song) => song.id),
  ['song-2', 'song-3'],
  'expected picker filtering to keep strict recency exclusions when candidates remain',
);

const recentlyPlayedSongs = filterPickerCandidates(songs, {
  recentIds: new Set(songs.map((song) => song.id)),
  recentKeys: new Set(songs.map((song) => `${song.title.toLowerCase()}|${song.artist.toLowerCase()}`)),
});
assert(
  recentlyPlayedSongs.length > 0,
  'expected picker filtering to relax recent tracks when every candidate is otherwise excluded',
);

// ── max-track-length cap (issue #447) ──────────────────────────────────────

// durationSeconds reads whichever length field the source carries, and treats
// missing / zero / non-finite as "unknown" (null) rather than 0.
assert.equal(durationSeconds({ id: 'x', duration: 240 }), 240);
assert.equal(durationSeconds({ id: 'x', durationSec: 180 }), 180);
assert.equal(durationSeconds({ id: 'x' }), null);
assert.equal(durationSeconds({ id: 'x', duration: 0 }), null);

const mixedLengths = [
  { id: 'short-1', title: 'Short', artist: 'A', duration: 200 },   // ~3m20
  { id: 'long-1', title: 'Hour Mix', artist: 'B', duration: 3600 }, // 1h album mix
  { id: 'unknown-1', title: 'No Meta', artist: 'C' },               // unknown length
  { id: 'short-2', title: 'Brief', artist: 'D', durationSec: 250 }, // library-shaped field
];

// Cap at 10 minutes (600s): the hour-long mix is dropped, the short tracks and
// the unknown-length track survive.
const capped = filterPickerCandidates(mixedLengths, { maxDurationSec: 600 });
assert.deepEqual(
  capped.map((s) => s.id).sort(),
  ['short-1', 'short-2', 'unknown-1'],
  'expected the over-length track to be dropped while unknown-length is kept',
);

// The cap must survive the recency relaxation: even when every short track is
// excluded as recently-played and the filter relaxes recency, the long track
// must still never come back.
const cappedUnderStarvation = filterPickerCandidates(mixedLengths, {
  maxDurationSec: 600,
  recentIds: new Set(['short-1', 'short-2', 'unknown-1']),
});
assert(
  !cappedUnderStarvation.some((s) => s.id === 'long-1'),
  'expected the over-length track to stay dropped even when the pool relaxes recency',
);

// No cap (null / 0) leaves every track — default behaviour is unchanged.
assert.equal(filterPickerCandidates(mixedLengths, { maxDurationSec: null }).length, 4);
assert.equal(filterPickerCandidates(mixedLengths, { maxDurationSec: 0 }).length, 4);

console.log('picker-recency regression checks passed');
