// What still names a scene a merge is about to retire (#1593).
//
// A scene merge rewrites `tracks.genres` and records a fold, and both halves
// are right — the operator asked for it, and genre matching is one-directional
// by design (a track's tag may refine a show's genre, never broaden it), so a
// filter naming the retired value cannot be auto-rewritten without changing
// what the show MEANS. What was missing is the warning: merge "trip-hop" into
// "downtempo" and every show, blocklist rule and playlist filter still naming
// "trip-hop" matches nothing, with no error and no visible cause. The library
// is correct; the schedule quietly stops working.
//
// WHAT COUNTS AS ORPHANED
// -----------------------
// Not "the value was ticked". Show filters, blocklist genre rules and playlist
// knobs all resolve through show-filter's `normGenre` + `genreMatches`, which
// fold case AND punctuation and let a track's tag REFINE the filter — so the
// harmless merges orphan nothing:
//
//   filter "rock"     merge "rock" → "Rock"            still matches
//   filter "Hip Hop"  merge "Hip-Hop" → "Hip Hop"      still matches
//   filter "Punk"     merge "Punk Rock" → "Post-Punk"  still matches (refines)
//   filter "Trip Hop" merge "trip-hop" → "Downtempo"   ORPHANED
//
// So the test is asked in the matcher's own words, through its own exported
// entry point: did this filter value match the retired spelling, and does it
// still match the survivor? Restating the fold here — comparing sceneKey, or
// lower-casing both sides — is how a warning fires on every case merge and
// gets ignored by the third one.
//
// WARNING ONLY. Nothing here blocks a merge or rewrites a filter; both are
// bigger decisions than the ticket that asked for this, and the second one
// cannot be made without knowing what the operator meant the show to be. The
// blocking twin is settings/validate.ts's assertNoOrphanMoods, which refuses a
// mood removal — it can, because a mood is a closed vocabulary and a genre
// filter is free text resolved against the library at pick time.
//
// Pinned by scripts/scene-references.test.ts.

import * as blocklist from './blocklist.js';
import * as playlistRecipes from './playlist-recipes.js';
import * as sceneVocab from './scene-vocab.js';
import { genreMatches, normGenre } from './show-filter.js';
import * as settings from '../settings.js';
import type { SceneReference, SceneReferenceKind } from '../schemas/library.js';

export type { SceneReference, SceneReferenceKind };

/** One thing that filters on genre, flattened to the two facts the scan needs. */
export interface GenreFilter {
  kind: SceneReferenceKind;
  id: string;
  name: string;
  genres: readonly string[];
}

// ── Pure ────────────────────────────────────────────────────────────────────

/**
 * Does a filter value still select tracks tagged `scene`?
 *
 * Asked of `genreMatches` rather than of a local comparison: this is the exact
 * question the pick paths ask at pick time, and a second copy of it here would
 * drift on the direction (the tag refines the filter, never the reverse) long
 * before anyone noticed the warning was wrong.
 */
export function filterMatchesScene(filterValue: string, scene: string): boolean {
  const target = normGenre(filterValue);
  if (!target) return false;
  return genreMatches({ genres: [scene] }, [target]);
}

/**
 * Which of these filters lose a genre value to `sources → target`.
 *
 * A value is orphaned when it matched at least one retired spelling and no
 * longer matches the survivor. A filter with nothing orphaned is absent from
 * the result entirely — the operator reads this list as "these break", so a
 * row with an empty `orphaned` would be noise on every harmless merge.
 */
