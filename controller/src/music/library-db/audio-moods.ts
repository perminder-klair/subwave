// Zero-shot audio moods: labels from scoring CLAP audio vectors against the
// mood vocabulary's prompts, plus the vocab hash that decides a re-score.

import { AUDIO_EMBEDDING_DIM, requireDb } from './handle.js';
// Every backfill scope must keep this exclusion, or an unanalysable file is
// re-attempted forever (#1300).
import { analysisFailureExclusion } from './tracks.js';

// Phase one of a calibrated pass: raw cosines only, since the per-mood
// baselines need the whole library on disk first. A crash between phases leaves
// audio_moods NULL, which idsNeedingAudioMoods re-picks up.
export function setTrackAudioMoodScoresBulk(
  rows: Array<{ id: string; scores: Record<string, number> }>,
): void {
  if (rows.length === 0) return;
  const d = requireDb();
  const stmt = d.prepare(`UPDATE tracks SET audio_mood_scores_json = ? WHERE id = ?`);
  d.transaction((rs: typeof rows) => {
    for (const r of rs) stmt.run(JSON.stringify(r.scores), r.id);
  })(rows);
}

// Full re-score scope for a changed vocabulary. JOINed to tracks so a pruned
// track's vector is never scored.
export function audioVectorIds(): string[] {
  const rows = requireDb()
    .prepare(
      `SELECT v.id FROM track_audio_vectors v JOIN tracks t ON t.id = v.id ORDER BY v.id`,
    )
    .all() as Array<{ id: string }>;
  return rows.map(r => r.id);
}

// Incremental scope for an unchanged vocabulary.
export function idsNeedingAudioMoods(): string[] {
  const rows = requireDb()
    .prepare(
      `SELECT v.id FROM track_audio_vectors v JOIN tracks t ON t.id = v.id
       WHERE t.audio_moods IS NULL ORDER BY v.id`,
    )
    .all() as Array<{ id: string }>;
  return rows.map(r => r.id);
}

// Dossier/tuning only; hot paths read the pre-picked audio_moods labels.
export function getAudioMoodScores(id: string): Record<string, number> | null {
  const row = requireDb()
    .prepare('SELECT audio_mood_scores_json AS s FROM tracks WHERE id = ?')
    .get(id) as { s: string | null } | undefined;
  if (!row?.s) return null;
  try {
    const v = JSON.parse(row.s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// Every stored {mood: cosine} map, streamed (the input to computeBaselines).
// Unparseable rows are skipped so one corrupt blob can't deny calibration.
export function* iterateAudioMoodScores(): Generator<{ id: string; scores: Record<string, number> }> {
  const rows = requireDb()
    .prepare(
      `SELECT id, audio_mood_scores_json AS s FROM tracks
        WHERE audio_mood_scores_json IS NOT NULL ORDER BY id`,
    )
    .iterate() as Iterable<{ id: string; s: string }>;
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.s);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    yield { id: row.id, scores: parsed as Record<string, number> };
  }
}

// One page of stored score maps, keyset-paginated on id (`afterId` exclusive,
// '' starts). Materialised, not streamed: better-sqlite3 refuses a write while a
// read cursor is live. `lastId` is the last id SCANNED, not returned, so a page
// ending on an unparseable row still advances the cursor. null = walk done.
export function pageAudioMoodScores(
  afterId: string,
  limit: number,
): { items: Array<{ id: string; scores: Record<string, number> }>; lastId: string | null } {
  const rows = requireDb()
    .prepare(
      `SELECT id, audio_mood_scores_json AS s FROM tracks
        WHERE audio_mood_scores_json IS NOT NULL AND id > ?
        ORDER BY id LIMIT ?`,
    )
    .all(afterId, Math.max(1, Math.floor(limit))) as Array<{ id: string; s: string }>;
  const items: Array<{ id: string; scores: Record<string, number> }> = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.s);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        items.push({ id: row.id, scores: parsed as Record<string, number> });
      }
    } catch {
      // Skip the row, never the cursor (see lastId).
    }
  }
  return { items, lastId: rows.length ? rows[rows.length - 1].id : null };
}

