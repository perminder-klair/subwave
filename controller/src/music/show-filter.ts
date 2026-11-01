// Shared show-music filter helpers, used by BOTH pick paths (the pool picker
// and the agent's discovery tools) so they cannot drift.
//
// Multi-value semantics (#929): every filter takes a LIST — OR within an
// attribute, AND across attributes. An empty list means "no constraint".

import * as library from './library.js';
import { isInstrumental } from './lyric-vocal.js';
import { resolveEraYear } from './era-year.js';
// The genre fold lives in a leaf module so library-db can register its SQL twin
// without importing this one (which imports library).
import { normGenre, tagCoversGenre } from './genre-fold.js';
export { normGenre };

export { resolveEraYear };

// Raw Subsonic children and slimTrack library rows both satisfy this
// structurally; every field is optional so a source omitting one still passes.
export interface FilterTrack {
  id?: string;
  // Library rows: strings. Raw Subsonic children: OpenSubsonic {name} objects.
  genres?: Array<string | { name?: unknown }> | null;
  genre?: string | null;
  year?: number | string | null;
  // Original-release-year surface (#842/#1418). Library rows carry these; raw
  // Subsonic children carry none (undefined ≠ "not a comp") and fall back to a
  // library lookup in trackEraYear.
  originalYear?: number | null;
  // What era resolution reads: Navidrome's compilation flag OR the derived
  // anthology judgement, composed once in the library-db row mappers.
  yearUntrusted?: boolean | null;
  // Raw Navidrome flag, kept for display and as the pre-#1418 fallback.
  isCompilation?: boolean | null;
  energy?: string | null;
  moods?: string[] | null;
  audioMoods?: string[] | null;
  // Measured timing spans; isInstrumental owns classification. Null = unknown.
  vocalRanges?: unknown[] | null;
  vocalRangesInvalid?: boolean;
  // Part of trackAllTags' any-namespace union.
  lastfmTags?: string[] | null;
  // OpenSubsonic advisory tag; music/explicit-policy.ts owns reading it.
  explicitStatus?: string | null;
}

// Raw Subsonic children carry OpenSubsonic `genres: [{name}]` objects, not
// strings; returned as-is they reached normGenre as "[object Object]" and no
// genre filter could match them. Flatten both shapes, like subsonic.songGenres
// (not imported: subsonic.ts already imports this module).
export function trackGenres(t: FilterTrack | null | undefined): string[] {
  if (Array.isArray(t?.genres) && t.genres.length) {
    const flat = (t.genres as unknown[])
      .map((g) => (typeof g === 'string' ? g : String((g as { name?: unknown })?.name ?? '')))
      .filter(Boolean);
    if (flat.length) return flat;
  }
  if (t?.genre) return [t.genre];
  const rec = t?.id ? library.get(t.id) : null;
  if (Array.isArray(rec?.genres) && rec.genres.length) return rec.genres;
  return rec?.genre ? [rec.genre] : [];
}

// True when ANY of a track's genre tags matches ANY (already normalised)
// target: exact-normalised, or the tag REFINES the target. One-directional —
// a track may be tagged more specifically than asked, never less. Do not
// reintroduce the reverse direction.
//
//   show "Punk"      ← track "Punk Rock"          ✓ refines
//   show "R&B"       ← track "Contemporary R&B"   ✓ refines
//   show "Pop Punk"  ← track "Pop"                ✗ broader than asked
//   show "Rap"       ← track "Trap"               ✗ not a word boundary
export function genreMatches(t: FilterTrack | null | undefined, targetNorms: string[]): boolean {
  if (!targetNorms.length) return false;
  const tags = trackGenres(t).filter(Boolean);
  if (!tags.length) return false;
  return tags.some(tag => targetNorms.some(target => !!target && tagCoversGenre(tag, target)));
}

// subsonic.resolveGenreName matches substrings both ways, so "Pop Punk" against a
// library with no such tag silently airs plain "Pop". Reporting only, in operator
// words; null = faithful resolution. The resolved tag is still what gets used.
export function genreResolutionWarning(raw: string, resolved: string | null): string | null {
  const asked = normGenre(raw);
  if (!asked) return null;
  if (!resolved) {
    return `genre "${raw}" is not a tag in your library — the genre filter is OFF for this show, so it can air anything. Check the spelling, or pick a genre from the editor's suggestions.`;
  }
  const got = normGenre(resolved);
  // Cosmetic differences ("hip hop" → "Hip-Hop") are faithful.
  if (got === asked) return null;
  if (tagCoversGenre(raw, got)) {
    return `genre "${raw}" is not a tag in your library — falling back to the broader tag "${resolved}", so this show will air more than it asks for. Re-tag the tracks, or set the show's genre to "${resolved}".`;
  }
  if (tagCoversGenre(resolved, asked)) {
    return `genre "${raw}" is not a tag in your library — narrowing to "${resolved}", the only tag that carries it. Other "${raw}" tracks (if any) will not air.`;
  }
  return `genre "${raw}" resolved to the unrelated-looking tag "${resolved}" — worth a check.`;
}

