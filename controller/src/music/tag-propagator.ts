// KNN voting that propagates moods/energy from the LLM-tagged seed set to the
// rest of the library. Pure math; the caller does the data plumbing.

import type { KnnHit } from './library-db.js';

export type EnergyValue = 'low' | 'medium' | 'high' | null;

export interface NeighbourTags {
  moods: string[];
  energy: EnergyValue;
}

export interface VoteResult {
  moods: string[];                        // moods holding >= threshold of the voting weight
  energy: EnergyValue;                    // weighted plurality, tie-break by proximity
  confidence: number;                     // 0..1; neighbour proximity x tag coverage
  votingNeighbours: number;               // how many of the K neighbours actually had tags
}

export interface VoteOpts {
  moodVoteThreshold: number;              // fraction of the total voting WEIGHT a mood must carry
  k: number;                              // neighbours requested, so confidence can discount misses
  // Per-neighbour weight multiplier (clamped 0..1), the caller's policy hook:
  // tag-library halves same-album neighbours so an album needs outside
  // corroboration. Affects vote weights only, never confidence.
  weightOf?: (id: string) => number;
}

// Fuse text-space and CLAP audio-space KNN lists into one ranking. Audio cosines
// are scaled by `blend` (settings.embedding.audioFusionWeight, 0..1); a track in
// both spaces keeps the HIGHER score, not the sum, so the result stays
// cosine-shaped 0..1 for vote()'s topSim. Re-capped at k so audio neighbours
// displace the text tail rather than widening the vote; blend 0 or no audio hits
// is exactly the text list.
export function fuseNeighbours(
  text: KnnHit[],
  audio: KnnHit[],
  blend: number,
  k: number,
): KnnHit[] {
  const b = Math.min(1, Math.max(0, blend));
  if (b <= 0 || audio.length === 0) return text.slice(0, Math.max(0, k));
  const fused = new Map<string, number>();
  for (const h of text) {
    const s = Math.max(0, h.similarity);
    fused.set(h.id, Math.max(fused.get(h.id) ?? 0, s));
  }
  for (const h of audio) {
    const s = Math.max(0, h.similarity) * b;
    fused.set(h.id, Math.max(fused.get(h.id) ?? 0, s));
  }
  return [...fused.entries()]
    .map(([id, similarity]) => ({ id, similarity }))
    .sort((x, y) => y.similarity - x.similarity)
    .slice(0, Math.max(0, k));
}

// Vote on moods + energy from a KNN result. Tags come in through `getTags` so
// this file never imports library-db.
//
// Votes are SIMILARITY-WEIGHTED (max(0, similarity), not a flat 1): a mood passes
// when it carries >= moodVoteThreshold of the total weight, energy is the weighted
// plurality with ties going to the closest neighbour.
//
// confidence = topSim * coverage, where coverage = votingNeighbours / k. It is a
// product of two sub-1 terms so it compounds fast (0.75 topSim at 3-of-5 coverage
// scores 0.45); the operator default (DEFAULTS.embedding.confidenceThreshold, 0.35)
// is tuned against this exact formula, so weighting changes must leave it alone.
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
    // No tagged neighbours, or all orthogonal-or-worse: nothing to propagate.
    return { moods: [], energy: null, confidence: 0, votingNeighbours: 0 };
  }

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

  // Weighted plurality. `voting` is in KNN order, so the strictly-greater test
  // breaks a tie in favour of the closer neighbour.
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
