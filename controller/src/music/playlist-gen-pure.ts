// Pure helpers for the playlist builder (music/playlist-gen.ts), deliberately
// import-free: the unit-test seam (scripts/playlist-gen-pure.test.ts) and the
// deterministic fallback the engine drops to when embeddings are absent or the
// LLM curation call fails. Operates only on materialised PoolTrack rows.

export type ArcShape = 'flat' | 'build' | 'peak-then-cool' | 'wind-down';

export const ARC_SHAPES: ArcShape[] = ['flat', 'build', 'peak-then-cool', 'wind-down'];

// A candidate track inside the generation pool. Superset of what any single
// source returns; buildCandidatePool normalises everything into this shape.
export interface PoolTrack {
  id: string;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  albumId?: string | null;
  durationSec?: number | null;
  year?: number | string | null;
  genre?: string | null;
  moods?: string[];
  energy?: string | null;            // 'low' | 'medium' | 'high' | null
  bpm?: number | null;               // analyzer tempo; null = un-analysed
  instrumental?: boolean | null;     // true = no vocals, false = vocals, null = un-analysed
  // Relevance/similarity in [0..1]-ish; higher is better.
  score?: number;
  // Which sources contributed this row; also drives sync's "vibe-matched" gate.
  sources?: string[];
  // ISO date the track entered the library (library `taggedAt`); null when
  // unknown (Subsonic-only rows). Set by the sync engine only, and drives the
  // "new since last sync" gate.
  addedAt?: string | null;
}

// The lean shape returned to the builder UI.
export interface DraftTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationSec: number;
  year: number | null;
  genre: string | null;
  energy: string | null;
  moods: string[];
  instrumental: boolean | null;
}

// low 0, medium 1, high 2. Unknown sorts as medium so an un-analysed track
// isn't shoved to an arc extreme.
export function energyRank(energy: string | null | undefined): number {
  if (energy === 'low') return 0;
  if (energy === 'high') return 2;
  return 1;
}

// Merge duplicate ids across sources: max score, union of source tags,
// first-seen non-empty metadata per field. Stable in first-seen order.
export function dedupeById(tracks: PoolTrack[]): PoolTrack[] {
  const byId = new Map<string, PoolTrack>();
  for (const t of tracks) {
    if (!t || !t.id) continue;
    const existing = byId.get(t.id);
    if (!existing) {
      byId.set(t.id, { ...t, sources: t.sources ? [...t.sources] : [] });
      continue;
    }
    existing.score = Math.max(existing.score ?? 0, t.score ?? 0);
    for (const s of t.sources || []) {
      if (!existing.sources!.includes(s)) existing.sources!.push(s);
    }
    // Backfill any field the first-seen row left empty.
    for (const k of ['title', 'artist', 'album', 'albumId', 'durationSec', 'year', 'genre', 'energy'] as const) {
      if (existing[k] == null && t[k] != null) (existing as any)[k] = t[k];
    }
    if ((existing.moods == null || existing.moods.length === 0) && t.moods?.length) existing.moods = t.moods;
    if (existing.instrumental == null && t.instrumental != null) existing.instrumental = t.instrumental;
  }
  return [...byId.values()];
}

export function mergePools(pools: PoolTrack[][]): PoolTrack[] {
  return dedupeById(pools.flat());
}

// Highest-scoring `cap` rows; stable for equal scores, so source order breaks
// the tie.
export function capPool(tracks: PoolTrack[], cap: number): PoolTrack[] {
  if (cap <= 0 || tracks.length <= cap) return [...tracks];
  return tracks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (b.t.score ?? 0) - (a.t.score ?? 0) || a.i - b.i)
    .slice(0, cap)
    .map((x) => x.t);
}

const artistKey = (t: PoolTrack) => (t.artist || '').trim().toLowerCase();

// Keep at most `maxPerArtist` of any one artist (highest-scoring first), so one
// prolific artist can't flood the candidate list. Blank artists are never
// capped. Preserves input order for kept rows.
export function capPerArtist(tracks: PoolTrack[], maxPerArtist: number): PoolTrack[] {
  if (maxPerArtist <= 0) return [...tracks];
  const order = tracks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (b.t.score ?? 0) - (a.t.score ?? 0) || a.i - b.i);
  const counts = new Map<string, number>();
  const keep = new Set<number>();
  for (const { t, i } of order) {
    const k = artistKey(t);
    if (k === '') { keep.add(i); continue; }
    const c = counts.get(k) ?? 0;
    if (c < maxPerArtist) { keep.add(i); counts.set(k, c + 1); }
  }
  return tracks.filter((_, i) => keep.has(i));
}

