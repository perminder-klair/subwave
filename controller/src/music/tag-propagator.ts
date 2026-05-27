// KNN voting logic for propagating moods/energy from a small LLM-tagged seed
// set to the rest of the library.
//
// Pure functions only — the data plumbing (fetch neighbours from library-db,
// look up their tags) is the caller's job. This file does the math.

import type { KnnHit } from './library-db.js';

export type EnergyValue = 'low' | 'medium' | 'high' | null;

export interface NeighbourTags {
  moods: string[];
  energy: EnergyValue;
}

export interface VoteResult {
  moods: string[];                        // moods present in ≥ threshold of voting neighbours
  energy: EnergyValue;                    // plurality vote, tie-break by top similarity
  confidence: number;                     // 0..1; combines neighbour proximity + tag coverage
  votingNeighbours: number;               // how many of the K neighbours actually had tags
}

export interface VoteOpts {
  moodVoteThreshold: number;              // fraction of voting neighbours that must carry a mood
  k: number;                              // how many neighbours were requested (so confidence can
                                          // discount for missing tags)
}

// Vote on moods + energy from a KNN result. Caller supplies a lookup function
// so we don't have to import library-db here (keeps this file unit-testable).
//
// Confidence formula:
//   coverage    = votingNeighbours / k          (penalises sparse coverage early in propagation)
//   topSim      = max(0, neighbours[0].similarity)   (penalises far-away matches)
//   confidence  = topSim * coverage
//
// Calibration is open in the spec (see §11). 0.6 is a reasonable starting
// threshold — the implementation PR should tune this on the operator's data.
export function vote(
  neighbours: KnnHit[],
  getTags: (id: string) => NeighbourTags | null,
  opts: VoteOpts,
): VoteResult {
  const voting: Array<KnnHit & NeighbourTags> = [];
  for (const n of neighbours) {
    const tags = getTags(n.id);
    if (!tags) continue;
    if (tags.moods.length === 0 && tags.energy === null) continue;
    voting.push({ ...n, ...tags });
  }

  if (voting.length === 0) {
    return { moods: [], energy: null, confidence: 0, votingNeighbours: 0 };
  }

  // Mood vote: count occurrences across voting neighbours.
  const moodCounts = new Map<string, number>();
  for (const v of voting) {
    for (const m of v.moods) {
      moodCounts.set(m, (moodCounts.get(m) ?? 0) + 1);
    }
  }
  const moodThreshold = Math.max(1, Math.ceil(opts.moodVoteThreshold * voting.length));
  const moods = [...moodCounts.entries()]
    .filter(([, n]) => n >= moodThreshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3) // mood vocab arrays cap at 3
    .map(([m]) => m);

  // Energy vote: plurality across voting neighbours, tie-break by similarity.
  const energyCounts = new Map<string, number>();
  for (const v of voting) {
    if (v.energy) energyCounts.set(v.energy, (energyCounts.get(v.energy) ?? 0) + 1);
  }
  let energy: EnergyValue = null;
  let bestCount = 0;
  for (const [e, c] of energyCounts.entries()) {
    if (c > bestCount) {
      bestCount = c;
      energy = e as EnergyValue;
    } else if (c === bestCount) {
      // Tie — take the energy of the closest neighbour that has any energy.
      const closer = voting.find(v => v.energy && (v.energy === e || v.energy === energy));
      if (closer?.energy) energy = closer.energy;
    }
  }

  const topSim = Math.max(0, voting[0].similarity);
  const coverage = voting.length / Math.max(1, opts.k);
  const confidence = Math.min(1, topSim * coverage);

  return { moods, energy, confidence, votingNeighbours: voting.length };
}
