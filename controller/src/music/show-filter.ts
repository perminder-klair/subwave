// Shared show-music filter helpers — one source of truth for "does this track
// fit the show's genre / era constraint?", used by BOTH pick paths: the
// stateless pool picker (music/picker.ts) and the conversational agent's
// discovery tools (llm/internal/tools/picker-tools.ts). Keeping them here stops
// the two paths from drifting on what "in-genre" / "in-era" means.
//
// Multi-value semantics (#929): every filter takes a LIST of values — a track
// matches the attribute when it matches ANY entry (OR within the attribute);
// the pick paths then AND the attributes together. Every entry is weighted
// equally. An empty list means "no constraint" and passes everything through.

import * as library from './library.js';

// The narrow track shape the show filters read: raw Subsonic children and
// slimTrack library rows both satisfy it structurally. Every field is optional
// so a source that omits one (e.g. Subsonic tracks carry no energy band) still
// passes through. The array filters are generic over T extends FilterTrack so
// they return the caller's own element type unchanged.
export interface FilterTrack {
  id?: string;
  genre?: string | null;
  year?: number | string | null;
  // Original-release-year surface (issue #842). Library-sourced tracks carry
  // both; raw Subsonic children carry neither (undefined ≠ "not a comp") and
  // fall back to a library lookup in trackEraYear.
  originalYear?: number | null;
  isCompilation?: boolean | null;
  energy?: string | null;
  moods?: string[] | null;
  audioMoods?: string[] | null;
}

// ── Genre ──────────────────────────────────────────────────────────────────

