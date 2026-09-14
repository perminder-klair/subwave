// Sonic journeys: waypoint vectors interpolated through the CLAP audio space from
// the current track to a destination vibe. dj-agent advances one waypoint per pick
// and uses it as the audio-KNN anchor. Degrades to null when the audio index is
// empty. Audio vectors are stored L2-normalised, so slerp stays on the manifold.

import * as db from './library-db.js';

const EPS = 1e-6;

function norm(v: number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

function normalize(v: number[]): number[] {
  const n = norm(v);
  if (n < EPS) return v.slice();
  return v.map(x => x / n);
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Spherical linear interpolation at t in [0,1], staying on the unit hypersphere.
// Falls back to a normalised lerp where the sin term is ill-conditioned.
export function slerp(a: number[], b: number[], t: number): number[] {
  const ua = normalize(a);
  const ub = normalize(b);
  let d = dot(ua, ub);
  d = Math.max(-1, Math.min(1, d));
  const theta = Math.acos(d);
  if (theta < EPS) return ua.slice(); // ~parallel — already there
  const sinT = Math.sin(theta);
  if (sinT < EPS) {
    // ~antipodal: no great-circle direction. Lerp + renormalise, snapping to the
    // nearer endpoint at the midpoint so this never emits a zero vector.
    const lerp = ua.map((x, i) => x * (1 - t) + ub[i] * t);
    if (norm(lerp) < EPS) return t < 0.5 ? ua.slice() : ub.slice();
    return normalize(lerp);
  }
  const wa = Math.sin((1 - t) * theta) / sinT;
  const wb = Math.sin(t * theta) / sinT;
  return ua.map((x, i) => wa * x + wb * ub[i]);
}

// n waypoint vectors stepping from just past `start` to `end` (the last one is
// `end`). t_i = i/n for i in 1..n.
export function interpolate(start: number[], end: number[], n: number): number[][] {
  const steps = Math.max(1, Math.floor(n));
  const out: number[][] = [];
  for (let i = 1; i <= steps; i++) out.push(slerp(start, end, i / steps));
  return out;
}

// Mean of the audio vectors for a set of track ids, renormalised. null when
// none carry a vector; ids without one are skipped.
export function audioCentroid(ids: string[]): number[] | null {
  let acc: number[] | null = null;
  let count = 0;
  for (const id of ids) {
    const v = db.getAudioVector(id);
    if (!v) continue;
    if (!acc) acc = new Array(v.length).fill(0);
    for (let i = 0; i < v.length; i++) acc[i] += v[i];
    count++;
  }
  if (!acc || count === 0) return null;
  for (let i = 0; i < acc.length; i++) acc[i] /= count;
  return normalize(acc);
}

export interface JourneyOpts {
  startId: string;
  // Destination: a specific track's vector (endId) OR the centroid of a bucket
  // of ids (endIds, e.g. an energy/mood bucket). endId wins when both are set.
  endId?: string | null;
  endIds?: string[] | null;
  steps: number; // how many picks the journey spans (clamped 1..8)
}

export interface Journey {
  waypoints: number[][]; // one per step; waypoints[last] ≈ the destination
  steps: number;
}

// Returns null (fall back to today's behaviour) when the start track has no
// audio vector, the destination can't be resolved, or the two are the same point.
export function buildJourney(opts: JourneyOpts): Journey | null {
  const startVec = db.getAudioVector(opts.startId);
  if (!startVec) return null;
  const start = Array.from(startVec);

  let end: number[] | null = null;
  if (opts.endId) {
    const v = db.getAudioVector(opts.endId);
    end = v ? Array.from(v) : null;
  } else if (opts.endIds && opts.endIds.length) {
    end = audioCentroid(opts.endIds);
  }
  if (!end) return null;

  // Already at the destination — no meaningful arc to interpolate.
  if (dot(normalize(start), normalize(end)) > 1 - 1e-4) return null;

  const steps = Math.max(1, Math.min(Math.floor(opts.steps), 8));
  return { waypoints: interpolate(start, end, steps), steps };
}
