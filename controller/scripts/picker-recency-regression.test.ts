import assert from 'node:assert/strict';
import {
  DEFAULT_ARTIST_RECENCY_HOURS,
  DEFAULT_TRACK_RECENCY_HOURS,
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

// ── large-library boost (repeated-songs fix) ────────────────────────────────
// The windows scale UP with track count: 12h blocks under 2% of a 10k-50k
// catalogue, far too little memory to force exploration. Keys on track count,
// never artists — a 500-track library must NOT get boosted.
assert.equal(recencyWindowsForLibrary(80, 500).trackHours, DEFAULT_TRACK_RECENCY_HOURS);
assert.equal(recencyWindowsForLibrary(80, 3000).trackHours, 18);
assert.equal(recencyWindowsForLibrary(80, 8000).trackHours, 24);
assert.equal(recencyWindowsForLibrary(80, 20000).trackHours, 36);
assert.equal(recencyWindowsForLibrary(80, 20000).artistHours, 6);
// The small-library shrink still wins: few artists shrink the window even
// when the track count is (implausibly) large.
assert(
  recencyWindowsForLibrary(10, 20000).trackHours < 36,
  'small-artist shrink must still apply under the boost',
);

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

// ── count-based hard no-repeat guard (live-repeats fix) ─────────────────────

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

// ── hard artist block (issue #1187) ────────────────────────────────────────

// The agent path's back-to-back artist guard calls the pool asking for a pick
// that ISN'T the on-air artist. `blockedArtists` is how that ask is enforced:
// unlike recentArtists it is checked outside the mode loop, so the starvation
// cascade can never hand back the very artist the caller is steering around.
const blockedOnly = filterPickerCandidates(songs, {
  blockedArtists: new Set(['a']),
});
assert.deepEqual(
  blockedOnly.map((s) => s.id),
  ['song-2', 'song-3'],
  'blockedArtists must drop exactly that artist and keep the rest',
);

// The load-bearing case: every OTHER artist is recently played, so the cascade
// would ordinarily relax recentArtists and re-serve artist A. The hard block
// keeps A out and lets the cascade relax into B/C instead — this is what turns
// "the agent only saw the on-air artist" into a genuinely different pick rather
// than a repeat with extra steps.
const relaxAroundBlock = filterPickerCandidates(songs, {
  recentArtists: new Set(['a', 'b', 'c']),
  blockedArtists: new Set(['a']),
});
assert(relaxAroundBlock.length > 0, 'cascade must still relax recentArtists around a hard artist block');
assert(
  !relaxAroundBlock.some((s) => s.artist === 'A'),
  'a blocked artist must not come back through the recentArtists relaxation',
);

// And when the blocked artist is ALL there is, the filter returns nothing
// instead of relaxing. Empty is the honest answer — the caller (dj-agent's
// artist guard) reads it as "the pool has no alternative either" and only then
// allows the repeat.
const everythingBlocked = filterPickerCandidates(
  [{ id: 'a-1', title: 'One', artist: 'A' }, { id: 'a-2', title: 'Two', artist: 'A' }],
  { blockedArtists: new Set(['a']) },
);
assert.equal(everythingBlocked.length, 0, 'a hard artist block must never relax, even into an empty pool');

// Case/whitespace are normalised the same way artistKey() normalises a
// candidate, so a block built from a track's raw `artist` string still bites.
const casedBlock = filterPickerCandidates(
  [{ id: 'x', title: 'T', artist: '  Faith No More ' }],
  { blockedArtists: new Set(['faith no more']) },
);
assert.equal(casedBlock.length, 0, 'blockedArtists must match on the normalised artist key');

// Default (no blockedArtists) leaves every other caller untouched.
assert.equal(
  filterPickerCandidates(songs, {}).length,
  songs.length,
  'an absent blockedArtists set must be a no-op',
);

// effectiveNoRepeatWindow clamp table (config N, library total) → effective N.
assert.equal(effectiveNoRepeatWindow(100, 1000), 100, '(100,1000) → 100');
assert.equal(effectiveNoRepeatWindow(100, 40), 15, '(100,40) → 15 (3/8 of library)');
assert.equal(effectiveNoRepeatWindow(100, 20), 0, '(100,20) → 0 (below the min-effective floor)');
assert.equal(effectiveNoRepeatWindow(0, 1000), 0, '(0,*) → 0 (disabled)');
assert.equal(effectiveNoRepeatWindow(100, null), 0, '(100,null) → 0 (unknown library)');
assert.equal(effectiveNoRepeatWindow(100, 0), 0, '(100,0) → 0 (empty library)');
assert.equal(effectiveNoRepeatWindow(50, 1000), 50, '(50,1000) → 50 (under the library ceiling)');

console.log('picker-recency regression checks passed');
