// Scene (genre-tag) vocabulary: what the mirror holds, and the in-place merge
// that consolidates it (issue #1577).
//
// The listing is a json_each walk over `tracks.genres` — the same shape
// stats() computes for byGenre, but uncached and unfiltered by tagging state:
// the operator is curating the tag set, and an untagged track's genre is as
// noisy as a tagged one's.
//
// The merge is ONE transaction over the rows that actually carry a retired
// value. Row-at-a-time in JS rather than a `json_replace` expression because
// the dedupe (a track tagged both spellings must end up with one tag, not two
// identical ones) and the order-preserving rewrite are the same rules
// `subsonic.songGenres` applies at ingest — stated once, in JS, in
// music/scene-vocab.ts, rather than twice in two languages.
//
// Sources match on the EXACT stored value the caller passed: the listing hands
// the operator real distinct values to tick, so there is nothing to fold here
// and no way for a fold to reach a row the operator could not see.

import { requireDb } from './handle.js';
import { invalidateStats } from './stats.js';
import { safeParseArray } from './rows.js';

export interface SceneCount {
  value: string;
  tracks: number;
}

export interface SceneMergeResult {
  /** Distinct stored values that were actually present and rewritten. */
  sources: string[];
  tracksChanged: number;
  /** Rewritten rows that already had a text vector, so it is now stale. */
  vectorsDirtied: number;
}

/** Every distinct scene value in the mirror with its track count, biggest first. */
export function sceneVocabulary(): SceneCount[] {
  const rows = requireDb()
    .prepare(
      `SELECT je.value AS value, COUNT(*) AS tracks
         FROM tracks, json_each(tracks.genres) je
        WHERE tracks.genres IS NOT NULL
        GROUP BY je.value
        ORDER BY tracks DESC, value ASC`,
    )
    .all() as Array<{ value: unknown; tracks: number }>;
  const out: SceneCount[] = [];
  for (const r of rows) {
    if (typeof r.value !== 'string' || r.value.trim() === '') continue;
    out.push({ value: r.value, tracks: r.tracks });
  }
  return out;
}

/**
 * Rewrite every `sources` tag to `target` across the mirror, in one transaction.
 *
 * The scalar `genre` column is GENERATED over genres[0], so it follows without
 * a second write. A rewritten row's text vector is marked dirty (the embed text
 * carries the genre line), the same way an era change does — it stays in the
 * KNN index until the next embed pass replaces it, rather than leaving a hole.
 */
export function mergeScenes(sources: readonly string[], target: string): SceneMergeResult {
  const to = String(target ?? '').trim();
  const from = [...new Set(sources.map((s) => String(s ?? '')).filter((s) => s.trim() !== ''))]
    .filter((s) => s.toLowerCase() !== to.toLowerCase());
  if (!to || from.length === 0) return { sources: [], tracksChanged: 0, vectorsDirtied: 0 };

  const d = requireDb();
  const holes = from.map(() => '?').join(', ');
  const rows = d
    .prepare(
      `SELECT id, genres FROM tracks
        WHERE genres IS NOT NULL
          AND EXISTS (SELECT 1 FROM json_each(tracks.genres) WHERE value IN (${holes}))`,
    )
    .all(...from) as Array<{ id: string; genres: string }>;

  const retired = new Set(from);
  const update = d.prepare(`UPDATE tracks SET genres = ? WHERE id = ?`);
  const dirty = d.prepare(
    `UPDATE tracks SET text_vector_dirty = 1
      WHERE id = ? AND EXISTS (SELECT 1 FROM track_vectors WHERE id = tracks.id)`,
  );

  const result: SceneMergeResult = { sources: [], tracksChanged: 0, vectorsDirtied: 0 };
  const hit = new Set<string>();
  const tx = d.transaction(() => {
    for (const row of rows) {
      const before = safeParseArray(row.genres);
      const after: string[] = [];
      for (const raw of before) {
        if (retired.has(raw)) hit.add(raw);
        const value = (retired.has(raw) ? to : raw).trim();
        if (!value) continue;
        if (!after.some((x) => x.toLowerCase() === value.toLowerCase())) after.push(value);
      }
      const next = JSON.stringify(after);
      if (next === JSON.stringify(before)) continue;
      update.run(next, row.id);
      result.tracksChanged += 1;
      result.vectorsDirtied += dirty.run(row.id).changes;
    }
  });
  tx();

  // The tallies the panel and the picker's tool descriptions read are memoised.
  if (result.tracksChanged > 0) invalidateStats();
  result.sources = from.filter((s) => hit.has(s));
  return result;
}
