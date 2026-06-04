import assert from 'node:assert/strict';
import {
  DEFAULT_ARTIST_RECENCY_HOURS,
  DEFAULT_TRACK_RECENCY_HOURS,
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

console.log('picker-recency regression checks passed');