// Normalised genre token for fuzzy comparison — mirrors subsonic.resolveGenreName
// so the show's resolved tag and a track's tag compare the same way.
export function normGenre(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Per-track genre — from the track itself (Subsonic + slimTrack library sources
// both carry it) or a library lookup. null when the track has no genre tag.
export function trackGenre(t: FilterTrack | null | undefined): string | null {
  if (t?.genre) return t.genre;
  const rec = t?.id ? library.get(t.id) : null;
  return rec?.genre ?? null;
}

// True when a track's genre matches ANY of the (already normalised) target
// genres. Exact-normalised match, or substring either way — same shape as
// subsonic.resolveGenreName, so "Hip-Hop" matches a "Hip Hop" tag etc.
export function genreMatches(t: FilterTrack | null | undefined, targetNorms: string[]): boolean {
  if (!targetNorms.length) return false;
  const g = trackGenre(t);
  if (!g) return false;
  const gn = normGenre(g);
  if (!gn) return false;
  return targetNorms.some(target => !!target && (gn === target || gn.includes(target) || target.includes(gn)));
}

// Hard-prefer tracks matching ANY of the show's genres (strict mode). Unlike
// the soft energy/year leans, an untagged or off-genre track does NOT stay
// eligible — the whole point of strict is a genre-pure pool. But it FALLS BACK
// to the unfiltered set when no track matches, so a thin genre degrades to
// off-genre rather than emptying the source (never-starve, mirrors preferEra).
export function preferGenre<T extends FilterTrack>(tracks: T[], genreNames?: string[] | null): T[] {
  const targets = (genreNames ?? []).map(normGenre).filter(Boolean);
  if (!targets.length) return tracks;
  const match = tracks.filter((t) => genreMatches(t, targets));
  return match.length ? match : tracks;
}

// Hard genre filter — NO never-starve: off-genre (and untagged) tracks drop
// even when that empties the list. For call sites that guarantee
// non-starvation at a WIDER scope than one source: the agent tools starve
// per-tool and rely on the pool fallback; the pool picker never-starves on the
// final merged pool. The per-source never-starve in prefer* is what let strict
// shows leak off-filter tracks whenever a single source had zero matches.
export function onlyGenre<T extends FilterTrack>(tracks: T[], genreNames?: string[] | null): T[] {
  const targets = (genreNames ?? []).map(normGenre).filter(Boolean);
  if (!targets.length) return tracks;
  return tracks.filter((t) => genreMatches(t, targets));
}

// ── Era (decade / year windows) ──────────────────────────────────────────────

export type YearRange = { fromYear?: number | null; toYear?: number | null };

// True when the list carries at least one real bound — the "is there an era
// constraint at all?" test shared by the pick paths.
export function hasEraBound(eras?: YearRange[] | null): boolean {
  return !!eras?.some(e => e && (e.fromYear != null || e.toYear != null));
}

// Coarse single-window envelope over a set of era windows, for APIs that take
// one contiguous fromYear/toYear pair (Subsonic getRandomSongs). A missing
// bound on ANY window leaves that side open (null) — the envelope must never
// exclude a track an individual window would admit. Exact union membership is
// enforced by inYearRange afterwards.
export function eraSpan(eras?: YearRange[] | null): { fromYear: number | null; toYear: number | null } {
  let fromYear: number | null = null;
  let toYear: number | null = null;
  let openFrom = false;
  let openTo = false;
  for (const e of eras ?? []) {
    if (!e || (e.fromYear == null && e.toYear == null)) continue;
    if (e.fromYear == null) openFrom = true;
    else fromYear = fromYear == null ? e.fromYear : Math.min(fromYear, e.fromYear);
    if (e.toYear == null) openTo = true;
    else toYear = toYear == null ? e.toYear : Math.max(toYear, e.toYear);
  }
  return { fromYear: openFrom ? null : fromYear, toYear: openTo ? null : toYear };
}

function inAnyWindow(year: number, eras: YearRange[]): boolean {
  return eras.some(e => {
    if (!e || (e.fromYear == null && e.toYear == null)) return false;
    if (e.fromYear != null && year < e.fromYear) return false;
    if (e.toYear != null && year > e.toYear) return false;
    return true;
  });
}

// The year a track's ERA is judged by (issue #842). Precedence: the resolved
// original release year (walk-time album tag or MusicBrainz enrichment) wins;
// a plain `year` only counts when the track is NOT on a compilation album —
// a compilation's year is the compilation's own release date ("100 Hits: 70s
// Chartbusters" is 2013), so trusting it both mis-includes the track in the
// wrong era and misses it in the right one. Returns null for "unknown".
//
// Junk-year guard shared by both fields: Number(null)/Number('') are 0, and
// some taggers write TYER=0000 → a literal 0 — either would sail through a
// window with an open lower bound ("1989 and earlier": 0 <= 1989). A real
// recording year is always > 0, so null / '' / non-finite / non-positive all
// read as unknown.
export function resolveEraYear(
  year: number | string | null | undefined,
  originalYear: number | null | undefined,
  isCompilation: boolean | null | undefined,
): number | null {
  const oy = Number(originalYear);
  if (Number.isFinite(oy) && oy > 0) return oy;
  if (isCompilation) return null;
  const y = Number(year);
  return Number.isFinite(y) && y > 0 ? y : null;
}

// Per-track era year — from the track's own fields when the source carries
// them (library slimTrack rows do), else a light library lookup (Subsonic
// children carry a bare `year` only, and undefined isn't "not a compilation").
// Off-library tracks fall back to the plain year, today's behaviour.
export function trackEraYear(t: FilterTrack | null | undefined): number | null {
  if (t && (t.originalYear !== undefined || t.isCompilation !== undefined)) {
    return resolveEraYear(t.year, t.originalYear, t.isCompilation);
  }
  const rec = t?.id ? library.getPlaybackMeta(t.id) : null;
  if (rec) return resolveEraYear(rec.year ?? t?.year, rec.originalYear, rec.isCompilation);
  return resolveEraYear(t?.year, null, null);
}

// Hard-filter to tracks inside ANY of the era windows. Unknown-year tracks are
// treated as out-of-range (dropped) — including compilation-album tracks whose
// original year hasn't been resolved yet (see trackEraYear). Callers that must
// not starve should use preferEra (or fall back to the full set themselves).
export function inYearRange<T extends FilterTrack>(tracks: T[], eras: YearRange[]): T[] {
  if (!hasEraBound(eras)) return tracks;
  return tracks.filter((t) => {
    const y = trackEraYear(t);
    return y != null && inAnyWindow(y, eras);
  });
}

// Never-starve era filter: in-range tracks first, falling back to the full set
// when nothing is in range, so a thin era degrades to off-era rather than
// emptying the source. Mirrors preferGenre's contract.
export function preferEra<T extends FilterTrack>(tracks: T[], eras?: YearRange[] | null): T[] {
  if (!hasEraBound(eras)) return tracks;
  const match = inYearRange(tracks, eras!);
  return match.length ? match : tracks;
}

// ── Energy bands ─────────────────────────────────────────────────────────────

// Per-track energy band — from the track itself (library sources carry it) or a
// library lookup (Subsonic sources don't). null when un-analysed.
export function trackEnergy(t: FilterTrack | null | undefined): string | null {
  if (t?.energy) return t.energy;
  const rec = t?.id ? library.get(t.id) : null;
  return rec?.energy ?? null;
}

// Soft-prefer tracks matching ANY of the show's energy bands; unknown-energy
// tracks stay eligible. Falls back to the full set when no track matches
// (never-starve, mirrors preferEra). This is the soft-lean path; strict shows
// (show.filtersStrict) use preferEnergyStrict below.
export function preferEnergy<T extends FilterTrack>(tracks: T[], energies?: string[] | null): T[] {
  if (!energies?.length) return tracks;
  const match = tracks.filter((t) => {
    const e = trackEnergy(t);
    return e == null || energies.includes(e);
  });
  return match.length ? match : tracks;
}

// Strict energy filter (show.filtersStrict): only tracks whose analysed energy
// band matches an entry survive — unknown-energy tracks are dropped too, that's
// the point of strict. Never-starve: an un-analysed library (everything
// unknown) falls back to the full set rather than emptying the source.
export function preferEnergyStrict<T extends FilterTrack>(tracks: T[], energies?: string[] | null): T[] {
  if (!energies?.length) return tracks;
  const match = tracks.filter((t) => {
    const e = trackEnergy(t);
    return e != null && energies.includes(e);
  });
  return match.length ? match : tracks;
}

// ── Moods ────────────────────────────────────────────────────────────────────

// Per-track mood tags — from the track itself (library sources carry them) or a
// library lookup (Subsonic sources don't). Empty when un-tagged. Unions the
// editorial LLM moods with the zero-shot audio moods (sound-derived —
// music/audio-moods.ts), matching the blend songsByMood applies at retrieval,
// so a track surfaced via its audio mood isn't filtered back out here.
export function trackMoods(t: FilterTrack | null | undefined): string[] {
  const rec = Array.isArray(t?.moods) && Array.isArray(t?.audioMoods)
    ? t
    : (t?.id ? library.get(t.id) : null) ?? t;
  const moods = Array.isArray(rec?.moods) ? rec.moods : [];
  const audio = Array.isArray(rec?.audioMoods) ? rec.audioMoods : [];
  return audio.length ? [...new Set([...moods, ...audio])] : moods;
}

// Strict mood filter (show.filtersStrict): only tracks tagged with ANY of the
// show's moods survive; un-tagged tracks are dropped. Never-starve: an
// un-tagged library falls back to the full set rather than emptying the
// source. Soft shows don't use this — their mood steering happens through the
// dominantMood-driven pool sources, not a per-track filter.
export function preferMood<T extends FilterTrack>(tracks: T[], moods?: string[] | null): T[] {
  if (!moods?.length) return tracks;
  const targets = moods.map(m => String(m).toLowerCase());
  const match = tracks.filter((t) => trackMoods(t).some((x) => targets.includes(String(x).toLowerCase())));
  return match.length ? match : tracks;
}

// Hard mood filter — NO never-starve (see onlyGenre for the scoping contract).
export function onlyMood<T extends FilterTrack>(tracks: T[], moods?: string[] | null): T[] {
  if (!moods?.length) return tracks;
  const targets = moods.map(m => String(m).toLowerCase());
  return tracks.filter((t) => trackMoods(t).some((x) => targets.includes(String(x).toLowerCase())));
}

// Hard energy filter — NO never-starve (see onlyGenre). Unknown-energy tracks
// drop too, same as preferEnergyStrict.
export function onlyEnergy<T extends FilterTrack>(tracks: T[], energies?: string[] | null): T[] {
  if (!energies?.length) return tracks;
  return tracks.filter((t) => {
    const e = trackEnergy(t);
    return e != null && energies.includes(e);
  });
}

// ── Strict lock composition ──────────────────────────────────────────────────

// A show's strict music constraints, resolved to library-comparable values:
// genres are the library's exact tags (the caller resolves free text via
// subsonic.resolveGenreName upstream — genre matching still normalises); eras /
// moods / energies are as the show declares them. Any dimension left
// empty/absent is "no constraint".
export type StrictLocks = {
  genres?: string[] | null;
  eras?: YearRange[] | null;
  moods?: string[] | null;
  energies?: string[] | null;
};

// Apply a show's strict music locks as a PER-DIMENSION cascade — the single
// source of truth for "make this pool strict", shared by both pick paths and
// the auto-playlist coast so they can't drift on what strict means.
//
//   starve: true  — every dimension drops hard, even to empty. The agent-tool
//     contract (llm/internal/tools/picker-tools.ts): a tool that ends up empty
//     contributes nothing, and dead-air is guarded at a WIDER scope — a run
//     with zero candidates fails into the pool picker, which never-starves.
//   starve: false — never-starve PER DIMENSION: a dimension whose filter would
//     empty the running pool is skipped, so the OTHER dimensions' purity
//     survives. This replaces the old all-or-nothing joint revert, where one
//     zero-coverage tag class (e.g. a mood on an un-tagged library) threw away
//     an otherwise genre- and era-pure pool and leaked off-filter tracks back.
//
// Order is genre → era → mood → energy; with starve:false each step commits
// only if it left something, so a starved late dimension can't undo an earlier
// one's tightening.
export function applyStrictLocks<T extends FilterTrack>(
  tracks: T[],
  locks: StrictLocks,
  { starve }: { starve: boolean },
): T[] {
  let pool = tracks;
  const step = (next: T[]) => {
    if (starve || next.length) pool = next;
  };
  if (locks.genres?.length) step(onlyGenre(pool, locks.genres));
  if (hasEraBound(locks.eras)) step(inYearRange(pool, locks.eras!));
  if (locks.moods?.length) step(onlyMood(pool, locks.moods));
  if (locks.energies?.length) step(onlyEnergy(pool, locks.energies));
  return pool;
}
