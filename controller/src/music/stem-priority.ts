// Stem priority multiplies seam eligibility (zero, one, or two measured bar grids) by airplay
// and curation value. Operator hearts outrank listener likes. Random ties give unplayed tracks
// another chance; stems_at records attempts for resumption. Keep JS and SQL scores as equal
// integers. #1622 FR 14, scripts/stem-priority.test.ts.
export const STEM_PRIORITY_WEIGHTS = {
  // Every blendable track's floor. Non-zero so the seam multiplier orders the
  // untouched majority (2 * 100 vs 1 * 100) on a library with no play history
  // at all — a fresh station must still rank, not collapse to random.
  base: 100,
  // Operator heart from the admin library. Above every listener signal and
  // above a lightly-aired track, below a heavily-aired one: curation outranks
  // a listener like, it does not outrank the station's own evidence.
  operatorHeart: 150,
  listenerLike: 60,
  // Airplay inside RECENT_PLAY_WINDOW_DAYS, saturating: the tenth play in a
  // quarter says nothing the fifth did not, and an uncapped count would let
  // one heavy-rotation track dwarf the whole curation half.
  perRecentPlay: 20,
  recentPlayCap: 10,
  // Aired inside HOT_PLAY_WINDOW_DAYS — in rotation for whatever show/mood is
  // live now, which is exactly the track the next seam is likely to reach.
  airedRecently: 80,
  // Ever aired at all, however long ago. Small, and its job is only to lift a
  // track the station has actually played above one it never has.
  everAired: 40,
} as const;

export const RECENT_PLAY_WINDOW_DAYS = 90;
export const HOT_PLAY_WINDOW_DAYS = 7;

// The largest value half a track can reach — used by the tests to pin that the
// seam multiplier is a multiplier and not a tier that value can jump.
export const MAX_VALUE_SCORE =
  STEM_PRIORITY_WEIGHTS.base +
  STEM_PRIORITY_WEIGHTS.operatorHeart +
  STEM_PRIORITY_WEIGHTS.listenerLike +
  STEM_PRIORITY_WEIGHTS.perRecentPlay * STEM_PRIORITY_WEIGHTS.recentPlayCap +
  STEM_PRIORITY_WEIGHTS.airedRecently +
  STEM_PRIORITY_WEIGHTS.everAired;

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export interface StemPriorityFacts {
  // bars_json is a non-empty array — the track can be a seam's INCOMING side.
  hasHeadGrid: boolean;
  // outro_json carries a non-empty bar grid AND a duration — OUTGOING side.
  hasTailGrid: boolean;
  // Airings inside RECENT_PLAY_WINDOW_DAYS.
  recentPlays: number;
  // Aired at least once, ever.
  everAired: boolean;
  // Aired inside HOT_PLAY_WINDOW_DAYS.
  airedRecently: boolean;
  operatorHeart: boolean;
  listenerLiked: boolean;
}

// How many sides of a rendered seam this track's stems could serve: 0, 1 or 2.
export function seamSides(f: Pick<StemPriorityFacts, 'hasHeadGrid' | 'hasTailGrid'>): number {
  return (f.hasHeadGrid ? 1 : 0) + (f.hasTailGrid ? 1 : 0);
}

// The ranking. Higher scans (and survives a sweep) first.
export function stemPriority(f: StemPriorityFacts): number {
  const W = STEM_PRIORITY_WEIGHTS;
  const plays = Math.min(Math.max(0, Math.trunc(f.recentPlays || 0)), W.recentPlayCap);
  const value =
    W.base +
    (f.operatorHeart ? W.operatorHeart : 0) +
    (f.listenerLiked ? W.listenerLike : 0) +
    W.perRecentPlay * plays +
    (f.airedRecently ? W.airedRecently : 0) +
    (f.everAired ? W.everAired : 0);
  // Multiplied, never added: zero sides is zero worth, whatever else is true.
  return seamSides(f) * value;
}

// The two play-window cutoffs, as ISO strings. `plays.played_at` is always
// `Date.toISOString()` output, so a lexicographic `>=` against these IS a
// chronological comparison — the same trick `deepCutTracks` uses, and the
// reason nothing here has to parse a date inside SQLite.
export function stemPriorityWindows(nowMs: number): { recentSince: string; hotSince: string } {
  const day = 86_400_000;
  return {
    recentSince: new Date(nowMs - RECENT_PLAY_WINDOW_DAYS * day).toISOString(),
    hotSince: new Date(nowMs - HOT_PLAY_WINDOW_DAYS * day).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

// A cached dir whose track has no library row at all — pruned from Navidrome,
// or written under an id the catalogue no longer knows. Below zero, because
// zero is "a real track that can never blend" and this is not even that.
export const UNKNOWN_TRACK_PRIORITY = -1;

export interface StemCacheDir {
  dir: string;
  mtimeMs: number;
  // null when the priority could not be resolved AT ALL (the library DB was
  // closed or the query threw). Not the same as UNKNOWN_TRACK_PRIORITY: this
  // means "no answer", and an all-null input degrades to plain mtime LRU,
  // i.e. exactly the pre-#1622 sweep.
  priority: number | null;
}

// Evict lowest priority first, then oldest mtime. Ranking writes the best stems earliest, so
// mtime-only eviction would remove them first; missing priorities retain the previous mtime
// order.
export function stemEvictionOrder<T extends StemCacheDir>(dirs: readonly T[]): T[] {
  return [...dirs].sort(
    (a, b) =>
      (a.priority ?? UNKNOWN_TRACK_PRIORITY) - (b.priority ?? UNKNOWN_TRACK_PRIORITY) ||
      a.mtimeMs - b.mtimeMs,
  );
}
