// Stem scan-order and retention policy (#1622 FR 14).
//
// The stem cache is bound by bytes, not by library size: on a 55k-track
// library `stem-cache.headroomTracks()` allows a few thousand slots at the
// default 15 GB budget and the backfill stands down at zero. So the budget
// ALWAYS binds, and *which* tracks get a stem pass is the entire feature.
// Until this module it was `ORDER BY id` over Navidrome's opaque hashes —
// i.e. chance.
//
// This file is the ranking rule, kept pure and away from the query that
// applies it. `library-db/stem-scan.ts` holds the SQL, built from the same
// constants and pinned row-for-row against `stemPriority()` by
// scripts/stem-priority.test.ts — the era-filter discipline, because a JS
// scorer and a SQL scorer that disagree pick different tracks and nothing
// says so.
//
// ---------------------------------------------------------------------------
// What the score is FOR
// ---------------------------------------------------------------------------
//
// Stems have exactly one consumer: `broadcast/stem-blend.ts` renders a seam
// from the OUTGOING track's tail stems and the INCOMING track's head stems.
// Read its gates before changing a weight here — they are what the signals
// below are derived from, not a guess about what stems "might" be worth:
//
//   * `!out.outro?.bars?.length || !out.durationSec` → no blend. A track with
//     no measured tail bar grid can never be the outgoing side.
//   * `!inn.bars?.length` → no blend. No head bar grid, never the incoming side.
//   * everything else (bpm compatibility, the render deadline, the trim
//     vetoes) is a property of the PAIR or of the moment, not of the track,
//     so it cannot be ranked here.
//
// That makes the bar grids a HARD eligibility fact rather than a preference:
// stems written for a track with neither grid are bytes the only consumer is
// guaranteed to reject. They enter the score as a MULTIPLIER (0, 1 or 2 —
// "how many sides of a seam can this track serve"), so a grid-less track is
// worth zero however loved it is, while a one-sided track can still be lifted
// past the untouched majority by real airplay or curation. Tiers that merely
// ADD would have let a grid-less favourite outrank a blendable track; tiers
// that merely GATE would have sealed the one-grid class off from curation.
//
// The value half is "will this track actually turn up at a seam": recent
// airplay, then curation. Operator hearts outrank listener likes, and neither
// is windowed here — the station-wide rule is that operator curation outranks
// listener signal.
//
// ---------------------------------------------------------------------------
// Why nothing is starved
// ---------------------------------------------------------------------------
//
// The failure mode of any ranking over a scope larger than the budget is a
// tail that is never even considered. Three things close it:
//
//   1. The untouched majority of a real library ties EXACTLY (both grids, no
//      plays, no likes → `2 * base`), and the tie is broken by `RANDOM()`, not
//      by id. A frozen id order is what made the old behaviour a lottery
//      nobody could win twice; a fresh draw per pass gives every track in the
//      tie class a chance on every pass. (`plays.deepCutTracks` samples the
//      same way for the same reason.)
//   2. No class is sealed. A one-grid track with an operator heart scores
//      above a both-grid track with no signal at all, so airplay and curation
//      move tracks across the class line rather than re-sorting within it.
//   3. `stems_at` stamps the ATTEMPT, so a scanned track leaves the scope for
//      good and every pass makes progress. Resumption is the stamp's job, not
//      the order's — which is what lets the order be random at all.
//
// A grid-less track scoring zero is deliberate and is NOT the starvation this
// guards against: it is the consumer's own eligibility gate, read forward. Give
// it a bar grid (a re-analysis on a newer ANALYSIS_VERSION) and it ranks.

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

// All integers, and the play term is a per-play increment rather than a
// fraction of a maximum, so the JS score and the SQL score are the same
// integer with no float comparison anywhere.
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

// Eviction order for the byte-budget sweep — first out first.
//
// This has to change WITH the scan order, not after it. The scan writes the
// best tracks first, so they carry the OLDEST mtimes; a sweep that kept
// evicting oldest-first would delete precisely the stems the ranking just
// worked to earn, and `stems_at` stamps the attempt so they would never be
// written again. Priority ascending fixes the inversion; mtime ascending stays
// as the tiebreak, which keeps the old "a re-analysis refreshes a dir's slot"
// behaviour inside every tie — including the all-unknown case, where this is
// byte-for-byte the previous sort.
export function stemEvictionOrder<T extends StemCacheDir>(dirs: readonly T[]): T[] {
  return [...dirs].sort(
    (a, b) =>
      (a.priority ?? UNKNOWN_TRACK_PRIORITY) - (b.priority ?? UNKNOWN_TRACK_PRIORITY) ||
      a.mtimeMs - b.mtimeMs,
  );
}