// Select `targetCount` tracks favouring score, but keeping the same artist
// `minGap` apart DURING selection rather than reordering after — that is what
// stops a single-artist run when one artist owns the top scores. Relaxes only
// when every remaining candidate clashes.
export function selectByScoreWithSpacing(
  pool: PoolTrack[],
  targetCount: number,
  minGap: number,
): PoolTrack[] {
  const sorted = pool
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (b.t.score ?? 0) - (a.t.score ?? 0) || a.i - b.i)
    .map((x) => x.t);
  if (minGap <= 0) return sorted.slice(0, Math.max(0, targetCount));
  const remaining = [...sorted];
  const picked: PoolTrack[] = [];
  const limit = Math.max(0, targetCount);
  while (picked.length < limit && remaining.length) {
    const recent = new Set(picked.slice(-minGap).map(artistKey));
    let idx = remaining.findIndex((t) => !recent.has(artistKey(t)) || artistKey(t) === '');
    if (idx === -1) idx = 0; // every remaining candidate clashes — relax
    picked.push(remaining.splice(idx, 1)[0]!);
  }
  return picked;
}

// Order a set to trace an energy arc. `flat` keeps the incoming relevance
// order; peak-then-cool puts lowest energy at both ends, highest in the middle.
export function arrangeArc(tracks: PoolTrack[], arc: ArcShape): PoolTrack[] {
  if (arc === 'flat' || tracks.length < 3) return [...tracks];
  const asc = [...tracks]
    .map((t, i) => ({ t, i }))
    .sort((a, b) => energyRank(a.t.energy) - energyRank(b.t.energy) || a.i - b.i)
    .map((x) => x.t);
  if (arc === 'build') return asc;
  if (arc === 'wind-down') return asc.reverse();
  // peak-then-cool: place ascending-energy tracks alternately at the outside
  // edges, working inward.
  const n = asc.length;
  const res: PoolTrack[] = new Array(n);
  let lo = 0;
  let hi = n - 1;
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) res[lo++] = asc[i]!;
    else res[hi--] = asc[i]!;
  }
  return res;
}

// Reorder so the same artist is at least `minGap` apart, disturbing the input
// order as little as possible. Greedy and deterministic.
export function spaceArtists(tracks: PoolTrack[], minGap: number): PoolTrack[] {
  if (minGap <= 0 || tracks.length < 2) return [...tracks];
  const pending = [...tracks];
  const result: PoolTrack[] = [];
  while (pending.length) {
    const recent = new Set(result.slice(-minGap).map(artistKey));
    let idx = pending.findIndex((t) => !recent.has(artistKey(t)) || artistKey(t) === '');
    if (idx === -1) idx = 0; // every remaining candidate clashes — relax
    result.push(pending.splice(idx, 1)[0]!);
  }
  return result;
}

// The no-LLM fallback, used when the djObject curation call fails or times out.
// Never returns empty when the pool is non-empty. Order matters: select with
// artist diversity FIRST, then arrange the arc, then a final spacing pass to
// clean up adjacency the arc re-introduced.
export function pickDeterministic(
  pool: PoolTrack[],
  opts: { targetCount: number; energyArc: ArcShape; artistSpacing: number },
): PoolTrack[] {
  const chosen = selectByScoreWithSpacing(pool, Math.max(1, opts.targetCount), opts.artistSpacing);
  const arced = arrangeArc(chosen, opts.energyArc);
  return spaceArtists(arced, opts.artistSpacing);
}