// Decides whether the library is big enough to calibrate.
export function audioMoodScoredCount(): number {
  return (requireDb().prepare(
    'SELECT COUNT(*) AS n FROM tracks WHERE audio_mood_scores_json IS NOT NULL',
  ).get() as { n: number }).n;
}

// Labels only; a calibration-only change must not need the analyzer's text tower.
export function setTrackAudioMoodLabelsBulk(
  rows: Array<{ id: string; moods: string[] }>,
): void {
  if (rows.length === 0) return;
  const d = requireDb();
  const stmt = d.prepare(`UPDATE tracks SET audio_moods = ? WHERE id = ?`);
  d.transaction((rs: typeof rows) => {
    for (const r of rs) stmt.run(JSON.stringify(r.moods), r.id);
  })(rows);
}

// Scope of the audio-derived energy correction (#1362). Restricted to
// source = 'propagated': an llm/manual energy is never overruled here.
export function propagatedTracksWithAudioScores(): Array<{
  id: string;
  energy: string | null;
  scores: Record<string, number>;
}> {
  const rows = requireDb()
    .prepare(
      `SELECT id, energy, audio_mood_scores_json AS s FROM tracks
        WHERE source = 'propagated' AND audio_mood_scores_json IS NOT NULL
        ORDER BY id`,
    )
    .all() as Array<{ id: string; energy: string | null; s: string }>;
  const out: Array<{ id: string; energy: string | null; scores: Record<string, number> }> = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.s);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out.push({ id: row.id, energy: row.energy, scores: parsed as Record<string, number> });
      }
    } catch {
    }
  }
  return out;
}

// Touches `energy` only; source/confidence/moods stay as propagation left them.
export function setTrackEnergyBulk(rows: Array<{ id: string; energy: string }>): void {
  if (rows.length === 0) return;
  const d = requireDb();
  const stmt = d.prepare(`UPDATE tracks SET energy = ? WHERE id = ?`);
  d.transaction((rs: typeof rows) => {
    for (const r of rs) stmt.run(r.energy, r.id);
  })(rows);
}

// Hash the current audio_moods were scored with, or null. A mismatch re-scores.
export function getAudioMoodVocabHash(): string | null {
  const row = requireDb()
    .prepare('SELECT mood_vocab_hash FROM audio_embedding_meta WHERE pk = 1')
    .get() as { mood_vocab_hash: string | null } | undefined;
  return row?.mood_vocab_hash ?? null;
}

export function setAudioMoodVocabHash(hash: string): void {
  // Seed defensively: model/dim are NOT NULL and setAudioEmbeddingMeta's upsert
  // never touches the hash.
  requireDb()
    .prepare(
      `INSERT INTO audio_embedding_meta (pk, model, dim, set_at, mood_vocab_hash)
       VALUES (1, 'unknown', ?, ?, ?)
       ON CONFLICT(pk) DO UPDATE SET mood_vocab_hash = excluded.mood_vocab_hash`,
    )
    .run(AUDIO_EMBEDDING_DIM, new Date().toISOString(), hash);
}

// Coverage meter, inverse of needsVocalIds (#646); a stored "[]" counts as done.
export function vocalAnalyzedCount(): number {
  return (requireDb().prepare(
    'SELECT COUNT(*) AS n FROM tracks WHERE vocal_ranges_json IS NOT NULL',
  ).get() as { n: number }).n;
}

// Ordered for stable resumption; independent of the bpm/key scope.
export function unanalysedAudioIds(limit?: number): string[] {
  const where = `v.id IS NULL AND ${analysisFailureExclusion('t')}`;
  const q = limit && limit > 0
    ? `SELECT t.id FROM tracks t LEFT JOIN track_audio_vectors v ON v.id = t.id
       WHERE ${where} ORDER BY t.id LIMIT ${Math.floor(limit)}`
    : `SELECT t.id FROM tracks t LEFT JOIN track_audio_vectors v ON v.id = t.id
       WHERE ${where} ORDER BY t.id`;
  const rows = requireDb().prepare(q).all() as Array<{ id: string }>;
  return rows.map(r => r.id);
}

