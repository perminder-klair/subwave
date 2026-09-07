// What still names a scene a merge is about to retire (#1593).
//
// A scene merge rewrites `tracks.genres` and records a fold, and both halves
// are right — the operator asked for it, and genre matching is one-directional
// by design (a track's tag may refine a show's genre, never broaden it), so a
// filter naming the retired value cannot be auto-rewritten without changing
// what the show MEANS. What was missing is the warning: merge "trip-hop" into
// "downtempo" and every show, blocklist rule and playlist filter still naming
// "trip-hop" stops selecting it, with no error and no visible cause. The
// library is correct; the schedule quietly stops working.
//
// WHAT COUNTS AS ORPHANED
// -----------------------
// Two questions, and they are asked with DIFFERENT strengths on purpose.
//
//  1. Does this filter value NAME the retired spelling — is it that value —
//     rather than merely catching it as one narrower tag among many? Asked as
//     a MUTUAL match: each side covers the other. For the genre predicate that
//     can only happen when the two normalise equal, because coverage is
//     containment on word boundaries and mutual containment forces equality.
//  2. Does it still catch the survivor? Asked ONE-WAY, in the direction the
//     pick paths ask it: a filter that the survivor merely refines is fine.
//
//   filter "rock"      merge "rock" → "Rock"             names it, survivor caught
//   filter "Hip Hop"   merge "Hip-Hop" → "Hip Hop"       names it, survivor caught
//   filter "Punk"      merge "Punk Rock" → "Post-Punk"   does not name it
//   filter "Punk"      merge "Punk Rock" → "Downtempo"   does not name it
//   filter "Punk Rock" merge "Punk Rock" → "Punk"        ORPHANED
//   filter "Trip Hop"  merge "trip-hop" → "Downtempo"    ORPHANED
//
// The fourth row is why question 1 is mutual rather than one-way. A "Punk"
// show catches "Punk Rock" by refinement, so a one-way test reported it as
// orphaned on any merge that moved punk rock elsewhere — while every track
// tagged plain "Punk" still matched it. That show has NARROWED, not broken,
// and a list that mixes the two is a list the operator learns to skim. The
// narrowing is real but unbounded: practically every merge narrows some show
// whose genre overlaps it, which is the generic non-advice this feature exists
// to replace.
//
// Both questions go through the predicate the matching side actually runs —
// `genreMatches` for a genre filter, `normText` equality for a `tag` rule —
// rather than a local comparison. Restating either fold here (comparing
// sceneKey, or lower-casing both sides) is how a warning fires on every case
// merge and gets ignored by the third one.
//
// WHAT IS NOT ESTABLISHED
// -----------------------
// That an orphaned filter matches NOTHING. It may still catch another spelling
// in the vocabulary by refinement, and a `tag` rule reaches moods, audio moods
// and Last.fm tags as well as genres. Answering that would mean walking the
// whole tag set on every keystroke of a preview — the `json_each` scan that
// `GET /library/scenes` is deliberately fetched-on-expand to avoid (#1570). So
// this reports what it knows: the value is named, and here is the rest of that
// filter's own list. The UI says exactly that and no more.
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
import { dedupeScenes } from './scene-vocab.js';
import { normText } from './blocklist-rules.js';
import { genreMatches, normGenre } from './show-filter.js';
import * as settings from '../settings.js';
import type { SceneReference, SceneReferenceKind } from '../schemas/library.js';

export type { SceneReference, SceneReferenceKind };

/**
 * Which predicate compares this filter's values to a scene.
 *
 * `genre` is show-filter's `genreMatches` — the one-directional, punctuation-
 * folding, boundary-aware test the pick paths and `field: 'genre'` rules run.
 * `tag` is the `field: 'tag'` rule's own test: `normText` EXACT across every
 * namespace it ingests, which folds case, whitespace and curly-vs-straight
 * apostrophes (#1611) but no OTHER punctuation, so a "Trip-Hop" tag rule is
 * untouched by a merge retiring "Trip Hop".
 */
export type MatchMode = 'genre' | 'tag';

/** One thing that names scene values, flattened to what the scan needs. */
export interface SceneFilter {
  kind: SceneReferenceKind;
  mode: MatchMode;
  id: string;
  name: string;
  values: readonly string[];
}

// ── Pure ────────────────────────────────────────────────────────────────────

/**
 * Does a filter value still select a track carrying `scene`?
 *
 * Asked of the real predicates rather than of a local comparison: these are
 * the exact questions the pick paths and `blocklist-rules.ruleMatches` ask at
 * play time, and a second copy of either would drift on the direction (a tag
 * refines a filter, never the reverse) long before anyone noticed the warning
 * was wrong.
 */
export function filterCatchesScene(mode: MatchMode, filterValue: string, scene: string): boolean {
  if (mode === 'tag') {
    const value = normText(filterValue);
    return !!value && value === normText(scene);
  }
  const target = normGenre(filterValue);
  if (!target) return false;
  return genreMatches({ genres: [scene] }, [target]);
}

/**
 * Is this filter value THAT scene, rather than something broader that also
 * catches it?
 *
 * Mutual coverage. For the genre predicate a match is either exact-normalised
 * or the scene refining the filter on word boundaries, so each covering the
 * other leaves only equality — stated as two calls to the matcher instead of
 * a normalised comparison, so the day the fold changes this follows it.
 */
export function filterNamesScene(mode: MatchMode, filterValue: string, scene: string): boolean {
  return (
    filterCatchesScene(mode, filterValue, scene) && filterCatchesScene(mode, scene, filterValue)
  );
}