// One-shot memo so a standing misconfiguration doesn't reprint on every pick.
// Process-lifetime, so a restart re-warns.
const warnedGenreResolutions = new Set<string>();

export function genreResolutionWarningOnce(raw: string, resolved: string | null): string | null {
  const key = `${normGenre(raw)}\0${resolved ?? ''}`;
  if (warnedGenreResolutions.has(key)) return null;
  const warning = genreResolutionWarning(raw, resolved);
  if (warning) warnedGenreResolutions.add(key);
  return warning;
}

// Hard-prefer tracks matching ANY of the show's genres: untagged/off-genre
// tracks drop, but the whole set comes back when nothing matches
// (never-starve, mirrors preferEra).
export function preferGenre<T extends FilterTrack>(tracks: T[], genreNames?: string[] | null): T[] {
  const targets = (genreNames ?? []).map(normGenre).filter(Boolean);
  if (!targets.length) return tracks;
  const match = tracks.filter((t) => genreMatches(t, targets));
  return match.length ? match : tracks;
}

// Hard genre filter — NO never-starve, even to empty. Only for call sites that
// guarantee non-starvation at a WIDER scope than one source.
export function onlyGenre<T extends FilterTrack>(tracks: T[], genreNames?: string[] | null): T[] {
  const targets = (genreNames ?? []).map(normGenre).filter(Boolean);
  if (!targets.length) return tracks;
  return tracks.filter((t) => genreMatches(t, targets));
}

export type YearRange = { fromYear?: number | null; toYear?: number | null };

export function hasEraBound(eras?: YearRange[] | null): boolean {
  return !!eras?.some(e => e && (e.fromYear != null || e.toYear != null));
}

// Coarse single-window envelope, for APIs taking one contiguous
// fromYear/toYear pair. A missing bound on ANY window leaves that side open —
// the envelope must never exclude a track an individual window would admit.
// inYearRange enforces exact union membership afterwards.
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

// Per-track era year — from the track's own fields, else a library lookup.
// Off-library tracks fall back to the plain year.
export function trackEraYear(t: FilterTrack | null | undefined): number | null {
  if (t && (t.originalYear !== undefined || t.yearUntrusted !== undefined || t.isCompilation !== undefined)) {
    // `yearUntrusted` when the source carries it; the raw flag only as a
    // fallback for shapes written before #1418.
    return resolveEraYear(t.year, t.originalYear, t.yearUntrusted ?? t.isCompilation);
  }
  const rec = t?.id ? library.getPlaybackMeta(t.id) : null;
  if (rec) return resolveEraYear(rec.year ?? t?.year, rec.originalYear, rec.yearUntrusted);
  return resolveEraYear(t?.year, null, null);
}

// Hard-filter to tracks inside ANY era window. Unknown-year tracks drop as
// out-of-range. Callers that must not starve use preferEra.
export function inYearRange<T extends FilterTrack>(tracks: T[], eras: YearRange[]): T[] {
  if (!hasEraBound(eras)) return tracks;
  return tracks.filter((t) => {
    const y = trackEraYear(t);
    return y != null && inAnyWindow(y, eras);
  });
}

// Never-starve era filter, mirroring preferGenre's contract.
export function preferEra<T extends FilterTrack>(tracks: T[], eras?: YearRange[] | null): T[] {
  if (!hasEraBound(eras)) return tracks;
  const match = inYearRange(tracks, eras!);
  return match.length ? match : tracks;
}

// null when un-analysed.
export function trackEnergy(t: FilterTrack | null | undefined): string | null {
  if (t?.energy) return t.energy;
  const rec = t?.id ? library.get(t.id) : null;
  return rec?.energy ?? null;
}

// Soft lean: unknown-energy tracks stay eligible, never-starve.
export function preferEnergy<T extends FilterTrack>(tracks: T[], energies?: string[] | null): T[] {
  if (!energies?.length) return tracks;
  const match = tracks.filter((t) => {
    const e = trackEnergy(t);
    return e == null || energies.includes(e);
  });
  return match.length ? match : tracks;
}

// Strict energy filter (show.filtersStrict): unknown-energy tracks drop too.
// Never-starve, so an un-analysed library falls back to the full set.
export function preferEnergyStrict<T extends FilterTrack>(tracks: T[], energies?: string[] | null): T[] {
  if (!energies?.length) return tracks;
  const match = tracks.filter((t) => {
    const e = trackEnergy(t);
    return e != null && energies.includes(e);
  });
  return match.length ? match : tracks;
}

// Unions the editorial LLM moods with the zero-shot audio moods, matching the
// blend songsByMood applies at retrieval, so a track surfaced via its audio
// mood isn't filtered back out here.
export function trackMoods(t: FilterTrack | null | undefined): string[] {
  const rec = Array.isArray(t?.moods) && Array.isArray(t?.audioMoods)
    ? t
    : (t?.id ? library.get(t.id) : null) ?? t;
  const moods = Array.isArray(rec?.moods) ? rec.moods : [];
  const audio = Array.isArray(rec?.audioMoods) ? rec.audioMoods : [];
  return audio.length ? [...new Set([...moods, ...audio])] : moods;
}

