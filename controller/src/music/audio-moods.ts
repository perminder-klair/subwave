// Zero-shot audio mood scoring: cosine between a mood description embedded by
// CLAP's text tower and a track's stored audio vector (both live in the same
// 512-d space). One analyzer round-trip embeds the vocabulary; the rest is
// in-process dot products. Results land in tracks.audio_moods, which songsByMood
// blends with the LLM's metadata-derived tags at retrieval time.
//
// Everything degrades to a no-op — no vectors, no backend, a lean backend
// without the text tower, or a mid-pass failure all log and skip.

import crypto from 'node:crypto';
import * as db from './library-db.js';
import * as analyzer from './analyzer.js';
import { moodVocab, moodPromptFor } from '../settings.js';
import { makeEventLogger } from './tagger-progress.js';
import {
  computeBaselines,
  moodPassAction,
  moodStateHashFor,
  prunedBaselines,
  selectAudioMoods,
  type MoodBaselines,
} from './audio-calibration.js';

const logEvent = makeEventLogger('audio-moods');

// Prompt for one mood: its operator-edited CLAP sound-description
// (settings.moods[].clapPrompt), or the bare word. CLAP was trained on audio
// captions, so "how it sounds" phrasing scores far better. Changing a prompt
// changes moodVocabHash() and re-scores the library on the next pass.
export function moodPrompt(mood: string): string {
  return moodPromptFor(mood);
}

// Hash of the vocabulary + prompts the stored audio_moods were scored with,
// kept in audio_embedding_meta.mood_vocab_hash; a mismatch re-scores every
// vector-carrying track.
export function moodVocabHash(vocab: readonly string[] = moodVocab()): string {
  const h = crypto.createHash('sha256');
  for (const m of vocab) h.update(`${m}=${moodPrompt(m)}|`);
  return h.digest('hex').slice(0, 16);
}

// Top audio moods on the RAW cosine axis, no per-mood calibration — where a
// library too small for baselines also lands. Live passes go through
// selectAudioMoods with baselines.
export function topAudioMoods(
  scores: Record<string, number>,
  { max = 3, margin = 0.05 }: { max?: number; margin?: number } = {},
): string[] {
  return selectAudioMoods(scores, null, { max, margin });
}

function dot(a: Float32Array, b: number[]): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export interface AudioMoodStats {
  scored: number;
  scope: number;
  skipped: string | null; // reason when the pass didn't run (null = ran/empty)
  relabelled?: number;    // labels re-derived from stored cosines
  calibrated?: boolean;
}

// Per-mood baselines from every score map on disk. null = library too small to
// calibrate; callers pass that straight to selectAudioMoods (raw selection).
function loadBaselines(): MoodBaselines | null {
  const baselines = computeBaselines(
    (function* () {
      for (const row of db.iterateAudioMoodScores()) yield row.scores;
    })(),
  );
  // Pruned, not gated: a mood scored on too few tracks is dropped so a
  // degenerate sd can't let it dominate selection.
  return prunedBaselines(baselines);
}

// Re-derive labels for every scored track from the cosines already on disk. No
// analyzer round-trip: a calibration change invalidates the labels, not the
// scores, and the CLAP text tower is opt-in (ANALYZER_HEAVY).
// PAGED, not streamed: better-sqlite3 refuses a write while a read cursor is
// open on the same connection, and this loop writes as it walks.
export function relabelFromStoredScores(baselines: MoodBaselines | null): number {
  const PAGE = 500;
  let done = 0;
  let cursor = '';
  for (;;) {
    const { items, lastId } = db.pageAudioMoodScores(cursor, PAGE);
    if (lastId == null) break;
    db.setTrackAudioMoodLabelsBulk(
      items.map(({ id, scores }) => ({ id, moods: selectAudioMoods(scores, baselines) })),
    );
    done += items.length;
    cursor = lastId;
  }
  return done;
}

