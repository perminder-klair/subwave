// Sound-map projection — the Observatory's "real galaxy" layout.
//
// Projects every stored CLAP audio vector to 2D with UMAP (cosine metric) so
// tracks that SOUND alike sit close on the map, then normalises the cloud to
// [0,1] per axis (robust 1st–99th percentile scale, so a few outliers can't
// crush the interesting middle) and persists it as tracks.map_x / map_y.
//
// UMAP at library scale is MINUTES of synchronous CPU (the KNN-graph build
// dominates; ~4min at 9k×512), so the projection NEVER runs on the live
// controller's event loop. `runProjection()` is the in-process core used by
// the standalone CLI child (src/music/project-map.ts, spawned via tsx exactly
// like the tagger's children); `startProjection()` spawns and tracks that
// child; `maybeProjectOnBoot()` is the staleness check server.ts fires after
// startup. Staleness is a cheap count comparison: the meta row records how
// many vectors the last projection saw, and re-running is only worth it when
// the analysed library has grown/shrunk meaningfully (>5% or ≥50 tracks).
//
// The child opens its own DB connection (WAL — the tagger already proved this
// pattern safe alongside the live controller) and its final transaction bumps
// `data_version`, so the observatory ETag invalidates without any signalling.

import { spawn, type ChildProcess } from 'node:child_process';
import { UMAP } from 'umap-js';
import * as db from './library-db.js';

const ALGO = 'umap-1';
const SPACE = 'audio';
const MIN_VECTORS = 50; // below this a projection is noise — genre layout reads better
const STALE_FRACTION = 0.05;
const STALE_ABS = 50;

// ---------------------------------------------------------------------------
// Core (runs inside the CLI child)
// ---------------------------------------------------------------------------

export interface ProjectionResult {
  count: number;
  ms: number;
}

// Synchronous heavy lifting — ONLY call from the standalone CLI child.
export async function runProjection(log: (line: string) => void = console.log): Promise<ProjectionResult> {
  const t0 = Date.now();
  const all = db.allAudioVectors();
  if (all.length < MIN_VECTORS) {
    throw new Error(`only ${all.length} audio vectors (< ${MIN_VECTORS}) — not enough to project`);
  }
  log(`[map] projecting ${all.length} audio vectors (dim=${all[0]!.vector.length})…`);

  const vecs = all.map((v) => Array.from(v.vector));
  // Default (euclidean) distance is correct here: CLAP vectors are stored
  // unit-normalised, so euclidean ordering is identical to cosine.
  const umap = new UMAP({ nComponents: 2, nNeighbors: 15, minDist: 0.1 });
  const nEpochs = umap.initializeFit(vecs);
  log(`[map] knn graph built in ${Math.round((Date.now() - t0) / 1000)}s · optimising ${nEpochs} epochs`);
  for (let i = 0; i < nEpochs; i++) {
    umap.step();
    if (i > 0 && i % 50 === 0) {
      log(`[map] epoch ${i}/${nEpochs}`);
      // let the child's stdout flush / signals land between bursts
      await new Promise((r) => setImmediate(r));
    }
  }
  const raw = umap.getEmbedding();

  // Robust per-axis normalise to [0,1]: the 1st–99th percentile span maps to
  // [PAD, 1-PAD] and each tail spreads linearly into its PAD band. A hard
  // clamp instead would pile every outlier onto the exact same coordinate — a
  // visible straight wall of stars along the map edge.
  const PAD = 0.02;
  const norm = (axis: 0 | 1): ((v: number) => number) => {
    const sorted = raw.map((p) => p[axis]!).sort((a, b) => a - b);
    const min = sorted[0]!;
    const max = sorted[sorted.length - 1]!;
    const lo = sorted[Math.floor(sorted.length * 0.01)]!;
    const hi = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))]!;
    const span = hi - lo || 1;
    return (v) => {
      if (v < lo) return lo === min ? PAD : (PAD * (v - min)) / (lo - min);
      if (v > hi) return hi === max ? 1 - PAD : 1 - PAD + (PAD * (v - hi)) / (max - hi);
      return PAD + (1 - 2 * PAD) * ((v - lo) / span);
    };
  };
  const nx = norm(0);
  const ny = norm(1);
  const coords = all.map((v, i) => ({ id: v.id, x: nx(raw[i]![0]!), y: ny(raw[i]![1]!) }));

  db.setMapCoordsBulk(coords);
  db.setMapProjectionMeta(ALGO, SPACE, coords.length);
  const ms = Date.now() - t0;
  log(`[map] projection stored: ${coords.length} tracks in ${Math.round(ms / 1000)}s`);
  return { count: coords.length, ms };
}

// ---------------------------------------------------------------------------
// Manager (runs inside the live controller)
// ---------------------------------------------------------------------------

export interface ProjectionStatus {
  running: boolean;
  startedAt: string | null;
  lastLog: string[];
  meta: { algo: string; space: string; count: number; setAt: string } | null;
  audioVectors: number;
  stale: boolean;
}

let child: ChildProcess | null = null;
let startedAt: string | null = null;
let lastLog: string[] = [];

export function isStale(): boolean {
  const vectors = db.audioVectorCount();
  if (vectors < MIN_VECTORS) return false; // nothing worth projecting
  const meta = db.getMapProjectionMeta();
  if (!meta || meta.algo !== ALGO || meta.space !== SPACE) return true;
  const drift = Math.abs(vectors - meta.count);
  return drift >= STALE_ABS && drift / Math.max(1, vectors) >= STALE_FRACTION;
}

export function projectionStatus(): ProjectionStatus {
  return {
    running: child != null,
    startedAt,
    lastLog: lastLog.slice(-12),
    meta: db.getMapProjectionMeta(),
    audioVectors: db.audioVectorCount(),
    stale: isStale(),
  };
}

// Spawn the projection child. Returns false when one is already running.
// Idempotent + safe to kill: the child writes coords in one final transaction,
// so a dead child just means "no new map yet", never a half-written one.
export function startProjection(): boolean {
  if (child) return false;
  const proc = spawn('npx', ['tsx', 'src/music/project-map.ts'], {
    cwd: '/app',
    env: process.env,
  });
  child = proc;
  startedAt = new Date().toISOString();
  lastLog = [];
  const capture = (chunk: Buffer) => {
    for (const raw of chunk.toString().split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      lastLog.push(line);
      if (lastLog.length > 40) lastLog.shift();
      console.log(`[map-projection] ${line}`);
    }
  };
  proc.stdout?.on('data', capture);
  proc.stderr?.on('data', capture);
  proc.on('exit', (code) => {
    console.log(`[map-projection] child exited (code=${code})`);
    child = null;
  });
  proc.on('error', (err) => {
    console.error('[map-projection] spawn failed:', err.message);
    child = null;
  });
  return true;
}

// Boot hook — fire the projection when the stored map no longer matches the
// analysed library. Delayed so it never competes with startup itself.
export function maybeProjectOnBoot(delayMs = 30_000): void {
  setTimeout(() => {
    try {
      if (!isStale()) return;
      console.log('[map-projection] sound map stale — starting background projection');
      startProjection();
    } catch (err: any) {
      console.error('[map-projection] boot check failed:', err.message);
    }
  }, delayMs).unref();
}
