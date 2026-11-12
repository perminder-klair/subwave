// Which measurement the tail's LEVEL readings come from: the
// librosa tail facet (outro_json) or the whole-file loudness curve
// (loudness_curve_json, derived by music/curve-ending.ts). One decision, made
// here and applied once, in library.get()'s `outro` projection, so every
// consumer (the queue's ending and exit canvas, the stem blend, the audible-end
// cut in music/silence-trim.ts) reads the same readings.
//
// transitions.tailFromCurve off (the default) returns the stored outro
// untouched, so an upgrade airs exactly as before. On, the curve replaces the
// four level readings, `ending`, `startMs`, `lufs` and `loudnessCurve`, and
// adds `wholeLoudnessCurve`, which the audible-end cut searches when the tail
// series never reaches its threshold (a drone or room noise after the music
// keeps the whole 20 s window under it). The rest stays librosa's: tempo,
// beat and bar grids (they wait for a whole-track beat grid) and the tail
// vocals (Demucs). A track whose curve yields nothing keeps its stored outro;
// a track with a curve but no tail facet gets an outro of the curve's
// readings, with no grid and no vocals (null, i.e. not measured).

import * as settings from '../settings.js';
import { deriveCurveEnding, type EndingEdges } from './curve-ending.js';
import { parseWholeLoudnessCurve } from './whole-loudness-curve.js';
import type { TrackOutro } from './library-db/types.js';

export function tailFromCurveOn(): boolean {
  return settings.get()?.transitions?.tailFromCurve === true;
}

// The outro with the curve's level readings, or the stored one unchanged.
// Pure: the switch is the caller's.
export function curveOutro(
  stored: TrackOutro | null,
  curveJson: string | null | undefined,
  edges: EndingEdges | null,
): TrackOutro | null {
  if (!curveJson) return stored;
  let curve;
  try {
    curve = parseWholeLoudnessCurve(JSON.parse(curveJson));
  } catch {
    return stored;
  }
  const d = deriveCurveEnding(curve, edges);
  if (!curve || !d) return stored;
  return {
    bpm: null,
    beats: null,
    bars: null,
    vocalRanges: null,
    ...stored,
    startMs: d.startMs,
    ending: d.ending,
    lufs: d.lufs,
    loudnessCurve: d.loudnessCurve,
    wholeLoudnessCurve: curve.whole,
  };
}
