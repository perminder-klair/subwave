// CLAP cosines are not comparable across moods, so labels are picked on a
// per-mood z axis (#1362). Pure.

// Bump when the derivation makes stored labels stale; rides the mood-state hash
// beside the vocabulary hash, so a change relabels instead of re-scoring.
export const CALIBRATION_VERSION = 2;

export interface MoodBaseline {
  mean: number;
  sd: number;
  n: number;
}

export type MoodBaselines = Record<string, MoodBaseline>;

// Below this many scored tracks the distribution is noise; callers fall back
// to raw selection.
export const MIN_BASELINE_TRACKS = 200;

// Guards the z divide; a near-degenerate mood would otherwise win every track.
const MIN_SD = 1e-3;

// Per-mood mean/sd over a stream of stored score maps; running sums only, since
// the caller streams the whole library off SQLite.
export function computeBaselines(rows: Iterable<Record<string, number>>): MoodBaselines {
  const sum: Record<string, number> = Object.create(null);
  const sumSq: Record<string, number> = Object.create(null);
  const count: Record<string, number> = Object.create(null);

  for (const scores of rows) {
    if (!scores || typeof scores !== 'object') continue;
    for (const [mood, raw] of Object.entries(scores)) {
      if (!Number.isFinite(raw)) continue;
      sum[mood] = (sum[mood] ?? 0) + raw;
      sumSq[mood] = (sumSq[mood] ?? 0) + raw * raw;
      count[mood] = (count[mood] ?? 0) + 1;
    }
  }

  const out: MoodBaselines = {};
  for (const mood of Object.keys(count)) {
    const n = count[mood];
    const mean = sum[mood] / n;
    // Population variance, clamped at 0 (float error can go a hair below).
    const variance = Math.max(0, sumSq[mood] / n - mean * mean);
    out[mood] = { mean, sd: Math.sqrt(variance), n };
  }
  return out;
}

