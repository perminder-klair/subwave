// Run UMAP projection in the CLI child, never the controller event loop. Its final transaction
// updates data_version to invalidate the map ETag.
//
// Above SAMPLE_CAP vectors UMAP is fitted on a seeded sample and the rest are
// placed by map-placement.ts: umap-js's fit memory grows faster than the
// library, and a 232k library ran the child out of heap on every boot (#2314).
// A failed child is recorded (map-projection-last.json) and holds the boot
// retry until the library moves; map-projection-policy.ts decides.

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { UMAP } from 'umap-js';
import { STATE_DIR } from '../config.js';
import { writeFileAtomicSync } from '../util/atomic-file.js';
import { envInt } from '../util/env.js';
import * as db from './library-db.js';
import { SAMPLE_CAP, buildSampleGraph, placeAll, sampleIndices, seededRandom } from './map-placement.js';
import {
  MIN_VECTORS,
  childEnv,
  describeFailure,
  holdBootRetry,
  isStale as staleBy,
  type ProjectionExit,
  type ProjectionMeta,
} from './map-projection-policy.js';

const ALGO = 'umap-1';
const SPACE = 'audio';
// Fixed, so the same library gives the same sample and the same fit.
const SEED = 2314;
const LAST_EXIT_FILE = 'map-projection-last.json';

// umap-js keeps these for transform(), which the projection never calls. The
// forest alone is most of the fit's retained heap.
interface UmapInternals {
  knnIndices?: number[][];
  rpForest?: unknown;
  searchGraph?: unknown;
}

export interface ProjectionResult {
  count: number;
  ms: number;
}

