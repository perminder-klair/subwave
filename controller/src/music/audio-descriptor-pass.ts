// Score the sound descriptors against the stored audio vectors, through the same
// zero-shot pass as the audio moods. Same posture: no decode, and a missing
// backend or failed request logs and skips.

import * as db from './library-db.js';
import { makeEventLogger } from './tagger-progress.js';
import {
  audioDescriptorVocabHash,
  DESCRIPTOR_CALIBRATION_VERSION,
  DESCRIPTOR_VOCAB,
  selectAudioDescriptors,
} from './audio-descriptors.js';
import { runZeroShotPass, type ZeroShotSpec, type ZeroShotStats } from './audio-zero-shot.js';

const DESCRIPTOR_PASS: ZeroShotSpec = {
  tag: 'audio-descriptors',
  logEvent: makeEventLogger('audio-descriptors'),
  version: DESCRIPTOR_CALIBRATION_VERSION,
  vocabHash: () => audioDescriptorVocabHash(),
  vocab: () => ({
    labels: DESCRIPTOR_VOCAB.map((d) => d.label),
    prompts: DESCRIPTOR_VOCAB.map((d) => d.prompt),
  }),
  readState: db.getAudioDescriptorVocabHash,
  writeState: db.setAudioDescriptorVocabHash,
  idsNeedingScores: db.idsNeedingAudioDescriptors,
  writeScores: db.setTrackAudioDescriptorScoresBulk,
  iterateScores: db.iterateAudioDescriptorScores,
  pageScores: db.pageAudioDescriptorScores,
  writeLabels: db.setTrackAudioDescriptorLabelsBulk,
  select: selectAudioDescriptors,
  needsBaselines: true,
  say: {
    relabelled: (count, calibrated) =>
      `Re-derived sound descriptors for ${count.toLocaleString('en-GB')} tracks` +
      (calibrated ? '' : ' (none selected — library too small to calibrate)'),
    towerFailed:
      'Text embedding failed even though the backend reports a CLAP text tower — check the analyzer container logs; skipping sound descriptors',
    noTower:
      'Backend has no CLAP text tower — skipping sound descriptors (ANALYZER_HEAVY=1 enables it)',
    scoring: (count, vocabChanged) =>
      `Scoring sound descriptors for ${count.toLocaleString('en-GB')} tracks` +
      (vocabChanged ? ' (vocabulary changed — full re-score)' : '') + '…',
    scored: (count, calibrated) =>
      `Sound descriptors scored — ${count.toLocaleString('en-GB')} tracks` +
      (calibrated ? '' : ' (none selected — library too small to calibrate)'),
  },
};

export function runAudioDescriptorPass(): Promise<ZeroShotStats> {
  return runZeroShotPass(DESCRIPTOR_PASS);
}
