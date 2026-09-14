// What still names a scene a merge is about to retire (#1593). A filter is
// orphaned when it NAMES the retired spelling (asked mutually, so a broader
// filter counts as narrowed rather than broken) and no longer catches the
// survivor (asked one-way, as the pick paths ask it). Both go through the real
// matching predicate, never a local fold. Warning only: nothing is rewritten,
// and an orphaned filter is not proven to match nothing.

import * as blocklist from './blocklist.js';
import * as playlistRecipes from './playlist-recipes.js';
import * as sceneVocab from './scene-vocab.js';
import { dedupeScenes } from './scene-vocab.js';
import { normText } from './blocklist-rules.js';
import { genreMatches, normGenre } from './show-filter.js';
import * as settings from '../settings.js';
import type { SceneReference, SceneReferenceKind } from '../schemas/library.js';

export type { SceneReference, SceneReferenceKind };

/** `genre` is boundary-aware `genreMatches`; `tag` is exact `normText` (#1611). */
export type MatchMode = 'genre' | 'tag';

/** One thing naming scene values, flattened to what the scan needs. */
export interface SceneFilter {
  kind: SceneReferenceKind;
  mode: MatchMode;
  id: string;
  name: string;
  values: readonly string[];
}

/**
 * Does a filter value still select a track carrying `scene`? Asked of the real
 * pick-path predicates, never a local comparison, so the direction can't drift.
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

/** Mutual coverage: this value IS that scene, not merely broader than it. */
export function filterNamesScene(mode: MatchMode, filterValue: string, scene: string): boolean {
  return (
    filterCatchesScene(mode, filterValue, scene) && filterCatchesScene(mode, scene, filterValue)
  );
}

/** Filters losing a value they NAME to `sources -> target`; others are absent. */
export function orphanedFilters(
  filters: readonly SceneFilter[],
  sources: readonly string[],
  target: string,
): SceneReference[] {
  // Shared trim-and-drop-blanks; its case-dedupe can't change an answer here.
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

/** Only these fields of a store's row are read. */
export interface ShowLike { id?: unknown; name?: unknown; genres?: unknown }

/** A show's `genres`: free text, resolved against the library at pick time. */
export function showFilters(shows: readonly ShowLike[] | null | undefined): SceneFilter[] {
  return project('show', shows, (s) => ({
    mode: 'genre',
    id: s.id,
    name: s.name,
    values: s.genres,
  }));
}

/**
 * Never-play rules on `genre` and `tag`. A `tag` rule matches `trackAllTags`
 * (genres, moods, audio moods, Last.fm), so it is in scope under its own
 * stricter predicate; the other fields name vocabularies a merge can't touch.
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

/** A sync-enabled recipe's `knobs.genres`; a plain saved playlist holds tracks. */
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

/** Every filter over scene values the station holds. */
export function collectSceneFilters(): SceneFilter[] {
  return [
    ...showFilters(settings.get().shows),
    ...ruleFilters(blocklist.listRules()),
    ...recipeFilters(playlistRecipes.list()),
  ];
}

/**
 * The warning for `sources -> target`. Loads the blocklist itself, since rules
 * are only in memory after `load()` and a caller that forgets gets a short list.
 * The target resolves through `planAliases`, the same resolution `recordMerge`
 * applies, so preview and merge response cannot disagree.
 */
export async function sceneReferences(
  sources: readonly string[],
  target: string,
): Promise<SceneReference[]> {
  await blocklist.load();
  const resolved = sceneVocab.planAliases(sceneVocab.list(), sources, target, '').target;
  return orphanedFilters(collectSceneFilters(), sources, resolved);
}