// Synchronous heavy lifting — ONLY call from the standalone CLI child.
export async function runProjection(
  log: (line: string) => void = console.log,
  { sampleCap = SAMPLE_CAP }: { sampleCap?: number } = {},
): Promise<ProjectionResult> {
  const t0 = Date.now();
  // Sorted, so the seeded sample does not depend on SQLite's row order.
  const all = db.allAudioVectors().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (all.length < MIN_VECTORS) {
    throw new Error(`only ${all.length} audio vectors (< ${MIN_VECTORS}) — not enough to project`);
  }
  const random = seededRandom(SEED);
  const fitIdx = sampleIndices(all.length, sampleCap, random);
  const sampled = fitIdx.length < all.length;
  log(
    `[map] projecting ${all.length} audio vectors (dim=${all[0]!.vector.length})` +
      (sampled ? ` · fitting a sample of ${fitIdx.length}, placing the rest` : '') +
      '…',
  );

  // Float32Array rows go in as they are: umap-js only indexes them, and a
  // number[] copy doubles the input's size on the JS heap.
  const vecs = fitIdx.map((i) => all[i]!.vector);
  // CLAP vectors are stored unit-normalised, so the default euclidean ordering
  // is identical to cosine.
  const umap = new UMAP({ nComponents: 2, nNeighbors: 15, minDist: 0.1, random });
  const nEpochs = umap.initializeFit(vecs as unknown as number[][]);
  const internals = umap as unknown as UmapInternals;
  internals.rpForest = undefined;
  internals.searchGraph = undefined;
  log(`[map] knn graph built in ${Math.round((Date.now() - t0) / 1000)}s · optimising ${nEpochs} epochs`);
  for (let i = 0; i < nEpochs; i++) {
    umap.step();
    if (i > 0 && i % 50 === 0) {
      log(`[map] epoch ${i}/${nEpochs}`);
      // let the child's stdout flush / signals land between bursts
      await new Promise((r) => setImmediate(r));
    }
  }
  const fitted = umap.getEmbedding();

  let raw: number[][];
  if (!sampled) {
    raw = fitted;
  } else {
    const graph = buildSampleGraph(vecs, internals.knnIndices ?? []);
    raw = new Array(all.length);
    const rest: number[] = [];
    let f = 0;
    for (let i = 0; i < all.length; i++) {
      if (f < fitIdx.length && fitIdx[f] === i) raw[i] = fitted[f++]!;
      else rest.push(i);
    }
    const tp = Date.now();
    const placed = await placeAll(
      rest.map((i) => all[i]!.vector),
      graph,
      fitted,
      {
        onProgress: async (done) => {
          log(`[map] placed ${done}/${rest.length}`);
          await new Promise((r) => setImmediate(r));
        },
      },
    );
    for (let j = 0; j < rest.length; j++) raw[rest[j]!] = placed[j]!;
    log(`[map] placed ${rest.length} tracks in ${Math.round((Date.now() - tp) / 1000)}s`);
  }

  // Per-axis normalise to [0,1]: the 1st-99th percentile span maps to
  // [PAD, 1-PAD], each tail spreading linearly into its PAD band. Clamping
  // instead piles every outlier onto one coordinate.
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

export interface ProjectionStatus {
  running: boolean;
  startedAt: string | null;
  lastLog: string[];
  meta: ProjectionMeta | null;
  audioVectors: number;
  stale: boolean;
  // The last child's outcome, kept across restarts; null before the first run.
  lastExit: ProjectionExit | null;
  // Why the last child failed; null when it succeeded or never ran.
  lastError: string | null;
  // True while that failure holds the automatic boot run.
  bootRetryHeld: boolean;
}

let child: ChildProcess | null = null;
let startedAt: string | null = null;
let lastLog: string[] = [];

function isStale(vectors: number, meta: ProjectionMeta | null): boolean {
  return staleBy(vectors, meta, ALGO, SPACE);
}

function lastExitPath(): string {
  return join(STATE_DIR, LAST_EXIT_FILE);
}

// Lenient: a missing or hand-mangled file reads as "no record".
export function readLastExit(): ProjectionExit | null {
  try {
    const v = JSON.parse(readFileSync(lastExitPath(), 'utf8')) as ProjectionExit;
    if (typeof v?.ok !== 'boolean' || typeof v.vectors !== 'number') return null;
    return {
      ok: v.ok,
      code: typeof v.code === 'number' ? v.code : null,
      signal: typeof v.signal === 'string' ? v.signal : null,
      at: typeof v.at === 'string' ? v.at : '',
      vectors: v.vectors,
      error: v.ok ? null : typeof v.error === 'string' ? v.error : 'failed',
    };
  } catch {
    return null;
  }
}

export function recordExit(exit: ProjectionExit): void {
  try {
    writeFileAtomicSync(lastExitPath(), JSON.stringify(exit, null, 2));
  } catch (err: any) {
    console.warn(`[map-projection] could not record the run's outcome: ${err.message}`);
  }
}

// Test seam: forget the record.
export function clearLastExit(): void {
  rmSync(lastExitPath(), { force: true });
}

export function projectionStatus(): ProjectionStatus {
  const meta = db.getMapProjectionMeta();
  const audioVectors = db.audioVectorCount();
  const lastExit = readLastExit();
  return {
    running: child != null,
    startedAt,
    lastLog: lastLog.slice(-12),
    meta,
    audioVectors,
    stale: isStale(audioVectors, meta),
    lastExit,
    lastError: lastExit && !lastExit.ok ? lastExit.error : null,
    bootRetryHeld: holdBootRetry(audioVectors, lastExit),
  };
}

// False when one is already running. Safe to kill: the child writes coords in one
// final transaction, so a dead child means "no new map yet", never a partial one.
export function startProjection(): boolean {
  if (child) return false;
  const vectors = db.audioVectorCount();
  const proc = spawn('npx', ['tsx', 'src/music/project-map.ts'], {
    cwd: '/app',
    // 0 (unset) keeps Node's default heap limit.
    env: childEnv(process.env, envInt('SUBWAVE_MAP_HEAP_MB', 0, { min: 0 })),
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
  // 'error' and 'exit' can both fire for one child; record the first.
  let settled = false;
  const settle = (exit: ProjectionExit) => {
    if (child === proc) child = null;
    if (settled) return;
    settled = true;
    recordExit(exit);
  };
  proc.on('exit', (code, signal) => {
    console.log(`[map-projection] child exited (code=${code}${signal ? `, signal=${signal}` : ''})`);
    const ok = code === 0;
    const error = ok ? null : describeFailure(code, signal, lastLog);
    if (error) console.error(`[map-projection] sound map not stored: ${error}`);
    settle({ ok, code, signal, at: new Date().toISOString(), vectors, error });
  });
  proc.on('error', (err) => {
    console.error('[map-projection] spawn failed:', err.message);
    settle({ ok: false, code: null, signal: null, at: new Date().toISOString(), vectors, error: `spawn failed: ${err.message}` });
  });
  return true;
}

// Delayed so it never competes with startup itself.
export function maybeProjectOnBoot(delayMs = 30_000): void {
  setTimeout(() => {
    try {
      const vectors = db.audioVectorCount();
      if (vectors < MIN_VECTORS || !isStale(vectors, db.getMapProjectionMeta())) return;
      const last = readLastExit();
      if (holdBootRetry(vectors, last)) {
        console.log(
          `[map-projection] sound map stale, but the last run failed at ${last!.vectors} vectors ` +
            `(${last!.error}); not retrying until the library changes. Re-project from the Observatory to force.`,
        );
        return;
      }
      console.log('[map-projection] sound map stale — starting background projection');
      startProjection();
    } catch (err: any) {
      console.error('[map-projection] boot check failed:', err.message);
    }
  }, delayMs).unref();
}
