// Zero-shot audio moods: mood labels derived by scoring CLAP audio vectors
// against the mood vocabulary's text prompts (music/audio-moods.ts), plus the
// vocab hash that decides when a re-score is due.

import { AUDIO_EMBEDDING_DIM, requireDb } from './handle.js';
// Every backfill widening below shares the bpm/key scope's exclusion of tracks
// that have failed analysis too many times — a widening that forgets it is a
// scope that re-attempts unanalysable files forever (#1300 bug 3c).
import { analysisFailureExclusion } from './tracks.js';

// ---------------------------------------------------------------------------
// Zero-shot audio moods (music/audio-moods.ts) — mood labels derived by scoring
// the vocabulary's CLAP TEXT embeddings against each track's stored audio
// vector. Sound-derived, so they complement the LLM's metadata-guessed `moods`.
// ---------------------------------------------------------------------------

// Write raw cosines WITHOUT deriving labels — phase one of a calibrated pass.
// Labels can only be picked once every track's scores are on disk, because the
// per-mood baselines they are centred against are a property of the whole
// library (music/audio-calibration.ts). A crash between the two phases leaves
// audio_moods NULL, which idsNeedingAudioMoods picks up again next run, so the
// split is resumable rather than lossy.
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

// Every id carrying an audio vector — the full re-score scope when the mood
// vocabulary/prompts change. JOINed to tracks so a vector whose track row was
// pruned is never scored.
export function audioVectorIds(): string[] {
  const rows = requireDb()
    .prepare(
      `SELECT v.id FROM track_audio_vectors v JOIN tracks t ON t.id = v.id ORDER BY v.id`,
    )
    .all() as Array<{ id: string }>;
  return rows.map(r => r.id);
}

// Ids with an audio vector but no audio moods yet — the incremental scope for
// an unchanged vocabulary (newly analysed tracks since the last scoring pass).
export function idsNeedingAudioMoods(): string[] {
  const rows = requireDb()
    .prepare(
      `SELECT v.id FROM track_audio_vectors v JOIN tracks t ON t.id = v.id
       WHERE t.audio_moods IS NULL ORDER BY v.id`,
    )
    .all() as Array<{ id: string }>;
  return rows.map(r => r.id);
}

// The full {mood: cosine} score map behind a track's audio_moods — the
// dossier/tuning surface only (hot paths read the pre-picked audio_moods
// labels; this column is never parsed on a playback path).
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

// Every stored {mood: cosine} map, streamed. The input to the per-mood
// baselines (music/audio-calibration.ts computeBaselines) that calibration
// centres against, and the source a relabel pass re-derives from.
//
// A generator over better-sqlite3's own row iterator rather than a materialised
// array: this is one row per scored track for the WHOLE library, and the
// baselines only need running sums. Rows with unparseable JSON are skipped —
// one corrupt blob must not deny the library its calibration.
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

// One PAGE of stored score maps, keyset-paginated on id (`afterId` exclusive,
// '' starts). Returns a fully-materialised array — the cursor is closed before
// this returns.
//
// This exists because better-sqlite3 refuses a write on a connection that has
// a live read cursor: "This database connection is busy executing a query".
// Any pass that reads every score map AND writes as it goes (the relabel pass)
// must therefore page rather than stream. iterateAudioMoodScores is still the
// right shape for a pure read like the baselines, which writes nothing.
// `lastId` is the last id SCANNED, not the last one returned — a page whose
// final row had unparseable JSON still has to advance the caller's cursor past
// it, or the walk stalls on that row forever. null = the walk is done.
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
      // Skip the row, but never the cursor — see lastId above.
    }
  }
  return { items, lastId: rows.length ? rows[rows.length - 1].id : null };
}

// How many tracks carry a stored score map — the figure that decides whether
// the library is big enough to calibrate against (MIN_BASELINE_TRACKS).
export function audioMoodScoredCount(): number {
  return (requireDb().prepare(
    'SELECT COUNT(*) AS n FROM tracks WHERE audio_mood_scores_json IS NOT NULL',
  ).get() as { n: number }).n;
}

// Rewrite only the LABELS for a batch of tracks, leaving audio_mood_scores_json
// untouched. What a calibration-only change needs: the cosines on disk are
// still correct, so a relabel must never require the analyzer's text tower.
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

// Tracks whose energy came from tag PROPAGATION (a value inherited from
// embedding neighbours, not a per-track judgement) and that also carry audio
// scores — the scope the audio-derived energy correction may act on (#1362).
//
// Restricted to source = 'propagated' on purpose: an 'llm'/'manual'/'uncertain-llm'
// energy is a real decision about THIS track and is never overruled here.
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
      // Skip — same reasoning as iterateAudioMoodScores.
    }
  }
  return out;
}

// Bulk energy write for the correction pass. Touches `energy` ONLY: source,
// confidence and moods stay as propagation left them, so the row still reports
// honestly that its MOODS are inherited even once its energy is measured.
export function setTrackEnergyBulk(rows: Array<{ id: string; energy: string }>): void {
  if (rows.length === 0) return;
  const d = requireDb();
  const stmt = d.prepare(`UPDATE tracks SET energy = ? WHERE id = ?`);
  d.transaction((rs: typeof rows) => {
    for (const r of rs) stmt.run(r.energy, r.id);
  })(rows);
}

