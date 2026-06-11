// Sonic journeys (Phase 2) — interpolate through the CLAP audio space to build
// a multi-track arc instead of always hugging the current track.
//
// A "journey" is a sequence of waypoint VECTORS between where the run starts
// (the current track's audio embedding) and a destination vibe (another track's
// embedding, or the centroid of a mood/energy bucket). The dj-agent run
// machinery (broadcast/dj-agent.ts) advances one waypoint per pick and hands it
// to the picker as the audio-KNN anchor, so the pool drifts toward the
// destination over several tracks while the LLM still curates each pick.
//
// Everything here degrades to null when the audio index is empty (un-analysed
// library, or no CLAP backend): buildJourney returns null and the run falls
// back to its tempo/key behaviour. Audio vectors are written L2-normalised, so
// the spherical interpolation below stays on the embedding manifold.

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

// Spherical linear interpolation between two vectors at fraction t∈[0,1].
// Stays on the unit hypersphere (the manifold the embeddings live on) rather
// than cutting a chord through the low-density middle. Falls back to a
// normalised lerp for near-parallel or near-antipodal pairs where the sin term
// is ill-conditioned.
export function slerp(a: number[], b: number[], t: number): number[] {
  const ua = normalize(a);
  const ub = normalize(b);
  let d = dot(ua, ub);
  d = Math.max(-1, Math.min(1, d));
  const theta = Math.acos(d);
  if (theta < EPS) return ua.slice(); // ~parallel — already there
  const sinT = Math.sin(theta);
  if (sinT < EPS) {
    // ~antipodal: no well-defined great-circle direction; lerp + renormalise.
    // The exact midpoint of an antipodal pair collapses to zero — snap to the
    // nearer endpoint so we never emit a zero query vector. (Real CLAP vectors
    // are never antipodal; this is pure defence.)
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

// Mean of the audio vectors for a set of track ids, renormalised — the "centre"
// of a mood/energy bucket in audio space. null when none of the ids carry a
// vector. Ids without a vector are skipped (the centroid reflects whatever the
// index actually covers).
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

// Build a journey from the start track toward a destination vibe. Returns null
// (no journey, fall back to today's behaviour) when:
//   - the start track has no audio vector,
//   - the destination can't be resolved to a vector, or
//   - start and destination are essentially the same point (nothing to travel).
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