// Drop moods under the floor; null when nothing survives. The floor is per
// mood, never over the maximum n: a thin mood in the baselines wins every track.
export function prunedBaselines(baselines: MoodBaselines | null): MoodBaselines | null {
  if (!baselines) return null;
  const out: MoodBaselines = {};
  for (const [mood, b] of Object.entries(baselines)) {
    if (b.n >= MIN_BASELINE_TRACKS) out[mood] = b;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function baselinesUsable(baselines: MoodBaselines | null): boolean {
  return prunedBaselines(baselines) !== null;
}

// Per-mood z-scores. A mood with no baseline is dropped, never passed through
// raw: mixing units in one ranking ranks nothing.
export function centeredScores(
  scores: Record<string, number>,
  baselines: MoodBaselines,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [mood, raw] of Object.entries(scores)) {
    if (!Number.isFinite(raw)) continue;
    const b = baselines[mood];
    if (!b) continue;
    out[mood] = (raw - b.mean) / Math.max(b.sd, MIN_SD);
  }
  return out;
}

// Margin in standard deviations, the unit centered scores live in.
export const DEFAULT_MARGIN_SD = 0.5;

// Raw-cosine margin, for the uncentered fallback.
export const DEFAULT_MARGIN_RAW = 0.05;

export interface SelectOpts {
  max?: number;
  margin?: number;
}

// Top moods from a raw {mood: cosine} map, centered when baselines are usable.
// Null/thin baselines fall back to raw selection on the raw margin.
export function selectAudioMoods(
  scores: Record<string, number>,
  baselines: MoodBaselines | null,
  { max = 3, margin }: SelectOpts = {},
): string[] {
  const centered = baselinesUsable(baselines) ? centeredScores(scores, baselines!) : null;
  const axis = centered ?? scores;
  const effectiveMargin = margin ?? (centered ? DEFAULT_MARGIN_SD : DEFAULT_MARGIN_RAW);

  const entries = Object.entries(axis).filter(([, v]) => Number.isFinite(v));
  if (entries.length === 0) return [];
  entries.sort((a, b) => b[1] - a[1]);
  const best = entries[0][1];
  return entries
    .filter(([, v]) => v >= best - effectiveMargin)
    .slice(0, Math.max(1, max))
    .map(([m]) => m);
}

// Two ends of an arousal axis, named from the shipped vocabulary
// (settings/vocab.ts). Moods are operator-editable, so only names actually
// present are used.
export const HIGH_ENERGY_MOODS = [
  'energetic', 'workout', 'driving', 'celebratory', 'festival',
] as const;
export const LOW_ENERGY_MOODS = [
  'calm', 'reflective', 'spiritual', 'focus', 'night',
] as const;

const MIN_SIDE_MOODS = 2;

// How far the arousal diff must clear zero (in sd) to overrule a propagated
// energy guess. Symmetric by design.
export const ENERGY_HIGH_Z = 0.35;
export const ENERGY_LOW_Z = -0.35;

// Mean centered high-energy score minus low-energy; null when either side is
// too thin. Exported for diagnostics; callers use audioEnergy.
export function arousalDiff(
  scores: Record<string, number>,
  baselines: MoodBaselines | null,
): number | null {
  if (!baselinesUsable(baselines)) return null;
  const z = centeredScores(scores, baselines!);
  const side = (names: readonly string[]): number | null => {
    const vals = names.map((n) => z[n]).filter((v): v is number => Number.isFinite(v));
    if (vals.length < MIN_SIDE_MOODS) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };
  const hi = side(HIGH_ENERGY_MOODS);
  const lo = side(LOW_ENERGY_MOODS);
  if (hi == null || lo == null) return null;
  return hi - lo;
}

// Audio-derived energy, or null for "the audio does not say". Two-sided by
// design: the ambiguous middle must leave the caller's existing guess alone.
export function audioEnergy(
  scores: Record<string, number>,
  baselines: MoodBaselines | null,
): 'low' | 'high' | null {
  const diff = arousalDiff(scores, baselines);
  if (diff == null) return null;
  if (diff >= ENERGY_HIGH_Z) return 'high';
  if (diff <= ENERGY_LOW_Z) return 'low';
  return null;
}

// audio_embedding_meta.mood_vocab_hash is `<vocabHash>:<calibrationVersion>`.
// The halves invalidate different work: vocabulary → full CLAP re-score,
// calibration → relabel from the cosines on disk.
export function composeMoodStateHash(vocabHash: string, version = CALIBRATION_VERSION): string {
  return `${vocabHash}:${version}`;
}

// Stamped by a pass that could not calibrate. 0 is what a legacy bare hash
// parses as, and means the same thing: re-derivation is still owed.
export const UNCALIBRATED_VERSION = 0;

// The one place the stamp decision lives; a pass calling composeMoodStateHash
// directly would stamp the uncalibrated case as done.
export function moodStateHashFor(vocabHash: string, calibrated: boolean): string {
  return composeMoodStateHash(
    vocabHash,
    calibrated ? CALIBRATION_VERSION : UNCALIBRATED_VERSION,
  );
}

export interface MoodState {
  vocabHash: string;
  version: number;
}

// A legacy value (bare vocabulary hash, no ':') reads as version 0.
export function parseMoodStateHash(stored: string | null): MoodState | null {
  if (!stored) return null;
  const idx = stored.lastIndexOf(':');
  if (idx === -1) return { vocabHash: stored, version: 0 };
  const version = Number(stored.slice(idx + 1));
  if (!Number.isInteger(version) || version < 0) return { vocabHash: stored, version: 0 };
  return { vocabHash: stored.slice(0, idx), version };
}

export type MoodPassAction = 'none' | 'relabel' | 'rescore';

// What a pass must do given what is on disk: no state or a changed vocabulary
// → rescore; only the version changed → relabel; otherwise none.
export function moodPassAction(stored: string | null, wantVocabHash: string): MoodPassAction {
  const prev = parseMoodStateHash(stored);
  if (!prev) return 'rescore';
  if (prev.vocabHash !== wantVocabHash) return 'rescore';
  if (prev.version !== CALIBRATION_VERSION) return 'relabel';
  return 'none';
}
