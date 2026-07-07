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
import { SHOW_MOODS } from '../settings.js';
import { makeEventLogger } from './tagger-progress.js';

const logEvent = makeEventLogger('audio-moods');

// One CLAP text prompt per mood. Deliberately DESCRIPTIVE of sound — CLAP was
// trained on audio captions, so "how it sounds" phrasing scores far better than
// the bare vocabulary word (several moods — cooking, focus, morning — are
// listening contexts, not acoustic qualities). Changing a prompt changes
// moodVocabHash(), which re-scores the whole library on the next pass.
const MOOD_PROMPTS: Record<string, string> = {
  energetic: 'high-energy, upbeat, powerful music with a strong driving beat',
  calm: 'calm, peaceful, soft, soothing, gentle music',
  reflective: 'reflective, introspective, melancholic, emotional music',
  celebratory: 'joyful, festive, celebratory party music',
  romantic: 'romantic, intimate, tender, loving music',
  spiritual: 'spiritual, devotional, sacred, meditative music',
  focus: 'minimal, unobtrusive, ambient instrumental background music for concentration',
  workout: 'intense, pounding, adrenaline-pumping workout music',
  driving: 'steady, groovy, mid-tempo cruising music for a road trip',
  cooking: 'light, cheerful, breezy, feel-good easy-listening music',
  rainy: 'mellow, wistful, cozy music for a rainy day',
  sunny: 'bright, warm, sunny, feel-good summer music',
  night: 'dark, atmospheric, moody late-night music',
  morning: 'fresh, gentle, optimistic early-morning music',
  evening: 'smooth, warm, relaxed evening music',
  festival: 'big, anthemic, euphoric festival crowd music',
  cultural: 'traditional folk music with regional acoustic instruments',
};

// Prompt for one mood — unknown vocabulary entries (a future SHOW_MOODS
// addition without a prompt here) fall back to the bare word, which still
// works, just less sharply.
export function moodPrompt(mood: string): string {
  return MOOD_PROMPTS[mood] ?? `${mood} music`;
}

// Hash of the vocabulary + prompts the stored audio_moods were scored with.
// Stored in audio_embedding_meta.mood_vocab_hash; a mismatch re-scores every
// vector-carrying track (mirrors the tagger's promptVocabHash pattern).
export function moodVocabHash(vocab: readonly string[] = SHOW_MOODS): string {
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
  // after a cold boot may lazy-load (or download) the CLAP text tower.
  const prompts = SHOW_MOODS.map(moodPrompt);
  const vecs = await analyzer.embedTexts(prompts, { timeoutMs: 10 * 60_000 });
  if (!vecs || vecs.length !== SHOW_MOODS.length) {
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
    for (let i = 0; i < SHOW_MOODS.length; i++) {
      // Both sides are L2-normalised, so the dot IS the cosine. 3 decimals is
      // plenty of precision and keeps the stored JSON small.
      scores[SHOW_MOODS[i]] = Math.round(dot(v, vecs[i]) * 1000) / 1000;
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
