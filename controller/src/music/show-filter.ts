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
import { resolveEraYear } from './era-year.js';

export { resolveEraYear };

// The narrow track shape the show filters read: raw Subsonic children and
// slimTrack library rows both satisfy it structurally. Every field is optional
// so a source that omits one (e.g. Subsonic tracks carry no energy band) still
// passes through. The array filters are generic over T extends FilterTrack so
// they return the caller's own element type unchanged.
export interface FilterTrack {
  id?: string;
  genres?: string[] | null;
  genre?: string | null;
  year?: number | string | null;
  // Original-release-year surface (issue #842/#1418). Library-sourced tracks
  // carry these; raw Subsonic children carry none (undefined ≠ "not a comp")
  // and fall back to a library lookup in trackEraYear.
  originalYear?: number | null;
  // What era resolution reads: Navidrome's compilation flag OR the derived
  // anthology judgement, composed once in the library-db row mappers.
  yearUntrusted?: boolean | null;
  // The raw Navidrome flag, kept for display and as the pre-#1418 fallback.
  isCompilation?: boolean | null;
  energy?: string | null;
  moods?: string[] | null;
  audioMoods?: string[] | null;
  // Demucs vocal ranges. [] = instrumental, null/absent = never measured — the
  // distinction trackInstrumental is built on.
  vocalRanges?: unknown[] | null;
  // Last.fm enrichment tags — part of trackAllTags' any-namespace union.
  lastfmTags?: string[] | null;
}

// ── Genre ──────────────────────────────────────────────────────────────────

