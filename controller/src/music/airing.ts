// Airing-memory policy: how the pickers weigh "when did this last go to air".
// A soft RANKING signal only, never a hard filter, so it cannot starve a pool.
// The memoised DB index lives in music/library.ts (lastAiredInfo).

import { trackKey, type CandidateLike } from './recency.js';

// Freshness-ramp horizon. Far beyond every recency window, so this signal never
// fights the short guards.
export const AIRING_FRESH_DAYS = 14;

// Weight of the freshness term against the Math.random() base in [0,1).
// Randomness stays dominant, so a fully-aired pool still shuffles.
export const AIRING_RANK_WEIGHT = 0.4;

// The deepCuts tool's window: never aired, or unaired for this many days.
export const DEEP_CUT_DAYS = 30;

// ε-greedy seed break: fraction of agent picks steered at the unaired shelf
// (deepCuts) instead of the on-air track's neighbourhood.
export const EXPLORE_SEED_PROBABILITY = 0.25;

export interface AiredIndex {
  byId: Map<string, number>;
  byKey: Map<string, number>;
  playStatsById?: Map<string, { count: number; lastPlayedAtMs: number }>;
  playStatsByKey?: Map<string, { count: number; lastPlayedAtMs: number }>;
}

export const EMPTY_AIRED_INDEX: AiredIndex = { byId: new Map(), byKey: new Map() };

// Last aired, epoch ms; null = never or unknown. Id first, then the
// "title|artist" key, so a duplicate rip doesn't read as never-aired.
export function lastAiredMsOf(song: CandidateLike, index: AiredIndex): number | null {
  if (song?.id != null) {
    const at = index.byId.get(song.id);
    if (at != null) return at;
  }
  if (song?.title) {
    const at = index.byKey.get(trackKey(song));
    if (at != null) return at;
  }
  return null;
}

// Empty means either lastAiredInfo() failed or the station never aired anything.
export function hasAiringHistory(index: AiredIndex): boolean {
  return index.byId.size > 0 || index.byKey.size > 0;
}

// true only when the station provably never aired this track; undefined when the
// question can't be answered (off an empty index every candidate would flag).
// Callers' spread drops undefined.
export function unairedFlag(song: CandidateLike, index: AiredIndex): true | undefined {
  if (!hasAiringHistory(index)) return undefined;
  return lastAiredMsOf(song, index) == null ? true : undefined;
}

// 0..1: 0 = just aired, 1 = never aired or past the horizon. Linear ramp, no
// cliff at the boundary.
export function freshness(lastAiredMs: number | null | undefined, nowMs: number): number {
  if (lastAiredMs == null) return 1;
  const horizonMs = AIRING_FRESH_DAYS * 24 * 60 * 60 * 1000;
  const age = nowMs - lastAiredMs;
  if (age <= 0) return 0;
  return Math.min(1, age / horizonMs);
}

// Freshness-biased shuffle: random base + weighted freshness, descending, so a
// later cap keeps unaired tracks more often without excluding aired ones.
export function freshnessBiasedOrder<T extends CandidateLike>(
  list: T[],
  index: AiredIndex,
  nowMs: number,
): T[] {
  return list
    .map((t) => ({ t, score: Math.random() + AIRING_RANK_WEIGHT * freshness(lastAiredMsOf(t, index), nowMs) }))
    .sort((a, b) => b.score - a.score)
    .map((s) => s.t);
}