// Resolve an LLM-returned id list against the pool: map to real rows, drop
// unknown/hallucinated ids, dedupe while preserving the model's chosen order.
export function orderByIds(ids: string[], pool: PoolTrack[]): PoolTrack[] {
  const byId = new Map(pool.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const out: PoolTrack[] = [];
  for (const id of ids) {
    if (typeof id !== 'string') continue;
    const t = byId.get(id);
    if (!t || seen.has(id)) continue;
    seen.add(id);
    out.push(t);
  }
  return out;
}

// Trim/pad a curated selection to the target length: top up from the remaining
// pool (highest score first), or keep the model's leading choices.
export function fitToCount(
  selected: PoolTrack[],
  pool: PoolTrack[],
  targetCount: number,
): PoolTrack[] {
  if (targetCount <= 0) return selected;
  if (selected.length >= targetCount) return selected.slice(0, targetCount);
  const chosen = new Set(selected.map((t) => t.id));
  const filler = capPool(pool.filter((t) => !chosen.has(t.id)), targetCount - selected.length);
  return [...selected, ...filler];
}

// Recipe band filters, soft: a KNOWN value outside the band drops the row, an
// unknown one (null/<=0) keeps it, since a partly-un-analysed library must still
// fill. Callers wrap these in revertIfStarved for the relax path.
//
// This is NOT the station's minimum-track-length floor (#1573,
// music/track-floor.ts): it is the Playlist Builder's own recipe band, applied
// to a generated playlist rather than a pick. Both must keep agreeing that an
// unknown length passes. A third copy of "is this track too short?" belongs in
// track-floor.ts, not here.
export function filterByDurationBand(pool: PoolTrack[], minSec: number, maxSec: number): PoolTrack[] {
  if (!minSec && !maxSec) return [...pool];
  return pool.filter((t) => {
    const d = typeof t.durationSec === 'number' && t.durationSec > 0 ? t.durationSec : null;
    if (d == null) return true;
    return (!minSec || d >= minSec) && (!maxSec || d <= maxSec);
  });
}

export function filterByBpmBand(pool: PoolTrack[], minBpm: number, maxBpm: number): PoolTrack[] {
  if (!minBpm && !maxBpm) return [...pool];
  return pool.filter((t) => {
    const b = typeof t.bpm === 'number' && t.bpm > 0 ? t.bpm : null;
    if (b == null) return true;
    return (!minBpm || b >= minBpm) && (!maxBpm || b <= maxBpm);
  });
}

// Artist allow-list: keep tracks whose credit mentions ANY chosen name,
// case-insensitively, so "A & B" and "A feat. C" both count for A. A blank
// credit drops. Empty list = identity.
export function filterByArtists(pool: PoolTrack[], artists: string[]): PoolTrack[] {
  const wanted = artists.map((a) => a.trim().toLowerCase()).filter(Boolean);
  if (!wanted.length) return [...pool];
  return pool.filter((t) => {
    const credit = (t.artist || '').toLowerCase();
    return credit !== '' && wanted.some((w) => credit.includes(w));
  });
}

// Running total in seconds, for the builder's live tape counter.
export function totalDurationSec(tracks: Array<{ durationSec?: number | null }>): number {
  return tracks.reduce((sum, t) => sum + (t.durationSec ?? 0), 0);
}

const VIBE_SOURCES = new Set(['theme', 'sound', 'seed', 'seed-similar']);

// Append-only sync selection: which tracks to ADD to a synced playlist. A
// candidate qualifies iff it is not already a member, has a valid addedAt
// strictly after `sinceIso` (an unknown add-date never qualifies), and — when
// the recipe has a prompt — came from a vibe source. Returns the highest-scoring
// `cap` qualifiers.
export function selectAppendable(
  pool: PoolTrack[],
  opts: { sinceIso: string | null; requireVibe: boolean; cap: number; excludeIds?: Set<string> },
): PoolTrack[] {
  const exclude = opts.excludeIds ?? new Set<string>();
  const since = opts.sinceIso ? Date.parse(opts.sinceIso) : NaN;
  const kept = pool.filter((t) => {
    if (!t.id || exclude.has(t.id)) return false;
    const added = t.addedAt ? Date.parse(t.addedAt) : NaN;
    if (!Number.isFinite(added)) return false;               // unknown add-date → never blind-append
    if (Number.isFinite(since) && added <= since) return false; // not new since the cutoff
    if (opts.requireVibe && !(t.sources || []).some((s) => VIBE_SOURCES.has(s))) return false;
    return true;
  });
  return capPool(kept, Math.max(0, opts.cap));
}
