// Airing-memory policy — how the pickers weigh "when did this last go to air".
//
// The plays table (library-db/plays.ts) durably records every airing, but
// nothing on a picking path ever read it: a track unaired for two years and one
// aired yesterday had identical draw probability in every sampled source, which
// is a big part of why a 10k+ library keeps circulating the same bubble. These
// helpers turn that history into a soft RANKING signal — never a hard filter,
// so they cannot starve a pool — plus the deep-cut window the deepCuts
// discovery tool samples from.
//
// Pure functions only (unit-pinned by scripts/airing.test.ts); the memoised
// index lookup over the DB lives in music/library.ts (lastAiredInfo).

import { trackKey, type CandidateLike } from './recency.js';

// A track unaired for this long counts as fully fresh — the freshness ramp's
// horizon. Two weeks is far beyond every recency window (12h track / 100-play
// hard guard), so this signal only separates "in rotation" from "forgotten",
// never fights the short-horizon guards.
export const AIRING_FRESH_DAYS = 14;

// Weight of the freshness term against the Math.random() base in [0,1) used by
// both soft rankings (picker.softRankByCompat, scope.collect). Comparable to
// the tempo/key compat bonus (0.4 bpm + 0.3 key) — enough to systematically
// favour unaired material through a downstream cap, never enough to pin the
// order: randomness stays dominant, so a fully-aired pool still shuffles.
export const AIRING_RANK_WEIGHT = 0.4;

// The deepCuts tool's window: never aired, or unaired for this many days.
export const DEEP_CUT_DAYS = 30;

// ε-greedy seed break: the fraction of agent picks whose event message steers
// the discovery round toward the unaired shelf (the deepCuts tool) instead of
// the on-air track's neighbourhood. Every pick seeding from the current track
// is a random walk that never leaves its cluster; one pick in four pointed at
// the shelf is the walk's exit, while three in four keep the flow-first
// character intact.
export const EXPLORE_SEED_PROBABILITY = 0.25;

export interface AiredIndex {
  byId: Map<string, number>;
  byKey: Map<string, number>;
  playStatsById?: Map<string, { count: number; lastPlayedAtMs: number }>;
  playStatsByKey?: Map<string, { count: number; lastPlayedAtMs: number }>;
}

export const EMPTY_AIRED_INDEX: AiredIndex = { byId: new Map(), byKey: new Map() };

// When this candidate last aired, in epoch ms — null = never (or unknown).
// The id is checked first, then the "title|artist" key, so a duplicate copy of
// an aired song doesn't read as never-aired.
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

// Whether this index carries any airing history at all. An EMPTY index is what
// library.lastAiredInfo() returns on BOTH of its failure paths — an unloaded
// library, and a thrown DB read (a locked handle during a tagger checkpoint,
// WAL contention, a handle swap mid-pick) — and it is also what a station that
// has genuinely never aired anything looks like.
export function hasAiringHistory(index: AiredIndex): boolean {
  return index.byId.size > 0 || index.byKey.size > 0;
}

// The `unaired` flag the pickers publish to the model: true when the station
// has provably never aired this track, undefined when the question can't be
// answered. It is deliberately NOT `lastAiredMsOf(...) == null`.
//
// PICKER_CRITERIA's VARIETY rule tells the model to prefer an unaired candidate
// over a familiar staple, so the flag has to mean something. Read off an empty
// index every candidate carries it, and the signal degrades to a uniform lie
// rather than to absent: on the failure paths above the model is told to prefer
// all 18 equally, and on a station with no history yet the flag is true of the
// whole library, which discriminates nothing while costing tokens on every
// candidate. Both cases want the field OMITTED, and undefined is what the
// callers' `...(unaired ? {unaired: true} : {})` spread already drops.
export function unairedFlag(song: CandidateLike, index: AiredIndex): true | undefined {
  if (!hasAiringHistory(index)) return undefined;
  return lastAiredMsOf(song, index) == null ? true : undefined;
}

// 0..1 freshness: 0 = just aired, 1 = never aired or past the horizon. A
// linear ramp, so "aired last week" sits between "aired today" and "never
// aired" instead of cliffing at the boundary.
export function freshness(lastAiredMs: number | null | undefined, nowMs: number): number {
  if (lastAiredMs == null) return 1;
  const horizonMs = AIRING_FRESH_DAYS * 24 * 60 * 60 * 1000;
  const age = nowMs - lastAiredMs;
  if (age <= 0) return 0;
  return Math.min(1, age / horizonMs);
}

// Freshness-biased shuffle: random base + weighted freshness, descending — the
// exploration counterpart to softRankByCompat's compat bonus. Callers that cap
// the list afterwards (collect's 8, the pool's 18) get unaired tracks
// surviving the cap more often, while aired ones still can.
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