// Score audio moods for every track that needs it. Incremental by default
// (vector present, audio_moods NULL); a vocabulary/prompt change re-scores the
// whole vector-carrying set. Cheap when there is nothing to do.
export async function runAudioMoodPass(): Promise<AudioMoodStats> {
  if (db.audioVectorCount() === 0) {
    return { scored: 0, scope: 0, skipped: 'no audio vectors' };
  }

  const hash = moodVocabHash();
  const stored = db.getAudioMoodVocabHash();
  // Two reasons to redo work, at very different cost: a vocabulary change
  // invalidates the cosines (full CLAP re-score), a calibration change only the
  // labels (re-derive from disk).
  const action = moodPassAction(stored, hash);
  const vocabChanged = action === 'rescore';
  const ids = vocabChanged ? db.audioVectorIds() : db.idsNeedingAudioMoods();

  // Nothing new to score, but a pending relabel still has to run (no analyzer
  // needed).
  if (ids.length === 0) {
    if (action !== 'relabel') return { scored: 0, scope: 0, skipped: null };
    const baselines = loadBaselines();
    const relabelled = relabelFromStoredScores(baselines);
    db.setAudioMoodVocabHash(moodStateHashFor(hash, !!baselines));
    logEvent(
      'success',
      `Re-derived audio mood labels for ${relabelled.toLocaleString('en-GB')} tracks ` +
        `(per-mood calibration${baselines ? '' : ' unavailable — library too small, raw selection'})`,
    );
    return { scored: 0, scope: 0, skipped: null, relabelled, calibrated: !!baselines };
  }

  // One round-trip for the whole vocabulary; the first call after a cold boot
  // may lazy-load or download the CLAP text tower. Snapshot the live vocab once
  // so prompts and the scoring loop stay index-aligned.
  const vocab = moodVocab();
  const prompts = vocab.map(moodPrompt);
  // coldRetry off: at this deadline a timeout means a broken backend, not a
  // cold one, and retrying would just stall the pass for another 10 minutes.
  const vecs = await analyzer.embedTexts(prompts, { timeoutMs: 10 * 60_000, coldRetry: false });
  if (!vecs || vecs.length !== vocab.length) {
    // A backend that advertises the text tower but failed the call is a runtime
    // fault (#996), not a lean build; "enable ANALYZER_HEAVY" would send the
    // operator the wrong way.
    if (analyzer.textEmbeddingAvailable() === true) {
      logEvent(
        'warning',
        'Text embedding failed even though the backend reports a CLAP text tower — check the analyzer container logs; skipping audio moods',
      );
      return { scored: 0, scope: ids.length, skipped: 'text embedding failed' };
    }
    logEvent(
      'info',
      'Backend has no CLAP text tower — skipping audio moods (ANALYZER_HEAVY=1 enables it)',
    );
    return { scored: 0, scope: ids.length, skipped: 'no text tower' };
  }

  logEvent(
    'info',
    `Scoring audio moods for ${ids.length.toLocaleString('en-GB')} tracks` +
      (vocabChanged ? ' (vocabulary changed — full re-score)' : '') + '…',
  );

  // Phase 1, score. Cosines only: selection is centred on baselines drawn from
  // the whole library, which on a full re-score are a property of the scores
  // being written right now. Score maps are held only on an incremental pass
  // (bounded by the new tracks); a full re-score relabels from disk in phase 3.
  const relabelAll = vocabChanged || action === 'relabel';
  const scoredRows: Array<{ id: string; scores: Record<string, number> }> = [];
  let scored = 0;
  let batch: Array<{ id: string; scores: Record<string, number> }> = [];
  for (const id of ids) {
    const v = db.getAudioVector(id);
    if (!v) continue;
    const scores: Record<string, number> = {};
    for (let i = 0; i < vocab.length; i++) {
      // Both sides are L2-normalised, so the dot IS the cosine. 3 decimals
      // keeps the stored JSON small.
      scores[vocab[i]] = Math.round(dot(v, vecs[i]) * 1000) / 1000;
    }
    batch.push({ id, scores });
    if (!relabelAll) scoredRows.push({ id, scores });
    scored += 1;
    if (batch.length >= 500) {
      db.setTrackAudioMoodScoresBulk(batch);
      batch = [];
      console.log(`[audio-moods] ${scored}/${ids.length}`);
    }
  }
  db.setTrackAudioMoodScoresBulk(batch);

  // Phase 2, calibrate.
  const baselines = loadBaselines();

  // Phase 3, label. A full re-score relabels everything (every track's axis just
  // moved); an incremental pass labels only what it scored, since a handful of
  // new tracks cannot shift a library-wide distribution.
  let relabelled = 0;
  if (relabelAll) {
    relabelled = relabelFromStoredScores(baselines);
  } else {
    let labels: Array<{ id: string; moods: string[] }> = [];
    for (const { id, scores } of scoredRows) {
      labels.push({ id, moods: selectAudioMoods(scores, baselines) });
      relabelled += 1;
      if (labels.length >= 500) {
        db.setTrackAudioMoodLabelsBulk(labels);
        labels = [];
      }
    }
    db.setTrackAudioMoodLabelsBulk(labels);
  }

  db.setAudioMoodVocabHash(moodStateHashFor(hash, !!baselines));
  logEvent(
    'success',
    `Audio moods scored — ${scored.toLocaleString('en-GB')} tracks` +
      (baselines ? ' (per-mood calibration applied)' : ' (uncalibrated — library too small)'),
  );
  return { scored, scope: ids.length, skipped: null, relabelled, calibrated: !!baselines };
}