export function orphanedFilters(
  filters: readonly GenreFilter[],
  sources: readonly string[],
  target: string,
): SceneReference[] {
  const retired = sources.map((s) => String(s ?? '').trim()).filter(Boolean);
  const survivor = String(target ?? '').trim();
  if (!retired.length || !survivor) return [];
  const out: SceneReference[] = [];
  for (const f of filters) {
    const orphaned: string[] = [];
    const remaining: string[] = [];
    for (const value of f.genres) {
      const matchedRetired = retired.some((s) => filterMatchesScene(value, s));
      if (matchedRetired && !filterMatchesScene(value, survivor)) orphaned.push(value);
      else remaining.push(value);
    }
    if (orphaned.length) out.push({ kind: f.kind, id: f.id, name: f.name, orphaned, remaining });
  }
  return out;
}

// ── Projections: where a genre filter lives ─────────────────────────────────
// One per store, pure over the rows that store holds, so the mapping from
// "a show" to "a genre filter" is pinned by a test rather than by reading the
// gatherer below.

/** The three stores hand back their own shapes; only these fields are read. */
export interface ShowLike { id?: unknown; name?: unknown; genres?: unknown }

/** Pull a non-empty list of genre strings off a row, or null. */
function genreList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const values = raw.map((v) => String(v ?? '').trim()).filter(Boolean);
  return values.length ? values : null;
}

/** A show's `genres` list — free text, resolved against the library at pick time. */
export function showFilters(shows: readonly ShowLike[]): GenreFilter[] {
  const out: GenreFilter[] = [];
  for (const s of shows || []) {
    const genres = genreList(s?.genres);
    if (!genres) continue;
    out.push({
      kind: 'show',
      id: String(s.id ?? ''),
      name: String(s.name || s.id || 'untitled show'),
      genres,
    });
  }
  return out;
}

/**
 * Never-play rules, `field: 'genre'` only. The other six fields (tag, mood,
 * artist, album, title, playlist) carry values that are not scenes, and
 * warning about a `tag` rule whose value happens to read like a genre is how
 * a warning stops being read.
 */
export function ruleFilters(rules: readonly blocklist.BlockRule[]): GenreFilter[] {
  const out: GenreFilter[] = [];
  for (const r of rules || []) {
    if (r?.field !== 'genre') continue;
    const genres = genreList(r.values);
    if (!genres) continue;
    out.push({
      kind: 'rule',
      id: String(r.id ?? ''),
      name: String(r.label || r.id || 'untitled rule'),
      genres,
    });
  }
  return out;
}

/**
 * The `knobs.genres` of a sync-enabled playlist's stored recipe. A plain saved
 * playlist holds tracks, not a filter, and has nothing to orphan; only the
 * recipe re-resolves against the library on every sync.
 */
export function recipeFilters(
  entries: readonly playlistRecipes.PlaylistRecipeEntry[],
): GenreFilter[] {
  const out: GenreFilter[] = [];
  for (const e of entries || []) {
    const genres = genreList(e?.recipe?.knobs?.genres);
    if (!genres) continue;
    out.push({
      kind: 'playlist',
      id: String(e.playlistId ?? ''),
      name: String(e.name || e.playlistId || 'untitled playlist'),
      genres,
    });
  }
  return out;
}

// ── The gatherer ────────────────────────────────────────────────────────────

/** Every genre filter the station holds, from the three stores that keep one. */
export function collectGenreFilters(): GenreFilter[] {
  return [
    ...showFilters(settings.get().shows ?? []),
    ...ruleFilters(blocklist.listRules()),
    ...recipeFilters(playlistRecipes.list()),
  ];
}

/**
 * The warning for `sources → target`: every genre filter that names a retired
 * value and stops matching.
 *
 * The target is resolved through the rule set FIRST, using planAliases — the
 * same resolution `recordMerge` will apply, so the preview and the merge
 * response cannot disagree about which value actually survives when the
 * operator types a target that is itself already retired. Both callers pass
 * the raw body, and both get the answer for the merge that will happen.
 */
export function sceneReferences(sources: readonly string[], target: string): SceneReference[] {
  const resolved = sceneVocab.planAliases(sceneVocab.list(), sources, target, '').target;
  return orphanedFilters(collectGenreFilters(), sources, resolved);
}
