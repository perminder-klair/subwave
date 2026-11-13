// The tail's short-term loudness curve (tail facet v3) and the one rule that
// reads an audible end off it. Pure: no settings, no library; the decision of
// WHETHER to cut there is music/silence-trim.ts's (the one owner of every cue
// point), this module only answers WHERE.
//
// Why a curve: the silence trim cuts at an ABSOLUTE floor (the analyzer's
// SILENCE_DBFS, -50 dBFS), which on a FADE lands seconds after the music
// stopped being audible, so the exit crossfade overlapped a near-silent tail.
// An audible end is a level RELATIVE to the track's own loudness, and only a
// loudness measurement over time can place it.
//
// Stored form (inside outro_json, written by analyze_worker.loudness_curve):
//   { startMs, stepMs, lufs }
//   startMs  absolute file time (ms) of the FIRST point; every point is
//            stamped at the END of the 3 s EBU R128 short-term window it
//            measures, so point i sits at startMs + i * stepMs.
//   stepMs   500 today.
//   lufs     short-term loudness in TENTHS of a LUFS, as ints (-123 = -12.3);
//            digital silence is stored at the worker's floor (-1000).
// Ints in tenths keep a ~20 s tail to ~35 small integers per track, which the
// controller holds parsed for the whole library.

export interface LoudnessCurve {
  startMs: number;
  stepMs: number;
  lufs: number[];
}

// A curve longer than this is not a tail window (20 minutes at 0.5 s).
const MAX_POINTS = 2400;

// A valid curve, or null. A malformed one is dropped WHOLE: point i's time is
// its index, so dropping one bad point would shift every later one.
export function parseLoudnessCurve(v: unknown): LoudnessCurve | null {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const startMs = o.startMs;
  const stepMs = o.stepMs;
  const lufs = o.lufs;
  if (typeof startMs !== 'number' || !Number.isFinite(startMs) || startMs < 0) return null;
  if (typeof stepMs !== 'number' || !Number.isFinite(stepMs) || stepMs <= 0) return null;
  if (!Array.isArray(lufs) || lufs.length > MAX_POINTS) return null;
  for (const x of lufs) {
    if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  }
  return { startMs, stepMs, lufs: lufs as number[] };
}

// Seconds (absolute file time) of the LAST curve point at or above
// `bodyLufs - dropDb`, or null when none qualifies or the body loudness is
// unknown. The last such point, not the first under: a fade that dips and
// swells is still audible at the later point.
export function audibleEndSec(
  curve: LoudnessCurve,
  bodyLufs: number | null | undefined,
  dropDb: number,
): number | null {
  if (typeof bodyLufs !== 'number' || !Number.isFinite(bodyLufs)) return null;
  // An unreadable dial (NaN) makes the threshold NaN, which no point reaches.
  const threshold = bodyLufs - dropDb;
  for (let i = curve.lufs.length - 1; i >= 0; i--) {
    if (curve.lufs[i] / 10 >= threshold) return (curve.startMs + i * curve.stepMs) / 1000;
  }
  return null;
}
