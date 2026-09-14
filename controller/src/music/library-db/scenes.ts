// Scene (genre-tag) vocabulary and the in-place merge that consolidates it (#1577).
// The listing is uncached and NOT scoped to tagged rows. The merge rewrites
// row-at-a-time in JS so it shares scene-vocab's dedupe with the ingest half, and
// sources match the EXACT stored value the caller passed.

import { requireDb } from './handle.js';
import { invalidateStats } from './stats.js';
import { safeParseArray } from './rows.js';
import { dedupeScenes } from '../scene-vocab.js';

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
 * The scalar `genre` column is GENERATED over genres[0] and follows without a
 * second write. A rewritten row's text vector is marked dirty (the embed text
 * carries the genre line) and stays in the KNN index until the next embed pass.
 */
export function mergeScenes(sources: readonly string[], target: string): SceneMergeResult {
  const to = String(target ?? '').trim();
  // Dropped only when it is the target VERBATIM (the test planAliases applies) —
  // a case-insensitive test would make a pure case merge a no-op.
  const from = [...new Set(sources.map((s) => String(s ?? '')).filter((s) => s.trim() !== ''))]
    .filter((s) => s !== to);
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
      const substituted = before.map((raw) => {
        if (!retired.has(raw)) return raw;
        hit.add(raw);
        return to;
      });
      // Shared with the ingest half via applyAliases.
      const after = dedupeScenes(substituted);
      const next = JSON.stringify(after);
      if (next === JSON.stringify(before)) continue;
      update.run(next, row.id);
      result.tracksChanged += 1;
      result.vectorsDirtied += dirty.run(row.id).changes;
    }
  });
  tx();

  if (result.tracksChanged > 0) invalidateStats();
  result.sources = from.filter((s) => hit.has(s));
  return result;
}
