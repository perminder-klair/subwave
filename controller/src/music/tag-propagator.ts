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
  moods: string[];                        // moods holding ≥ threshold of the voting weight
  energy: EnergyValue;                    // weighted plurality, tie-break by proximity
  confidence: number;                     // 0..1; combines neighbour proximity + tag coverage
  votingNeighbours: number;               // how many of the K neighbours actually had tags
}

export interface VoteOpts {
  moodVoteThreshold: number;              // fraction of the total voting WEIGHT a mood must carry
  k: number;                              // how many neighbours were requested (so confidence can
                                          // discount for missing tags)
  // Optional per-neighbour weight multiplier (clamped to 0..1). The caller's
  // policy hook — tag-library halves same-album neighbours here so an album's
  // tags need outside corroboration instead of echoing around it. Affects the
  // vote weights only, never the confidence formula.
  weightOf?: (id: string) => number;
}

// Vote on moods + energy from a KNN result. Caller supplies a lookup function
// so we don't have to import library-db here (keeps this file unit-testable).
//
// Votes are SIMILARITY-WEIGHTED: each voting neighbour contributes
// max(0, similarity) rather than a flat 1. Under flat counting a 0.9-similar
// neighbour was outvoted by two 0.3-similar ones — exactly backwards at the
// propagation frontier, where the far tail of the K list is barely related to
// the track being tagged. A mood now passes when it carries
// ≥ moodVoteThreshold of the total voting weight; energy is the weighted
// plurality with ties broken by the closest neighbour carrying one.
//
// Confidence formula (deliberately unchanged by the weighting — the operator's
// confidenceThreshold default was tuned against it):
//   coverage    = votingNeighbours / k          (penalises sparse coverage early in propagation)
//   topSim      = max(0, neighbours[0].similarity)   (penalises far-away matches)
//   confidence  = topSim * coverage
//
// Because confidence is a PRODUCT of two sub-1 terms, the gate compounds fast: a
// strong nearest match (topSim 0.75) with 3-of-5 tagged neighbours (coverage 0.6)
// only scores 0.45. The old 0.6 default therefore rejected most genuinely-similar
// tracks and dumped them into (expensive) active-learning; the default is now 0.35
// (settings.ts DEFAULTS.embedding.confidenceThreshold), which still needs a real
// neighbour but lets KNN propagation carry the bulk of tagging. Operator-tunable.
export function vote(
  neighbours: KnnHit[],
  getTags: (id: string) => NeighbourTags | null,
  opts: VoteOpts,
): VoteResult {
  const voting: Array<KnnHit & NeighbourTags & { weight: number }> = [];
  for (const n of neighbours) {
    const tags = getTags(n.id);
    if (!tags) continue;
    if (tags.moods.length === 0 && tags.energy === null) continue;
    const scale = opts.weightOf ? Math.min(1, Math.max(0, opts.weightOf(n.id))) : 1;
    voting.push({ ...n, ...tags, weight: Math.max(0, n.similarity) * scale });
  }

  const totalWeight = voting.reduce((s, v) => s + v.weight, 0);
  if (voting.length === 0 || totalWeight <= 0) {
    // No tagged neighbours, or every one is orthogonal-or-worse to the track —
    // there's no real evidence to propagate from either way.
    return { moods: [], energy: null, confidence: 0, votingNeighbours: 0 };
  }

  // Mood vote: sum each mood's neighbour weight; it passes when it carries
  // enough of the total voting weight.
  const moodWeights = new Map<string, number>();
  for (const v of voting) {
    for (const m of v.moods) {
      moodWeights.set(m, (moodWeights.get(m) ?? 0) + v.weight);
    }
  }
  const moodThreshold = opts.moodVoteThreshold * totalWeight;
  const moods = [...moodWeights.entries()]
    .filter(([, w]) => w > 0 && w >= moodThreshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3) // mood vocab arrays cap at 3
    .map(([m]) => m);

  // Energy vote: weighted plurality. `voting` is in KNN order (closest first),
  // so on an exact tie the energy that appeared on a closer neighbour wins —
  // strictly-greater comparison keeps the earlier (closer) winner.
  const energyWeights = new Map<string, number>();
  for (const v of voting) {
    if (v.energy) energyWeights.set(v.energy, (energyWeights.get(v.energy) ?? 0) + v.weight);
  }
  let energy: EnergyValue = null;
  let bestWeight = 0;
  for (const v of voting) {
    if (!v.energy) continue;
    const w = energyWeights.get(v.energy) ?? 0;
    if (w > bestWeight) {
      bestWeight = w;
      energy = v.energy;
    }
  }

  const topSim = Math.max(0, voting[0].similarity);
  const coverage = voting.length / Math.max(1, opts.k);
  const confidence = Math.min(1, topSim * coverage);

  return { moods, energy, confidence, votingNeighbours: voting.length };
}