// Normalised genre token for fuzzy comparison — mirrors subsonic.resolveGenreName
// so the show's resolved tag and a track's tag compare the same way.
export function normGenre(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Per-track genre tags — every tag the track carries, from the track itself
// (Subsonic children and slimTrack library rows both carry `genres`; older
// callers may carry only the scalar `genre`) or a library lookup. Empty when
// the track has no genre tag.
export function trackGenres(t: FilterTrack | null | undefined): string[] {
  if (Array.isArray(t?.genres) && t.genres.length) return t.genres;
  if (t?.genre) return [t.genre];
  const rec = t?.id ? library.get(t.id) : null;
  if (Array.isArray(rec?.genres) && rec.genres.length) return rec.genres;
  return rec?.genre ? [rec.genre] : [];
}

// Normalised genre tag plus, per normalised character, whether it opens /
// closes a word in the ORIGINAL string. A "word" is a maximal run of
// alphanumerics, so "Contemporary R&B" normalises to "contemporaryrb" with
// words "contemporary" | "r" | "b". This is what lets containment respect word
// boundaries even though normGenre has thrown the separators away.
function genreBoundaries(s: unknown): { norm: string; opens: boolean[]; closes: boolean[] } {
  const src = String(s ?? '').toLowerCase();
  const chars: string[] = [];
  const opens: boolean[] = [];
  let prevAlnum = false;
  for (const ch of src) {
    const alnum = (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9');
    if (!alnum) { prevAlnum = false; continue; }
    chars.push(ch);
    opens.push(!prevAlnum);
    prevAlnum = true;
  }
  // A char closes its word when it is last overall, or the next char opens one.
  const closes = chars.map((_, i) => i === chars.length - 1 || opens[i + 1]!);
  return { norm: chars.join(''), opens, closes };
}

// True when the show's (already normalised) target genre appears inside a
// track's raw genre tag, aligned to word boundaries. ONE-DIRECTIONAL by design
// — see genreMatches.
function tagCoversGenre(tag: string, target: string): boolean {
  const { norm, opens, closes } = genreBoundaries(tag);
  if (!norm || !target) return false;
  if (norm === target) return true;
  for (let i = norm.indexOf(target); i !== -1; i = norm.indexOf(target, i + 1)) {
    if (opens[i] && closes[i + target.length - 1]) return true;
  }
  return false;
}

// True when ANY of a track's genre tags matches ANY of the (already
// normalised) target genres. Multi-genre (#OpenSubsonic): a track tagged
// Hip-Hop + Rap is in-genre for a Rap show even when Rap isn't its primary tag.
//
// Matching is exact-normalised ("Hip-Hop" matches a "Hip Hop" tag), or the
// track's tag REFINES the target — the target appears in the tag on word
// boundaries. The direction is the whole point: a show asks for a genre and a
// track may be tagged more specifically than asked, never less.
//
//   show "Punk"      ← track "Punk Rock"          ✓ refines
//   show "R&B"       ← track "Contemporary R&B"   ✓ refines
//   show "Pop Punk"  ← track "Pop"                ✗ broader than asked
//   show "Rap"       ← track "Trap"               ✗ not a word boundary
//
// Do NOT reintroduce the reverse direction: matching a track tag that merely
// CONTAINS the show's genre let strict emo / pop-punk shows fill with anything
// tagged plain "Pop" or "Rock", and unbounded substrings pulled Trap into a Rap
// show.
export function genreMatches(t: FilterTrack | null | undefined, targetNorms: string[]): boolean {
  if (!targetNorms.length) return false;
  const tags = trackGenres(t).filter(Boolean);
  if (!tags.length) return false;
  return tags.some(tag => targetNorms.some(target => !!target && tagCoversGenre(tag, target)));
}

// ── Genre resolution honesty ────────────────────────────────────────────────

// subsonic.resolveGenreName maps a show's free-text genre onto a tag the
// library actually carries, and it matches substrings BOTH ways on purpose —
// that looseness is right for a listener request ("play some punk") and for
// the server-side genre fetch, where over-fetching is harmless because the
// pick paths filter afterwards.
//
// It is NOT right silently: a show configured "Pop Punk" against a library
// with no such tag resolves to plain "Pop" and the station quietly airs a
// different show than the operator asked for, with nothing in the logs saying
// so. This describes that gap in operator-facing words; null means the
// resolution was faithful and there is nothing to say.
//
// Note this is about *reporting*, not filtering — the resolved tag is still
// what gets used. A genre absent from the library makes a show unsatisfiable,
// and no matching rule fixes that; the fix is telling the operator.
export function genreResolutionWarning(raw: string, resolved: string | null): string | null {
  const asked = normGenre(raw);
  if (!asked) return null;
  if (!resolved) {
    return `genre "${raw}" is not a tag in your library — the genre filter is OFF for this show, so it can air anything. Check the spelling, or pick a genre from the editor's suggestions.`;
  }
  const got = normGenre(resolved);
  // Cosmetic differences ("hip hop" → "Hip-Hop") are a faithful resolution.
  if (got === asked) return null;
  if (tagCoversGenre(raw, got)) {
    return `genre "${raw}" is not a tag in your library — falling back to the broader tag "${resolved}", so this show will air more than it asks for. Re-tag the tracks, or set the show's genre to "${resolved}".`;
  }
  if (tagCoversGenre(resolved, asked)) {
    return `genre "${raw}" is not a tag in your library — narrowing to "${resolved}", the only tag that carries it. Other "${raw}" tracks (if any) will not air.`;
  }
  return `genre "${raw}" resolved to the unrelated-looking tag "${resolved}" — worth a check.`;
}

// One-shot memo so a standing misconfiguration doesn't reprint on every pick
// and every hourly refresh. Keyed by the resolution itself, so the message is
// identical for every show that hits it. Process-lifetime; a restart re-warns.
const warnedGenreResolutions = new Set<string>();

export function genreResolutionWarningOnce(raw: string, resolved: string | null): string | null {
  const key = `${normGenre(raw)} ${resolved ?? ''}`;
  if (warnedGenreResolutions.has(key)) return null;
  const warning = genreResolutionWarning(raw, resolved);
  if (warning) warnedGenreResolutions.add(key);
  return warning;
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

// Per-track era year — from the track's own fields when the source carries
// them (library slimTrack rows do), else a light library lookup (Subsonic
// children carry a bare `year` only, and undefined isn't "not a compilation").
// Off-library tracks fall back to the plain year, today's behaviour.
export function trackEraYear(t: FilterTrack | null | undefined): number | null {
  if (t && (t.originalYear !== undefined || t.yearUntrusted !== undefined || t.isCompilation !== undefined)) {
    // `yearUntrusted` when the source carries it (library rows do); the raw
    // flag only as a fallback for shapes written before #1418, where it is
    // still strictly better than nothing.
    return resolveEraYear(t.year, t.originalYear, t.yearUntrusted ?? t.isCompilation);
  }
  const rec = t?.id ? library.getPlaybackMeta(t.id) : null;
  if (rec) return resolveEraYear(rec.year ?? t?.year, rec.originalYear, rec.yearUntrusted);
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

// Every tag the track carries, across ALL tag namespaces we ingest: genre tags
// ∪ editorial moods ∪ zero-shot audio moods ∪ Last.fm tags. This is what the
// blocklist's `tag` rules match against ("arbitrary tag matching", #1300 FR 1)
// — whatever field an operator's tagger writes, if it reaches any list the
// pipeline carries, it matches here. Raw strings, not normalised — the caller
// owns comparison semantics (blocklist-rules normalises exact, deliberately
// not substring: Last.fm tags are noisy free text).
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

// ── Vocals (instrumental steering) ───────────────────────────────────────────

// The show's vocal constraint. '' = no constraint, and is the default, so a
// show saved before this field existed behaves byte-for-byte as it did.
export type VocalMode = '' | 'instrumental' | 'vocal';

// Is this track instrumental? Reads the same signal bed-policy.ts and
// embeddings.formatTrackText already treat as canonical:
//
//   vocalRanges === []    → measured instrumental
//   vocalRanges non-empty → measured vocal
//   vocalRanges == null   → NOT MEASURED, which is not the same as "vocal"
//
// That third case is the whole reason this returns a tri-state instead of a
// boolean. Vocal analysis is the opt-in heavy tier (Demucs), so on most
// libraries every track is null — collapsing null to "has vocals" would make an
// instrumental show reject its entire library while looking like it worked.
export function trackInstrumental(t: FilterTrack | null | undefined): boolean | null {
  const ranges = Array.isArray(t?.vocalRanges)
    ? t.vocalRanges
    : (t?.id ? library.get(t.id)?.vocalRanges : null);
  if (!Array.isArray(ranges)) return null;
  return ranges.length === 0;
}

// Soft lean: tracks matching the mode are preferred, un-measured tracks stay
// eligible, and a pool with no match falls back whole (never-starve). Same
// semantics as preferEnergy — the un-measured track is the unknown-energy track.
//
// Note which SLOT it fills, because the two differ: energy has a soft-mode lean
// (preferEnergy) and a stricter one for filtersStrict (preferEnergyStrict, which
// drops unknown-energy tracks). Vocals has no soft-mode lean at all — like
// genre/era/mood, an un-strict show steers through the prompt only — and this is
// what picker.ts's strict-only lean() calls, i.e. it fills preferEnergyStrict's
// slot with preferEnergy's tolerance. Deliberate: un-measured is the NORM for
// this dimension (opt-in Demucs), so dropping unknowns at the source level would
// gut every discovery source before applyStrictLocks' coverage-gated onlyVocals
// ever got to make that call. Don't "fix" the asymmetry by swapping in a
// drop-unknown variant here.
export function preferVocals<T extends FilterTrack>(tracks: T[], mode?: VocalMode | null): T[] {
  if (!mode) return tracks;
  const wantInstrumental = mode === 'instrumental';
  const match = tracks.filter((t) => {
    const inst = trackInstrumental(t);
    return inst == null || inst === wantInstrumental;
  });
  return match.length ? match : tracks;
}

// Hard filter — NO never-starve (see onlyGenre for the scoping contract), and
// un-measured tracks drop, same as onlyEnergy drops unknown-energy ones: a
// strict "instrumental only" show that admits tracks nobody has checked is not
// strict. On a library with no vocal pass this empties the pool, which is
// exactly what applyStrictLocks' starve:false step is there to catch — the
// dimension is skipped and the show plays on unconstrained rather than silent.
export function onlyVocals<T extends FilterTrack>(tracks: T[], mode?: VocalMode | null): T[] {
  if (!mode) return tracks;
  const wantInstrumental = mode === 'instrumental';
  return tracks.filter((t) => trackInstrumental(t) === wantInstrumental);
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
  vocals?: VocalMode | null;
};

// Apply a show's strict music locks as a PER-DIMENSION cascade — the single
// source of truth for "make this pool strict", shared by both pick paths and
// the auto-playlist coast so they can't drift on what strict means.
//
//   starve: true  — every dimension drops hard, even to empty. That is the
//     agent-tool contract: an empty tool contributes nothing, and dead air is
//     guarded at a WIDER scope, since a run with zero candidates fails into the
//     pool picker, which never-starves.
//   starve: false — never-starve PER DIMENSION: a dimension whose filter would
//     empty the running pool is skipped, so the others' purity survives. Not an
//     all-or-nothing joint revert, which let one zero-coverage tag class (a mood
//     on an un-tagged library) throw away an otherwise genre- and era-pure pool.
//
// Order is genre → era → mood → energy → vocals; with starve:false each step
// commits only if it left something, so a starved late dimension can't undo an
// earlier one's tightening. Vocals goes last because it is the dimension most
// likely to have no coverage at all (Demucs is the opt-in heavy tier), and last
// is where a skipped step costs least.
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
  if (locks.vocals) step(onlyVocals(pool, locks.vocals));
  return pool;
}