// Ids with no vocal-activity analysis; a stored "[]" counts as done. Ordered for
// stable resumption. `includeTailMissing` widens to head-analysed rows missing
// tail data: the probe is textual on outro_json because the worker omits the
// vocalRanges key rather than writing null. Only pass true when
// analyzer.tailVocalAvailable(), or a stale sidecar re-analyses these forever.
export function needsVocalIds(limit?: number, includeTailMissing = false): string[] {
  const missing = includeTailMissing
    ? `(vocal_ranges_json IS NULL
       OR (outro_json IS NOT NULL AND outro_json NOT LIKE '%"vocalRanges"%'))`
    : `vocal_ranges_json IS NULL`;
  const where = `${missing} AND ${analysisFailureExclusion()}`;
  const q =
    `SELECT id FROM tracks WHERE ${where} ORDER BY id` +
    (limit && limit > 0 ? ` LIMIT ${Math.floor(limit)}` : '');
  const rows = requireDb().prepare(q).all() as Array<{ id: string }>;
  return rows.map(r => r.id);
}

// Ids that have never had a stem-caching pass, ordered for stable resumption.
// stems_at stamps the ATTEMPT, not disk presence, so this converges against the
// LRU sweep's evictions.
export function needsStemsIds(limit?: number): string[] {
  const q =
    `SELECT id FROM tracks WHERE stems_at IS NULL AND ${analysisFailureExclusion()} ORDER BY id` +
    (limit && limit > 0 ? ` LIMIT ${Math.floor(limit)}` : '');
  const rows = requireDb().prepare(q).all() as Array<{ id: string }>;
  return rows.map(r => r.id);
}

export function stemsCachedCount(): number {
  return (requireDb().prepare(
    'SELECT COUNT(*) AS n FROM tracks WHERE stems_at IS NOT NULL',
  ).get() as { n: number }).n;
}

// The analyze CLI walks Navidrome only when this is 0.
export function trackCount(): number {
  return (requireDb().prepare('SELECT COUNT(*) AS n FROM tracks').get() as {
    n: number;
  }).n;
}

// Drop track rows (and vectors) for ids no longer in Navidrome. `liveIds` must
// come from a COMPLETE walk of subsonic.iterateAllSongs(): a partial set deletes
// live tags. Returns rows deleted.
export function pruneMissingTracks(liveIds: ReadonlySet<string>): number {
  const d = requireDb();
  const all = (d.prepare('SELECT id FROM tracks').all() as Array<{ id: string }>).map(r => r.id);
  const orphans = all.filter(id => !liveIds.has(id));
  if (orphans.length === 0) return 0;
  const delTrack = d.prepare('DELETE FROM tracks WHERE id = ?');
  const delVec = d.prepare('DELETE FROM track_vectors WHERE id = ?');
  const delAudioVec = d.prepare('DELETE FROM track_audio_vectors WHERE id = ?');
  const runPrune = d.transaction((ids: string[]) => {
    for (const id of ids) {
      delTrack.run(id);
      delVec.run(id);
      delAudioVec.run(id);
    }
  });
  runPrune(orphans);
  return orphans.length;
}

// "Analysed" means bpm IS NOT NULL; upsertTrackAnalysis writes bpm/key/intro
// together.
export function analysedCount(): number {
  return (requireDb().prepare('SELECT COUNT(*) AS n FROM tracks WHERE bpm IS NOT NULL').get() as {
    n: number;
  }).n;
}

// The "Re-analyse" scope. Capture BEFORE clearAnalysis(), or the redo targets
// the whole unanalysed library.
export function analysedIds(): string[] {
  return (
    requireDb()
      .prepare('SELECT id FROM tracks WHERE bpm IS NOT NULL ORDER BY id')
      .all() as Array<{ id: string }>
  ).map(r => r.id);
}


