// The tail facet's LEVEL readings, derived from the whole-file loudness curve:
// the fade-or-cold ending, the wind-down start, the tail
// loudness and the short-term curve the audible-end cut reads. Pure: no
// library, no settings. `npm run curve-ab` compares it with the stored librosa
// readings; music/tail-levels.ts puts it on air behind
// transitions.tailFromCurve.
//
// The librosa tail facet reads the last OUTRO_SECONDS (20 s) before the music
// stops, as RMS at 22 kHz: `loud` is the 95th percentile of that window, the
// wind-down starts at the last frame >= 60 % of it, and the ending is a fade
// when the last 1.5 s average < 15 % of it after >= 3 s of wind-down. Here the
// same window is read off the stored curve's `tail` series (EBU R128
// short-term, 3 s window stamped at its END, every 0.5 s):
//   - window: the points stamped from (end - 20 s + 3 s) to the music's end,
//     i.e. the short-term blocks that lie wholly inside the librosa window;
//   - reference: the 95th percentile of those points, as librosa's `loud`;
//   - ending: fade when the point at the music's end sits FADE_DROP_DB or more
//     under the reference. That point covers the last 3 s. No span condition:
//     once the drop is read in loudness, the 3 s rule added nothing;
//   - wind-down start: the last point within WIND_DOWN_DB of the reference,
//     minus WIND_DOWN_LAG_MS, because a short-term point stays near level for
//     up to ~2 s after the audio under it drops; clamped to the window;
//   - tail loudness: the power mean of the window's points over the -70 LUFS
//     absolute gate, then a -10 LU relative gate (BS.1770's two gates, on
//     short-term blocks instead of 400 ms ones).
// The three constants were fitted on 2,000 tracks of one 72,938-track library
// and judged on the other 70,696 (the librosa readings as reference): fade or
// cold 93.5 % alike, the disagreements split evenly both ways and mostly
// within 3 dB of the threshold; wind-down start median 0.66 s apart, 90 %
// within 2.3 s; tail loudness 90 % within 0.9 dB.
//
// The music's end is the stored edges' (decoded length - trailing silence,
// the absolute -50 dBFS floor), the same placement the librosa window takes
// (analyzer.tailWindowFor); without edges, the curve's last point above the
// absolute gate.

import type { LoudnessCurve } from './loudness-curve.js';
import type { LoudnessSeries, WholeLoudnessCurve } from './whole-loudness-curve.js';

export const OUTRO_WINDOW_MS = 20_000;
export const SHORT_TERM_WINDOW_MS = 3_000;
export const FADE_DROP_DB = 9;
export const WIND_DOWN_DB = 6;
export const WIND_DOWN_LAG_MS = 2_000;
// A window needs a few short-term blocks to say anything: 2 s of them.
const MIN_POINTS = 4;
const ABS_GATE_LUFS = -70;
const REL_GATE_LU = 10;

export interface CurveEnding {
  musicEndMs: number;
  startMs: number;
  ending: 'fade' | 'cold';
  // Power-gated mean of the window, LUFS (null when every point is gated out).
  lufs: number | null;
  // The window's reference level (95th percentile), and how far under it the
  // last point sits: the margin behind `ending`.
  referenceLufs: number;
  endDropDb: number;
  // The tail series in the stored tail-curve shape (music/loudness-curve.ts),
  // for audibleEndSec.
  loudnessCurve: LoudnessCurve;
}

export interface EndingEdges {
  decodedDurationMs?: number | null;
  edgeTailMs?: number | null;
}

function pointAt(s: LoudnessSeries, i: number): { t: number; lufs: number } {
  return { t: s.startMs + i * s.stepMs, lufs: s.lufs[i]! / 10 };
}

// Where the music stops: the edges when measured, else the series' last point
// over the absolute gate. null when neither says.
export function musicEndMs(tail: LoudnessSeries, edges?: EndingEdges | null): number | null {
  const dur = edges?.decodedDurationMs;
  const gap = edges?.edgeTailMs;
  if (typeof dur === 'number' && typeof gap === 'number' && Number.isFinite(dur) && Number.isFinite(gap)) {
    const end = dur - gap;
    if (end > 0) return Math.round(end);
  }
  for (let i = tail.lufs.length - 1; i >= 0; i--) {
    const p = pointAt(tail, i);
    if (p.lufs > ABS_GATE_LUFS) return p.t;
  }
  return null;
}

function percentile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

function gatedMean(values: number[]): number | null {
  const pw = values.filter(v => v > ABS_GATE_LUFS).map(v => 10 ** (v / 10));
  if (!pw.length) return null;
  const rel = 10 * Math.log10(pw.reduce((a, b) => a + b, 0) / pw.length) - REL_GATE_LU;
  const kept = pw.filter(p => 10 * Math.log10(p) >= rel);
  return Math.round(10 * Math.log10(kept.reduce((a, b) => a + b, 0) / kept.length) * 100) / 100;
}

// The level readings of the tail, or null when the curve has no tail series,
// the music's end is unknown, or the window holds too few points.
export function deriveCurveEnding(
  curve: WholeLoudnessCurve | null | undefined,
  edges?: EndingEdges | null,
): CurveEnding | null {
  const tail = curve?.tail;
  if (!tail || tail.lufs.length === 0) return null;
  const end = musicEndMs(tail, edges);
  if (end == null) return null;
  const windowStart = end - OUTRO_WINDOW_MS;
  const pts: Array<{ t: number; lufs: number }> = [];
  for (let i = 0; i < tail.lufs.length; i++) {
    const p = pointAt(tail, i);
    if (p.t >= windowStart + SHORT_TERM_WINDOW_MS && p.t <= end) pts.push(p);
  }
  if (pts.length < MIN_POINTS) return null;

  const reference = percentile(pts.map(p => p.lufs).sort((a, b) => a - b), 0.95);
  const endDropDb = Math.round((reference - pts[pts.length - 1]!.lufs) * 10) / 10;
  let lastLevel: number | null = null;
  for (let i = pts.length - 1; i >= 0; i--) {
    if (pts[i]!.lufs >= reference - WIND_DOWN_DB) { lastLevel = pts[i]!.t; break; }
  }
  const startMs = lastLevel == null ? windowStart : Math.max(windowStart, lastLevel - WIND_DOWN_LAG_MS);
  return {
    musicEndMs: end,
    startMs: Math.round(startMs),
    ending: endDropDb >= FADE_DROP_DB ? 'fade' : 'cold',
    lufs: gatedMean(pts.map(p => p.lufs)),
    referenceLufs: reference,
    endDropDb,
    loudnessCurve: { startMs: tail.startMs, stepMs: tail.stepMs, lufs: tail.lufs.slice() },
  };
}
