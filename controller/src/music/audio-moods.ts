// Score stored audio vectors against CLAP mood text vectors and blend scores with metadata
// tags at retrieval. Missing vectors, backend capability, or failed requests log and skip.

import crypto from 'node:crypto';
import * as db from './library-db.js';
import { moodVocab, moodPromptFor } from '../settings.js';
import { makeEventLogger } from './tagger-progress.js';
import { CALIBRATION_VERSION, selectAudioMoods, type MoodBaselines } from './audio-calibration.js';
import {
  relabelAllFromStoredScores,
  runZeroShotPass,
  type ZeroShotSpec,
  type ZeroShotStats,
} from './audio-zero-shot.js';

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

export type AudioMoodStats = ZeroShotStats;

const MOOD_PASS: ZeroShotSpec = {
  tag: 'audio-moods',
  logEvent,
  version: CALIBRATION_VERSION,
  vocabHash: () => moodVocabHash(),
  vocab: () => {
    const labels = moodVocab();
    return { labels, prompts: labels.map(moodPrompt) };
  },
  readState: db.getAudioMoodVocabHash,
  writeState: db.setAudioMoodVocabHash,
  idsNeedingScores: db.idsNeedingAudioMoods,
  writeScores: db.setTrackAudioMoodScoresBulk,
  iterateScores: db.iterateAudioMoodScores,
  pageScores: db.pageAudioMoodScores,
  writeLabels: (rows) =>
    db.setTrackAudioMoodLabelsBulk(rows.map(({ id, labels }) => ({ id, moods: labels }))),
  select: (scores, baselines) => selectAudioMoods(scores, baselines),
  say: {
    relabelled: (count, calibrated) =>
      `Re-derived audio mood labels for ${count.toLocaleString('en-GB')} tracks ` +
      `(per-mood calibration${calibrated ? '' : ' unavailable — library too small, raw selection'})`,
    towerFailed:
      'Text embedding failed even though the backend reports a CLAP text tower — check the analyzer container logs; skipping audio moods',
    noTower: 'Backend has no CLAP text tower — skipping audio moods (ANALYZER_HEAVY=1 enables it)',
    scoring: (count, vocabChanged) =>
      `Scoring audio moods for ${count.toLocaleString('en-GB')} tracks` +
      (vocabChanged ? ' (vocabulary changed — full re-score)' : '') + '…',
    scored: (count, calibrated) =>
      `Audio moods scored — ${count.toLocaleString('en-GB')} tracks` +
      (calibrated ? ' (per-mood calibration applied)' : ' (uncalibrated — library too small)'),
  },
};

// Re-derive mood labels from the cosines already on disk.
export function relabelFromStoredScores(baselines: MoodBaselines | null): number {
  return relabelAllFromStoredScores(MOOD_PASS, baselines);
}

export function runAudioMoodPass(): Promise<AudioMoodStats> {
  return runZeroShotPass(MOOD_PASS);
}
