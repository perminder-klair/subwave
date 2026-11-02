// The storage shape every zero-shot vocabulary shares: a {label: cosine} map and
// a label list on `tracks`, plus a state hash on audio_embedding_meta. Column
// names are fixed unions, never caller input.

import { AUDIO_EMBEDDING_DIM, requireDb } from './handle.js';

export type ScoreColumn = 'audio_mood_scores_json' | 'audio_descriptor_scores_json';
export type LabelColumn = 'audio_moods' | 'audio_descriptors';
export type StateColumn = 'mood_vocab_hash' | 'descriptor_vocab_hash';

export interface ScoreMapRow {
  id: string;
  scores: Record<string, number>;
}

export function parseScoreMap(s: string): Record<string, number> | null {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function writeScoreMaps(column: ScoreColumn, rows: ScoreMapRow[]): void {
  if (rows.length === 0) return;
  const d = requireDb();
  const stmt = d.prepare(`UPDATE tracks SET ${column} = ? WHERE id = ?`);
  d.transaction((rs: typeof rows) => {
    for (const r of rs) stmt.run(JSON.stringify(r.scores), r.id);
  })(rows);
}

export function readScoreMap(column: ScoreColumn, id: string): Record<string, number> | null {
  const row = requireDb()
    .prepare(`SELECT ${column} AS s FROM tracks WHERE id = ?`)
    .get(id) as { s: string | null } | undefined;
  return row?.s ? parseScoreMap(row.s) : null;
}

// Every stored map, streamed (the input to computeBaselines). Unparseable rows
// are skipped so one corrupt blob can't deny calibration.
export function* iterateScoreMaps(column: ScoreColumn): Generator<ScoreMapRow> {
  const rows = requireDb()
    .prepare(`SELECT id, ${column} AS s FROM tracks WHERE ${column} IS NOT NULL ORDER BY id`)
    .iterate() as Iterable<{ id: string; s: string }>;
  for (const row of rows) {
    const scores = parseScoreMap(row.s);
    if (scores) yield { id: row.id, scores };
  }
}

// One page of stored maps, keyset-paginated on id (`afterId` exclusive, ''
// starts). Materialised, not streamed: better-sqlite3 refuses a write while a
// read cursor is live. `lastId` is the last id SCANNED, not returned, so a page
// ending on an unparseable row still advances the cursor. null = walk done.
export function pageScoreMaps(
  column: ScoreColumn,
  afterId: string,
  limit: number,
): { items: ScoreMapRow[]; lastId: string | null } {
  const rows = requireDb()
    .prepare(
      `SELECT id, ${column} AS s FROM tracks
        WHERE ${column} IS NOT NULL AND id > ?
        ORDER BY id LIMIT ?`,
    )
    .all(afterId, Math.max(1, Math.floor(limit))) as Array<{ id: string; s: string }>;
  const items: ScoreMapRow[] = [];
  for (const row of rows) {
    const scores = parseScoreMap(row.s);
    if (scores) items.push({ id: row.id, scores });
  }
  return { items, lastId: rows.length ? rows[rows.length - 1].id : null };
}

export function writeLabels(
  column: LabelColumn,
  rows: Array<{ id: string; labels: string[] }>,
): void {
  if (rows.length === 0) return;
  const d = requireDb();
  const stmt = d.prepare(`UPDATE tracks SET ${column} = ? WHERE id = ?`);
  d.transaction((rs: typeof rows) => {
    for (const r of rs) stmt.run(JSON.stringify(r.labels), r.id);
  })(rows);
}

// Incremental scope for an unchanged vocabulary. JOINed to tracks so a pruned
// track's vector is never scored.
export function idsMissingLabels(column: LabelColumn): string[] {
  const rows = requireDb()
    .prepare(
      `SELECT v.id FROM track_audio_vectors v JOIN tracks t ON t.id = v.id
       WHERE t.${column} IS NULL ORDER BY v.id`,
    )
    .all() as Array<{ id: string }>;
  return rows.map(r => r.id);
}

export function readStateHash(column: StateColumn): string | null {
  const row = requireDb()
    .prepare(`SELECT ${column} AS h FROM audio_embedding_meta WHERE pk = 1`)
    .get() as { h: string | null } | undefined;
  return row?.h ?? null;
}

export function writeStateHash(column: StateColumn, hash: string): void {
  // Seed defensively: model/dim are NOT NULL and setAudioEmbeddingMeta's upsert
  // never touches the hash.
  requireDb()
    .prepare(
      `INSERT INTO audio_embedding_meta (pk, model, dim, set_at, ${column})
       VALUES (1, 'unknown', ?, ?, ?)
       ON CONFLICT(pk) DO UPDATE SET ${column} = excluded.${column}`,
    )
    .run(AUDIO_EMBEDDING_DIM, new Date().toISOString(), hash);
}
