// Zero-shot audio mood scoring — grounds the mood vocabulary in how each track
// actually SOUNDS, instead of what its title/artist suggest to an LLM.
//
// CLAP is trained contrastively on audio–text pairs, so its text tower and
// audio tower share one 512-d space: the cosine between a mood *description*
// embedded as text and a track's stored audio vector is a meaningful "does the
// track sound like this?" score. The audio vectors already exist (the analyze
// pass writes them), so scoring needs exactly one analyzer round-trip — embed
// the vocabulary prompts — and the rest is in-process dot products. Results
// land in tracks.audio_moods, which songsByMood blends with the LLM's
// metadata-derived tags at retrieval time.
//
// Everything degrades to a no-op: no vectors yet, no analysis backend, a lean
// backend without the text tower (no torch), or a mid-pass failure → log and
// skip. The station never depends on this pass having run.

import crypto from 'node:crypto';
import * as db from './library-db.js';
import * as analyzer from './analyzer.js';
import { moodVocab, moodPromptFor } from '../settings.js';
import { makeEventLogger } from './tagger-progress.js';

const logEvent = makeEventLogger('audio-moods');

// Prompt for one mood — its operator-edited CLAP sound-description
// (settings.moods[].clapPrompt), or the bare word for a mood with no prompt.
// The descriptions are DESCRIPTIVE of sound on purpose — CLAP was trained on
// audio captions, so "how it sounds" phrasing scores far better than the bare
// word. Changing a prompt changes moodVocabHash(), which re-scores the whole
// library on the next pass.
export function moodPrompt(mood: string): string {
  return moodPromptFor(mood);
}

// Hash of the vocabulary + prompts the stored audio_moods were scored with.
// Stored in audio_embedding_meta.mood_vocab_hash; a mismatch re-scores every
// vector-carrying track (mirrors the tagger's promptVocabHash pattern).
export function moodVocabHash(vocab: readonly string[] = moodVocab()): string {
  const h = crypto.createHash('sha256');
  for (const m of vocab) h.update(`${m}=${moodPrompt(m)}|`);
  return h.digest('hex').slice(0, 16);
}

// Pick the top audio moods from a {mood: cosine} score map. Absolute CLAP
// text–audio cosines are small and library-dependent, so selection is
// RELATIVE: the best-scoring mood plus any within `margin` of it, capped at
// `max`. Pure — unit-pinned by scripts/audio-moods.test.ts.
export function topAudioMoods(
  scores: Record<string, number>,
  { max = 3, margin = 0.05 }: { max?: number; margin?: number } = {},
): string[] {
  const entries = Object.entries(scores).filter(([, v]) => Number.isFinite(v));
  if (entries.length === 0) return [];
  entries.sort((a, b) => b[1] - a[1]);
  const best = entries[0][1];
  return entries
    .filter(([, v]) => v >= best - margin)
    .slice(0, Math.max(1, max))
    .map(([m]) => m);
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
}

// Score audio moods for every track that needs it. Incremental by default
// (vector present, audio_moods NULL); a vocabulary/prompt change re-scores the
// whole vector-carrying set. Called after the analysis pass from both bulk
// entry points — cheap when there's nothing to do.
export async function runAudioMoodPass(): Promise<AudioMoodStats> {
  if (db.audioVectorCount() === 0) {
    return { scored: 0, scope: 0, skipped: 'no audio vectors' };
  }

  const hash = moodVocabHash();
  const vocabChanged = db.getAudioMoodVocabHash() !== hash;
  const ids = vocabChanged ? db.audioVectorIds() : db.idsNeedingAudioMoods();
  if (ids.length === 0) {
    return { scored: 0, scope: 0, skipped: null };
  }

  // One round-trip for the whole vocabulary. Generous timeout: the first call
  // after a cold boot may lazy-load (or download) the CLAP text tower. Snapshot
  // the live vocab once so prompts and the scoring loop stay index-aligned.
  const vocab = moodVocab();
  const prompts = vocab.map(moodPrompt);
  const vecs = await analyzer.embedTexts(prompts, { timeoutMs: 10 * 60_000 });
  if (!vecs || vecs.length !== vocab.length) {
    // A backend that ADVERTISES the text tower but failed the call is a runtime
    // fault (worker error, oversized-response 500 — #996), not a lean build;
    // "enable ANALYZER_HEAVY" would send the operator in the wrong direction.
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

  let scored = 0;
  let batch: Array<{ id: string; moods: string[]; scores: Record<string, number> }> = [];
  for (const id of ids) {
    const v = db.getAudioVector(id);
    if (!v) continue;
    const scores: Record<string, number> = {};
    for (let i = 0; i < vocab.length; i++) {
      // Both sides are L2-normalised, so the dot IS the cosine. 3 decimals is
      // plenty of precision and keeps the stored JSON small.
      scores[vocab[i]] = Math.round(dot(v, vecs[i]) * 1000) / 1000;
    }
    batch.push({ id, moods: topAudioMoods(scores), scores });
    scored += 1;
    if (batch.length >= 500) {
      db.setTrackAudioMoodsBulk(batch);
      batch = [];
      console.log(`[audio-moods] ${scored}/${ids.length}`);
    }
  }
  db.setTrackAudioMoodsBulk(batch);
  db.setAudioMoodVocabHash(hash);
  logEvent('success', `Audio moods scored — ${scored.toLocaleString('en-GB')} tracks`);
  return { scored, scope: ids.length, skipped: null };
}
