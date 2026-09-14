// Correct PROPAGATED energy values from the audio the analyzer heard (#1362).
// A propagated energy is inherited from embedding neighbours, so this overrules
// it where the audio is DECISIVE (audioEnergy returns null for the ambiguous
// middle). Moods are not corrected the same way: a mood is editorial.

import * as db from './library-db.js';
import { audioEnergy, computeBaselines, prunedBaselines } from './audio-calibration.js';
import { makeEventLogger } from './tagger-progress.js';

const logEvent = makeEventLogger('audio-energy');

export interface PropagatedEnergyStats {
  scope: number;      // propagated tracks carrying audio scores
  corrected: number;  // rows whose energy the audio actually changed
  agreed: number;     // rows where the audio confirmed the propagated value
  undecided: number;  // rows where the audio had no decisive answer
  skipped: string | null;
}

// Writes `energy` ONLY: source and moods stay as propagation left them, so the row
// keeps reporting inherited moods. 'llm'/'manual'/'uncertain-llm' are never touched.
export function runPropagatedEnergyPass(): PropagatedEnergyStats {
  const empty = { scope: 0, corrected: 0, agreed: 0, undecided: 0 };

  const rows = db.propagatedTracksWithAudioScores();
  if (rows.length === 0) {
    return { ...empty, skipped: 'no propagated tracks with audio scores' };
  }

  // Baselines come from the WHOLE library, never the propagated subset (that
  // would be a biased yardstick). Pruned per mood: too few scores gives a
  // near-degenerate sd that swings the axis on noise.
  const baselines = prunedBaselines(
    computeBaselines(
      (function* () {
        for (const row of db.iterateAudioMoodScores()) yield row.scores;
      })(),
    ),
  );
  if (!baselines) {
    return { ...empty, scope: rows.length, skipped: 'library too small to calibrate against' };
  }

  const updates: Array<{ id: string; energy: string }> = [];
  let agreed = 0;
  let undecided = 0;
  for (const row of rows) {
    const derived = audioEnergy(row.scores, baselines);
    if (derived == null) {
      undecided += 1;
      continue;
    }
    if (derived === row.energy) {
      agreed += 1;
      continue;
    }
    updates.push({ id: row.id, energy: derived });
  }

  db.setTrackEnergyBulk(updates);

  logEvent(
    'success',
    `Audio-derived energy over ${rows.length.toLocaleString('en-GB')} propagated tracks — ` +
      `${updates.length.toLocaleString('en-GB')} corrected, ${agreed.toLocaleString('en-GB')} confirmed, ` +
      `${undecided.toLocaleString('en-GB')} left as-is (audio not decisive)`,
  );

  return {
    scope: rows.length,
    corrected: updates.length,
    agreed,
    undecided,
    skipped: null,
  };
}
