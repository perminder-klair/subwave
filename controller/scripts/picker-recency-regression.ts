import assert from 'node:assert/strict';
import {
  DEFAULT_ARTIST_RECENCY_HOURS,
  DEFAULT_TRACK_RECENCY_HOURS,
  durationSeconds,
  effectiveNoRepeatWindow,
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

// NOTE: max-track-length is no longer a pick-time filter. #636 moved it to a
// hard on-air cut (Liquidsoap), so filterPickerCandidates no longer takes
// maxDurationSec — the former over-length-drop assertions were removed when
// develop merged in here. durationSeconds (above) is still the length reader.

// ── count-based hard no-repeat guard (live-repeats fix) ─────────────────────

// The RELAXABLE recent guard re-serves a fully-recent pool (every candidate
// played) rather than returning nothing — this is the cascade behaviour the
// hard guard exists to backstop.
const allRecent = filterPickerCandidates(songs, {
  recentIds: new Set(songs.map((s) => s.id)),
});
assert(allRecent.length > 0, 'relaxable recent guard must relax to avoid an empty pool');

// The HARD guard does NOT relax: when every candidate is in hardRecentIds the
// filter returns [] no matter how starved the pool is. This is what stops a
// just-played track re-airing through a thin similarity cluster.
const allHard = filterPickerCandidates(songs, {
  hardRecentIds: new Set(songs.map((s) => s.id)),
});
assert.equal(allHard.length, 0, 'hard no-repeat guard must never relax');

// Mixed: only the hard-blocked track is removed; the rest survive (and the
// relaxable guard is untouched here).
const partialHard = filterPickerCandidates(songs, {
  hardRecentIds: new Set(['song-2']),
});
assert.deepEqual(
  partialHard.map((s) => s.id),
  ['song-1', 'song-3'],
  'hard guard must drop exactly the blocked id and keep the rest',
);

// hardRecentKeys blocks a candidate whose id is fresh but whose title|artist
// matches a recent play — the path that catches an id-less (events-backfilled)
// recent play, or the same song re-imported under a new Subsonic id.
const keyBlocked = filterPickerCandidates(
  [{ id: 'fresh-id', title: 'One', artist: 'A' }],
  { hardRecentKeys: new Set(['one|a']) },
);
assert.equal(keyBlocked.length, 0, 'hardRecentKeys must block by title|artist even with a fresh id');

// The hard guard survives the relaxation cascade even when stacked with a
// fully-recent relaxable set: song-1 stays blocked, song-2/3 relax back in.
const stacked = filterPickerCandidates(songs, {
  recentIds: new Set(songs.map((s) => s.id)),
  hardRecentIds: new Set(['song-1']),
});
assert(
  !stacked.some((s) => s.id === 'song-1'),
  'hard guard must hold even while the relaxable guard relaxes around it',
);
assert(stacked.length > 0, 'pool must still yield the non-hard-blocked tracks');

// effectiveNoRepeatWindow clamp table (config N, library total) → effective N.
assert.equal(effectiveNoRepeatWindow(100, 1000), 100, '(100,1000) → 100');
assert.equal(effectiveNoRepeatWindow(100, 40), 15, '(100,40) → 15 (3/8 of library)');
assert.equal(effectiveNoRepeatWindow(100, 20), 0, '(100,20) → 0 (below the min-effective floor)');
assert.equal(effectiveNoRepeatWindow(0, 1000), 0, '(0,*) → 0 (disabled)');
assert.equal(effectiveNoRepeatWindow(100, null), 0, '(100,null) → 0 (unknown library)');
assert.equal(effectiveNoRepeatWindow(100, 0), 0, '(100,0) → 0 (empty library)');
assert.equal(effectiveNoRepeatWindow(50, 1000), 50, '(50,1000) → 50 (under the library ceiling)');

console.log('picker-recency regression checks passed');