/**
 * Which of these filters lose a value they NAME to `sources → target`.
 *
 * A filter with nothing orphaned is absent from the result entirely — the
 * operator reads this list as "these need attention", so a row with an empty
 * `orphaned` would be noise on every harmless merge.
 */
export function orphanedFilters(
  filters: readonly SceneFilter[],
  sources: readonly string[],
  target: string,
): SceneReference[] {
  // dedupeScenes is the repo's trim-and-drop-blanks, shared with ingest and
  // the rewrite. Its case-dedupe is incidental here and cannot change an
  // answer: both predicates fold case, so two spellings of one key give the
  // same verdict.
  const retired = dedupeScenes(sources);
  const survivor = String(target ?? '').trim();
  if (!retired.length || !survivor) return [];
  const out: SceneReference[] = [];
  for (const f of filters) {
    const orphaned: string[] = [];
    const remaining: string[] = [];
    for (const value of f.values) {
      const names = retired.some((s) => filterNamesScene(f.mode, value, s));
      if (names && !filterCatchesScene(f.mode, value, survivor)) orphaned.push(value);
      else remaining.push(value);
    }
    if (orphaned.length) out.push({ kind: f.kind, id: f.id, name: f.name, orphaned, remaining });
  }
  return out;
}

// ── Projections: where a scene value gets named ─────────────────────────────
// One `pick` per store, so the mapping from "a show" to "a filter over scene
// values" is pinned by a test rather than by reading the gatherer below. The
// row-shaping around them is identical for all three, so it is written once.

/** What a store's row contributes, before the shared shaping. */
interface Picked {
  mode: MatchMode;
  id: unknown;
  name: unknown;
  values: unknown;
}

function project<T>(
  kind: SceneReferenceKind,
  rows: readonly T[] | null | undefined,
  pick: (row: T) => Picked | null,
): SceneFilter[] {
  const out: SceneFilter[] = [];
  for (const row of rows || []) {
    const p = row ? pick(row) : null;
    if (!p) continue;
    const values = Array.isArray(p.values) ? dedupeScenes(p.values.map((v) => String(v ?? ''))) : [];
    if (!values.length) continue;
    out.push({
      kind,
      mode: p.mode,
      id: String(p.id ?? ''),
      name: String(p.name || p.id || `untitled ${kind}`),
      values,
    });
  }
  return out;
}

/** The three stores hand back their own shapes; only these fields are read. */
export interface ShowLike { id?: unknown; name?: unknown; genres?: unknown }

/** A show's `genres` list — free text, resolved against the library at pick time. */
export function showFilters(shows: readonly ShowLike[] | null | undefined): SceneFilter[] {
  return project('show', shows, (s) => ({
    mode: 'genre',
    id: s.id,
    name: s.name,
    values: s.genres,
  }));
}

/**
 * Never-play rules — `genre` AND `tag`.
 *
 * A `tag` rule is not obviously in scope and belongs here anyway: it matches
 * `trackAllTags`, which is genres ∪ moods ∪ audio moods ∪ Last.fm tags, so a
 * tag rule naming a retired genre spelling stops matching on that namespace
 * exactly like a genre rule does. It carries its own stricter predicate rather
 * than being folded into the genre one.
 *
 * The other five fields (mood, artist, album, title, playlist) name values
 * from vocabularies a genre merge cannot touch, so they are out of scope —
 * not merely noisy.
 */
export function ruleFilters(
  rules: readonly blocklist.BlockRule[] | null | undefined,
): SceneFilter[] {
  return project('rule', rules, (r) =>
    r.field === 'genre' || r.field === 'tag'
      ? { mode: r.field, id: r.id, name: r.label, values: r.values }
      : null,
  );
}

/**
 * The `knobs.genres` of a sync-enabled playlist's stored recipe. A plain saved
 * playlist holds tracks, not a filter, and has nothing to orphan; only the
 * recipe re-resolves against the library on every sync.
 */
export function recipeFilters(
  entries: readonly playlistRecipes.PlaylistRecipeEntry[] | null | undefined,
): SceneFilter[] {
  return project('playlist', entries, (e) => ({
    mode: 'genre',
    id: e.playlistId,
    name: e.name,
    values: e.recipe?.knobs?.genres,
  }));
}

// ── The gatherer ────────────────────────────────────────────────────────────

/** Every filter over scene values the station holds. */
export function collectSceneFilters(): SceneFilter[] {
  return [
    ...showFilters(settings.get().shows),
    ...ruleFilters(blocklist.listRules()),
    ...recipeFilters(playlistRecipes.list()),
  ];
}

/**
 * The warning for `sources → target`: every filter that names a retired value
 * and stops catching it.
 *
 * Async and loads the blocklist ITSELF. Rules are only in memory after
 * `blocklist.load()`, and requiring each caller to know that is knowledge of
 * this module's own stores leaking outward — the third caller forgets, and the
 * failure is a silently short list rather than an error.
 *
 * The target is resolved through the rule set FIRST, using planAliases — the
 * same resolution `recordMerge` will apply, so the preview and the merge
 * response cannot disagree about which value actually survives when the
 * operator types a target that is itself already retired. Both callers pass
 * the raw body, and both get the answer for the merge that will happen.
 */
export async function sceneReferences(
  sources: readonly string[],
  target: string,
): Promise<SceneReference[]> {
  await blocklist.load();
  const resolved = sceneVocab.planAliases(sceneVocab.list(), sources, target, '').target;
  return orphanedFilters(collectSceneFilters(), sources, resolved);
}