// The vocabulary hash the current audio_moods were scored with, or null (never
// scored / legacy meta row). A mismatch re-scores everything.
export function getAudioMoodVocabHash(): string | null {
  const row = requireDb()
    .prepare('SELECT mood_vocab_hash FROM audio_embedding_meta WHERE pk = 1')
    .get() as { mood_vocab_hash: string | null } | undefined;
  return row?.mood_vocab_hash ?? null;
}

export function setAudioMoodVocabHash(hash: string): void {
  // The meta row normally exists by the time moods are scored (the analyze pass
  // stamps it with the first vector), but seed defensively — model/dim are
  // NOT NULL, and setAudioEmbeddingMeta's own upsert never touches the hash.
  requireDb()
    .prepare(
      `INSERT INTO audio_embedding_meta (pk, model, dim, set_at, mood_vocab_hash)
       VALUES (1, 'unknown', ?, ?, ?)
       ON CONFLICT(pk) DO UPDATE SET mood_vocab_hash = excluded.mood_vocab_hash`,
    )
    .run(AUDIO_EMBEDDING_DIM, new Date().toISOString(), hash);
}

// Tracks with vocal-activity analysis done — vocal_ranges_json IS NOT NULL,
// where a stored "[]" (analysed instrumental) counts as done. The inverse of
// needsVocalIds, surfaced as a coverage meter (#646).
export function vocalAnalyzedCount(): number {
  return (requireDb().prepare(
    'SELECT COUNT(*) AS n FROM tracks WHERE vocal_ranges_json IS NOT NULL',
  ).get() as { n: number }).n;
}

// Ids that have no audio vector yet (never embedded). Resumable, ordered for
// stable resumption, independent of the bpm/key analysis scope so the audio
// backfill can run on its own cadence. LEFT JOIN where the vector row is absent.
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

// Ids with no vocal-activity analysis yet (vocal_ranges_json IS NULL — a stored
// "[]" instrumental counts as done and is skipped). Independent of the bpm/key
// scope, like unanalysedAudioIds, so the (expensive, opt-in) Demucs backfill
// runs on its own cadence. Ordered for stable resumption.
//
// `includeTailMissing` (feature: vocal-aware transitions) widens the scope to
// tracks whose outro was measured BEFORE tail vocal detection existed —
// head-analysed but tail-missing. The probe is textual on the raw outro_json:
// the worker/transport omit the vocalRanges key entirely when not computed
// (never write null), so its absence in the JSON.stringify output is exact.
// Tracks with outro_json NULL (short/truncated files) are excluded — they can
// never gain tail data, so including them would churn. Callers must only pass
// true when the backend advertises tail_vocal (analyzer.tailVocalAvailable()
// === true), or a stale sidecar re-analyses these tracks forever for a
// guaranteed no-op.
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

// Coverage meter companion to vocalAnalyzedCount — how many tracks have had a
// stem pass. Surfaced next to the analysis counts so the operator can see the
// backfill advancing instead of guessing from the folder size.
export function stemsCachedCount(): number {
  return (requireDb().prepare(
    'SELECT COUNT(*) AS n FROM tracks WHERE stems_at IS NOT NULL',
  ).get() as { n: number }).n;
}

// Total tracks known to the catalogue. Used by the analyze CLI to decide
// whether to walk Navidrome (only on an empty/bootstrap catalogue).
export function trackCount(): number {
  return (requireDb().prepare('SELECT COUNT(*) AS n FROM tracks').get() as {
    n: number;
  }).n;
}

// Drop track rows (and their vectors) for ids that are no longer in the live
// Navidrome catalogue. `liveIds` MUST be the id set from a COMPLETE, successful
// walk of subsonic.iterateAllSongs() — passing a partial set would delete live
// tags. Callers guard on a non-empty walk so a transient empty Navidrome
// response can't wipe the DB.
//
// Why this is needed: the walk only ever upserts, never deletes. A Navidrome
// full rescan can re-mint track IDs, orphaning every previous row; across
// several rescans the DB balloons far past the live catalogue. Those orphans
// inflate the coverage percentage past 100% and blow up the acoustic-analysis
// scope with dead, un-downloadable ids. Returns the number of rows deleted.
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

// Tracks with acoustic analysis. A track is "analysed" iff bpm IS NOT NULL
// (bpm/musical_key/intro_ms are written together by upsertTrackAnalysis).
export function analysedCount(): number {
  return (requireDb().prepare('SELECT COUNT(*) AS n FROM tracks WHERE bpm IS NOT NULL').get() as {
    n: number;
  }).n;
}

// IDs of tracks that already carry acoustic analysis (bpm filled). The re-scan
// "Re-analyse" scope — capture BEFORE clearAnalysis() so the redo targets only
// the previously-analysed population, not the whole (mostly un-analysed) library.
export function analysedIds(): string[] {
  return (
    requireDb()
      .prepare('SELECT id FROM tracks WHERE bpm IS NOT NULL ORDER BY id')
      .all() as Array<{ id: string }>
  ).map(r => r.id);
}


