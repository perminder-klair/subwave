// Zero-shot audio moods: labels from scoring CLAP audio vectors against the
// mood vocabulary's prompts, plus the vocab hash that decides a re-score.

import { requireDb } from './handle.js';
import {
  idsMissingLabels,
  iterateScoreMaps,
  pageScoreMaps,
  readScoreMap,
  readStateHash,
  writeLabels,
  writeScoreMaps,
  writeStateHash,
} from './audio-scores.js';
// Every backfill scope must keep this exclusion, or an unanalysable file is
// re-attempted forever (#1300).
import { analysisFailureExclusion, forgetVectorSoundIfMoved, markTextVectorDirtyIfSoundChanged } from './tracks.js';
import { deleteFacetRows } from './facets.js';
import { touchGenreInputs } from './genre-inputs.js';

// Phase one of a calibrated pass: raw cosines only, since the per-mood
// baselines need the whole library on disk first. A crash between phases leaves
// audio_moods NULL, which idsNeedingAudioMoods re-picks up.
export function setTrackAudioMoodScoresBulk(
  rows: Array<{ id: string; scores: Record<string, number> }>,
): void {
  writeScoreMaps('audio_mood_scores_json', rows);
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
  return idsMissingLabels('audio_moods');
}

// Dossier/tuning only; hot paths read the pre-picked audio_moods labels.
export function getAudioMoodScores(id: string): Record<string, number> | null {
  return readScoreMap('audio_mood_scores_json', id);
}

// Every stored {mood: cosine} map, streamed (the input to computeBaselines).
export function iterateAudioMoodScores(): Generator<{ id: string; scores: Record<string, number> }> {
  return iterateScoreMaps('audio_mood_scores_json');
}

// One page of stored score maps (see pageScoreMaps).
export function pageAudioMoodScores(
  afterId: string,
  limit: number,
): { items: Array<{ id: string; scores: Record<string, number> }>; lastId: string | null } {
  return pageScoreMaps('audio_mood_scores_json', afterId, limit);
}

// Labels only; a calibration-only change must not need the analyzer's text tower.
export function setTrackAudioMoodLabelsBulk(
  rows: Array<{ id: string; moods: string[] }>,
): void {
  writeLabels('audio_moods', rows.map(({ id, moods }) => ({ id, labels: moods })));
}

// The incremental pass's write, for tracks that had no labels. The moods are
// words on the embed text's Sound: line, so a vector built without these marks
// itself for the next phaseEmbed (#2236). Moods only: the measured words are
// the analysis writes', and on a re-analyze they land before these do.
export function setNewTrackAudioMoodLabelsBulk(
  rows: Array<{ id: string; moods: string[] }>,
): void {
  if (rows.length === 0) return;
  requireDb().transaction(() => {
    setTrackAudioMoodLabelsBulk(rows);
    for (const { id } of rows) markTextVectorDirtyIfSoundChanged(id, ['moods']);
  })();
}

// The relabel-all's write (a vocabulary or calibration change, or crossing the
// floor). It never marks, and where it moves the mood words a vector was built
// from it forgets them (tracks.ts forgetVectorSoundIfMoved), or the next
// identical --re-analyze would mark every row it moved (#2236).
export function setRelabelledTrackAudioMoodLabelsBulk(
  rows: Array<{ id: string; moods: string[] }>,
): void {
  if (rows.length === 0) return;
  requireDb().transaction(() => {
    setTrackAudioMoodLabelsBulk(rows);
    for (const { id } of rows) forgetVectorSoundIfMoved(id, 'moods');
  })();
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
  return readStateHash('mood_vocab_hash');
}

export function setAudioMoodVocabHash(hash: string): void {
  writeStateHash('mood_vocab_hash', hash);
}

// Coverage meter, inverse of needsVocalIds (#646); a stored "[]" counts as done.
// Spelled as idx_tracks_vocal_measured's expression so the count reads that
// index, never the wide rows (#1937).
export function vocalAnalyzedCount(): number {
  return (requireDb().prepare(
    'SELECT COUNT(*) AS n FROM tracks WHERE (vocal_ranges_json IS NOT NULL) = 1',
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

// The stem-cache backfill scope moved to ./stem-scan.ts when its `ORDER BY id`
// became a ranking (#1622 FR 14) — needsStemsIds now joins the play history and
// projects music/stem-priority.ts, which is a page of query rather than a
// sibling of the two backfill scopes above. Still re-exported from the same
// library-db barrel.

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

// How many track rows a prune against `liveIds` would delete (music/prune-policy.ts
// decides whether it may).
export function countMissingTracks(liveIds: ReadonlySet<string>): number {
  const all = requireDb().prepare('SELECT id FROM tracks').all() as Array<{ id: string }>;
  let n = 0;
  for (const r of all) if (!liveIds.has(r.id)) n += 1;
  return n;
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
      deleteFacetRows(id);
    }
    touchGenreInputs(d);
  });
  runPrune(orphans);
  return orphans.length;
}

// "Analysed" means bpm IS NOT NULL; upsertTrackAnalysis writes bpm/key/intro
// together. Answered from idx_tracks_analysed alone (#1937).
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


