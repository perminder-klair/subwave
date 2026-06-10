import assert from 'node:assert/strict';
import {
  DEFAULT_ARTIST_RECENCY_HOURS,
  DEFAULT_TRACK_RECENCY_HOURS,
  coreArtistKey,
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

// Collab-credit collisions: "Prince" vs "Prince and The Revolution", and
// "John Lennon" vs "John Lennon / Yoko Ono" must resolve to the same core key
// so alternating between credit variants doesn't defeat the artist block.
assert.equal(coreArtistKey({ artist: 'Prince and The Revolution' }), 'prince');
assert.equal(coreArtistKey({ artist: 'Prince' }), 'prince');
assert.equal(coreArtistKey({ artist: 'John Lennon / Yoko Ono' }), 'john lennon');
assert.equal(coreArtistKey({ artist: 'John Lennon' }), 'john lennon');

const collabSongs = [
  { id: 'c-1', title: 'Purple Rain', artist: 'Prince and The Revolution' },
  { id: 'c-2', title: 'Kiss', artist: 'Prince' },
  { id: 'c-3', title: 'Pulled Apart By Horses', artist: 'Tricky' },
];

// recentArtistsSince() now adds both the exact credit string and its core
// form for the just-played track, so a "Prince and The Revolution" play
// should block a follow-up "Prince" candidate via the shared core key.
const collabBlocked = filterPickerCandidates(collabSongs, {
  recentArtists: new Set(['prince and the revolution', 'prince']),
  cap: 5,
});
assert.deepEqual(
  collabBlocked.map((song) => song.id),
  ['c-3'],
  'expected "Prince" to be blocked when "Prince and The Revolution" was just played (core-artist match)',
);

// Per-artist cap counting should also key off the core artist, so "Prince"
// and "Prince and The Revolution" credits count toward the same cap.
const capSongs = [
  { id: 'p-1', title: 'Purple Rain', artist: 'Prince and The Revolution' },
  { id: 'p-2', title: 'Kiss', artist: 'Prince' },
  { id: 'p-3', title: '1999', artist: 'Prince' },
  { id: 'p-4', title: 'Pulled Apart By Horses', artist: 'Tricky' },
];
const capped = filterPickerCandidates(capSongs, { maxPerArtist: 1, cap: 5 });
assert.deepEqual(
  capped.map((song) => song.id),
  ['p-1', 'p-4'],
  'expected maxPerArtist to count "Prince" and "Prince and The Revolution" credits together',
);

console.log('picker-recency regression checks passed');
