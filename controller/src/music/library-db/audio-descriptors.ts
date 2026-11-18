// CLAP sound descriptors (music/audio-descriptors.ts): instruments, vocal type
// and production style, scored from the stored audio vectors. Same two-phase
// storage as audio moods.

import {
  idsMissingLabels,
  iterateScoreMaps,
  pageScoreMaps,
  readScoreMap,
  readStateHash,
  writeLabels,
  writeScoreMaps,
  writeStateHash,
  type ScoreMapRow,
} from './audio-scores.js';

const SCORES = 'audio_descriptor_scores_json';
const LABELS = 'audio_descriptors';
const STATE = 'descriptor_vocab_hash';

// Phase one of a calibrated pass; a crash before the labels leaves
// audio_descriptors NULL, which idsNeedingAudioDescriptors re-picks up.
export function setTrackAudioDescriptorScoresBulk(rows: ScoreMapRow[]): void {
  writeScoreMaps(SCORES, rows);
}

export function setTrackAudioDescriptorLabelsBulk(
  rows: Array<{ id: string; labels: string[] }>,
): void {
  writeLabels(LABELS, rows);
}

export function idsNeedingAudioDescriptors(): string[] {
  return idsMissingLabels(LABELS);
}

// Dossier only.
export function getAudioDescriptorScores(id: string): Record<string, number> | null {
  return readScoreMap(SCORES, id);
}

export function iterateAudioDescriptorScores(): Generator<ScoreMapRow> {
  return iterateScoreMaps(SCORES);
}

export function pageAudioDescriptorScores(
  afterId: string,
  limit: number,
): { items: ScoreMapRow[]; lastId: string | null } {
  return pageScoreMaps(SCORES, afterId, limit);
}

export function getAudioDescriptorVocabHash(): string | null {
  return readStateHash(STATE);
}

export function setAudioDescriptorVocabHash(hash: string): void {
  writeStateHash(STATE, hash);
}
