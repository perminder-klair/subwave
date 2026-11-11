// Audio-derived energy from the mood cosines the analyzer heard (#1362), over
// one library-wide yardstick, in up to three steps:
// 1. CORRECT a propagated energy (always on): inherited from embedding
//    neighbours, so it is overruled where the audio is DECISIVE (audioEnergy
//    returns null for the ambiguous middle, which leaves the value alone).
// 2. FILL an empty energy (opt-in, `embedding.audioEnergy.fillEmpty`) on any
//    tagged row but an operator's: the tagging model may answer moods with no
//    energy, and an empty energy drops the track from every show with strict
//    filters. With no value to protect, the middle band is 'medium'.
// 3. OVERRULE an LLM energy (opt-in, `embedding.audioEnergy.overruleLlm`) where
//    the audio is STRONGLY decisive (ENERGY_OVERRULE_Z, far past step 1's
//    threshold) and says otherwise.
// An operator's energy ('manual') is never touched by any step, and every
// write is the `energy` column alone. Moods are not corrected the same way: a
// mood is editorial.

import * as db from './library-db.js';
import { audioEnergy, audioEnergyFill, audioEnergyOverrule, computeBaselines, prunedBaselines } from './audio-calibration.js';
import { makeEventLogger } from './tagger-progress.js';

const logEvent = makeEventLogger('audio-energy');

export interface AudioEnergyOptions {
  fillEmpty: boolean;
  overruleLlm: boolean;
}

// The pass's options from settings; absent or malformed reads as off, so an
// upgrade runs exactly the correction it ran before.
export function audioEnergyOptions(s: unknown): AudioEnergyOptions {
  const ae = (s as { embedding?: { audioEnergy?: Partial<AudioEnergyOptions> } } | null | undefined)
    ?.embedding?.audioEnergy;
  return { fillEmpty: ae?.fillEmpty === true, overruleLlm: ae?.overruleLlm === true };
}

type Counts = { high: number; medium: number; low: number };

export interface PropagatedEnergyStats {
  scope: number;      // propagated tracks carrying audio scores
  corrected: number;  // rows whose energy the audio actually changed
  agreed: number;     // rows where the audio confirmed the propagated value
  undecided: number;  // rows where the audio had no decisive answer
  fillScope: number;  // tagged rows with audio scores and no energy (0 when fill is off)
  filled: Counts;     // empty energies given one
  overruleScope: number; // LLM energies with audio scores (0 when overrule is off)
  overruled: number;  // LLM energies the audio replaced
  skipped: string | null;
}

const fmt = (n: number) => n.toLocaleString('en-GB');

export function runPropagatedEnergyPass(
  opts: AudioEnergyOptions = { fillEmpty: false, overruleLlm: false },
): PropagatedEnergyStats {
  const none: Counts = { high: 0, medium: 0, low: 0 };
  const empty = {
    scope: 0, corrected: 0, agreed: 0, undecided: 0,
    fillScope: 0, filled: none, overruleScope: 0, overruled: 0,
  };

  const rows = db.propagatedTracksWithAudioScores();
  const fillAny = opts.fillEmpty && db.emptyEnergyTracksWithAudioScores().length > 0;
  const overruleRows = opts.overruleLlm ? db.llmEnergyTracksWithAudioScores() : [];
  if (rows.length === 0 && !fillAny && overruleRows.length === 0) {
    return { ...empty, skipped: 'no tracks with audio scores for this pass' };
  }

  // Baselines come from the WHOLE library, never a subset (that would be a
  // biased yardstick). Pruned per mood: too few scores gives a near-degenerate
  // sd that swings the axis on noise.
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

  // Step 2 re-reads after step 1: a propagated row with no energy that the
  // audio settled is step 1's.
  const fillRows = opts.fillEmpty ? db.emptyEnergyTracksWithAudioScores() : [];
  const filled = { ...none };
  if (fillRows.length > 0) {
    const fills: Array<{ id: string; energy: keyof Counts }> = [];
    for (const row of fillRows) {
      const energy = audioEnergyFill(row.scores, baselines);
      if (energy) fills.push({ id: row.id, energy });
    }
    if (db.fillEmptyTrackEnergyBulk(fills) > 0) {
      // Counted from what is stored now, so a row a tag answer took first is
      // not reported as filled.
      for (const f of fills) if (db.getTrack(f.id)?.energy === f.energy) filled[f.energy] += 1;
    }
  }

  let overruled = 0;
  if (overruleRows.length > 0) {
    const changes: Array<{ id: string; from: string; energy: string }> = [];
    for (const row of overruleRows) {
      const energy = audioEnergyOverrule(row.scores, baselines, row.energy);
      if (energy) changes.push({ id: row.id, from: row.energy, energy });
    }
    overruled = db.overruleTrackEnergyBulk(changes);
  }

  const parts = [
    `Audio-derived energy over ${fmt(rows.length)} propagated tracks — ` +
      `${fmt(updates.length)} corrected, ${fmt(agreed)} confirmed, ` +
      `${fmt(undecided)} left as-is (audio not decisive)`,
  ];
  if (fillRows.length > 0) {
    parts.push(
      `${fmt(filled.high + filled.medium + filled.low)} of ${fmt(fillRows.length)} empty energies filled from the audio ` +
        `(${fmt(filled.high)} high, ${fmt(filled.medium)} medium, ${fmt(filled.low)} low)`,
    );
  }
  if (overruleRows.length > 0) {
    parts.push(`${fmt(overruled)} of ${fmt(overruleRows.length)} LLM energies overruled by strongly decisive audio`);
  }
  logEvent('success', parts.join('; '));

  return {
    scope: rows.length,
    corrected: updates.length,
    agreed,
    undecided,
    fillScope: fillRows.length,
    filled,
    overruleScope: overruleRows.length,
    overruled,
    skipped: null,
  };
}
