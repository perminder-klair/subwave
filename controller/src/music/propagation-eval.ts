// Held-out self-check for KNN propagation: score the real vote against directly
// decided tracks. A RELATIVE signal, not a benchmark — neighbours may carry tags
// propagated from the held-out track, so compare runs, not against 100%.
// Pure scoring; the sampling + KNN + vote plumbing stays in tag-library.ts.

import type { NeighbourTags } from './tag-propagator.js';
import type { VoteResult } from './tag-propagator.js';

export interface EvalCase {
  actual: NeighbourTags;   // the stored (trusted) tags
  result: VoteResult;      // what vote() predicted for this track
}

export interface EvalSummary {
  sampled: number;
  // Cases that clear the production propagation gate (confidence + ≥1 mood) —
  // i.e. would have been auto-tagged had the track been untagged.
  gatePassed: number;
  // Mean Jaccard overlap of predicted vs actual mood sets, over gate-passed
  // cases (0..1; 1 = identical sets). Null when nothing passed the gate.
  moodJaccard: number | null;
  // Energy agreement over gate-passed cases where BOTH sides have an energy.
  energyMatched: number;
  energyComparable: number;
}

// |A ∩ B| / |A ∪ B| over mood sets. Both-empty counts as perfect agreement.
export function moodJaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const m of sa) if (sb.has(m)) inter++;
  return inter / (sa.size + sb.size - inter);
}

export function summariseEval(cases: EvalCase[], confidenceThreshold: number): EvalSummary {
  let gatePassed = 0;
  let jaccardSum = 0;
  let energyMatched = 0;
  let energyComparable = 0;
  for (const c of cases) {
    // Mirror the production gate in tag-library's propagation loop exactly.
    const passes =
      c.result.votingNeighbours >= 1 &&
      c.result.confidence >= confidenceThreshold &&
      c.result.moods.length > 0;
    if (!passes) continue;
    gatePassed++;
    jaccardSum += moodJaccard(c.result.moods, c.actual.moods);
    if (c.result.energy && c.actual.energy) {
      energyComparable++;
      if (c.result.energy === c.actual.energy) energyMatched++;
    }
  }
  return {
    sampled: cases.length,
    gatePassed,
    moodJaccard: gatePassed > 0 ? jaccardSum / gatePassed : null,
    energyMatched,
    energyComparable,
  };
}

// One human-readable line for the run log / progress panel.
export function formatEvalSummary(s: EvalSummary): string {
  if (s.sampled === 0) return 'propagation self-check skipped (not enough trusted tags)';
  const pct = (n: number, d: number) => `${Math.round((n / Math.max(1, d)) * 100)}%`;
  const parts = [
    `${pct(s.gatePassed, s.sampled)} of ${s.sampled} held-out tracks would auto-tag`,
  ];
  if (s.moodJaccard != null) parts.push(`mood agreement ${Math.round(s.moodJaccard * 100)}%`);
  if (s.energyComparable > 0) parts.push(`energy match ${pct(s.energyMatched, s.energyComparable)}`);
  return `Propagation self-check — ${parts.join(', ')}`;
}