// Strict mood filter (show.filtersStrict): un-tagged tracks drop, never-starve.
// Soft shows steer through the dominantMood-driven pool sources instead.
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

// Every tag across ALL ingested namespaces: genres ∪ editorial moods ∪ audio
// moods ∪ Last.fm tags. What the blocklist's `tag` rules match against (#1300).
// Raw strings, not normalised — the caller owns comparison semantics.
export function trackAllTags(t: FilterTrack | null | undefined): string[] {
  const rec = (Array.isArray(t?.moods) || Array.isArray(t?.lastfmTags))
    ? t
    : (t?.id ? library.get(t.id) : null) ?? t;
  const out = new Set<string>(trackGenres(t).filter(Boolean));
  for (const m of Array.isArray(rec?.moods) ? rec.moods : []) if (m) out.add(String(m));
  for (const m of Array.isArray(rec?.audioMoods) ? rec.audioMoods : []) if (m) out.add(String(m));
  for (const m of Array.isArray(rec?.lastfmTags) ? rec.lastfmTags : []) if (m) out.add(String(m));
  return [...out];
}

// The show's vocal constraint. '' = no constraint, and is the default.
export type VocalMode = '' | 'instrumental' | 'vocal';

// Tri-state track classification, shared with embedding descriptors:
//
//   total sung time <5s   → measured instrumental (including [], #1655)
//   total sung time >=5s  → measured vocal
//   vocalRanges == null   → not measured, which is NOT the same as "vocal"
//
// Demucs is opt-in, so on most libraries every track is null; collapsing null to
// "has vocals" makes an instrumental show reject its whole library.
export function trackInstrumental(t: FilterTrack | null | undefined): boolean | null {
  const source = Array.isArray(t?.vocalRanges)
    ? t
    : (t?.id ? library.get(t.id) : null);
  return isInstrumental(source?.vocalRanges, source?.vocalRangesInvalid);
}

// Soft lean: un-measured tracks stay eligible, never-starve. It fills
// preferEnergyStrict's slot in picker.ts's lean() but keeps preferEnergy's
// tolerance on purpose — un-measured is the norm, so dropping unknowns per-source
// would gut every discovery source. Don't add a drop-unknown variant.
export function preferVocals<T extends FilterTrack>(tracks: T[], mode?: VocalMode | null): T[] {
  if (!mode) return tracks;
  const wantInstrumental = mode === 'instrumental';
  const match = tracks.filter((t) => {
    const inst = trackInstrumental(t);
    return inst == null || inst === wantInstrumental;
  });
  return match.length ? match : tracks;
}

// Hard filter — NO never-starve (see onlyGenre), and un-measured tracks drop.
// On a library with no vocal pass this empties the pool, which is what
// applyStrictLocks' starve:false step catches by skipping the dimension.
export function onlyVocals<T extends FilterTrack>(tracks: T[], mode?: VocalMode | null): T[] {
  if (!mode) return tracks;
  const wantInstrumental = mode === 'instrumental';
  return tracks.filter((t) => trackInstrumental(t) === wantInstrumental);
}

// A show's strict music constraints, resolved to library-comparable values:
// genres are the library's exact tags (the caller resolves free text upstream);
// the rest are as declared. An empty/absent dimension is "no constraint".
export type StrictLocks = {
  genres?: string[] | null;
  eras?: YearRange[] | null;
  moods?: string[] | null;
  energies?: string[] | null;
  vocals?: VocalMode | null;
};

// Apply a show's strict music locks as a per-dimension cascade — the one
// definition of "make this pool strict", shared by both pick paths and the
// auto-playlist coast.
//
//   starve: true  — every dimension drops hard, even to empty (the agent-tool
//     contract: dead air is guarded at a wider scope).
//   starve: false — never-starve PER DIMENSION, not an all-or-nothing revert:
//     a dimension whose filter would empty the pool is skipped so the others'
//     purity survives.
//
// Order is genre → era → mood → energy → vocals; each step commits only if it
// left something, so a starved late dimension can't undo an earlier one's
// tightening. Vocals goes last because it is likeliest to have no coverage.
export function applyStrictLocks<T extends FilterTrack>(
  tracks: T[],
  locks: StrictLocks,
  { starve }: { starve: boolean },
): T[] {
  let pool: T[] = tracks;
  const step = (next: T[]) => {
    if (starve || next.length) pool = next;
  };
  if (locks.genres?.length) step(onlyGenre(pool, locks.genres));
  if (hasEraBound(locks.eras)) step(inYearRange(pool, locks.eras!));
  if (locks.moods?.length) step(onlyMood(pool, locks.moods));
  if (locks.energies?.length) step(onlyEnergy(pool, locks.energies));
  if (locks.vocals) step(onlyVocals(pool, locks.vocals));
  // Never hand the INPUT array back: the auto.m3u coast rebuilds its pool in
  // place and would clear the very array it then spreads back in. Same
  // contract as music/track-floor.applyTrackFloor.
  return pool === tracks ? tracks.slice() : pool;
}
