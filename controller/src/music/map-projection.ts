// Run UMAP projection in the CLI child, never the controller event loop. Its final transaction
// updates data_version to invalidate the map ETag.
//
// Above the sample cap (40k, or less in a heap too small for that) UMAP is
// fitted on a seeded sample and the rest are placed by map-placement.ts:
// umap-js's fit memory grows faster than the library, and a 232k library ran
// the child out of heap on every boot (#2314).
// A failed child is recorded (map-projection-last.json); whether it holds the
// boot retry is map-projection-policy.ts holdBootRetry's.

import { spawn, type ChildProcess } from 'node:child_process';
import v8 from 'node:v8';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { UMAP } from 'umap-js';
import { STATE_DIR } from '../config.js';
import { writeFileAtomicSync } from '../util/atomic-file.js';
import { envInt } from '../util/env.js';
import * as db from './library-db.js';
import { buildSampleGraph, placeAll, sampleIndices, seededRandom } from './map-placement.js';
import {
  MIN_VECTORS,
  childEnv,
  childHeapMb,
  describeFailure,
  failureStreak,
  fitSampleCap,
  holdBootRetry,
  isOutOfMemory,
  OOM_REASON,
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

// The fitted sample's kNN graph, which umap-js keeps in a private field. Read
// through here so an upgrade that renames or reshapes it fails the run with a
// reason: an empty or wrong graph leaves every sampled point its own
// component, and placement would walk from each one, for hours, silently.
export function fitKnnIndices(umap: unknown, n: number): number[][] {
  const knn = (umap as UmapInternals | null)?.knnIndices;
  const fail = (why: string): never => {
    throw new Error(`umap-js's knnIndices ${why}; the sample's neighbour graph is unreadable (umap-js upgraded?)`);
  };
  if (!Array.isArray(knn)) fail('is missing');
  if (knn!.length !== n) fail(`has ${knn!.length} rows for ${n} fitted vectors`);
  for (const row of knn!) {
    if (!Array.isArray(row) || row.length === 0 || !row.every((v) => Number.isInteger(v))) {
      fail('holds a row that is not a list of indices');
    }
  }
  return knn!;
}

// The heap the child is given, in MB (0 = Node's default).
export function childHeapSetting(): number {
  return childHeapMb(envInt('SUBWAVE_MAP_HEAP_MB', 0, { min: 0 }));
}

// The fit size this process's heap can take (map-projection-policy.ts).
export function defaultSampleCap(): number {
  return fitSampleCap(v8.getHeapStatistics().heap_size_limit);
}

// Synchronous heavy lifting — ONLY call from the standalone CLI child.
export async function runProjection(
  log: (line: string) => void = console.log,
  { sampleCap = defaultSampleCap() }: { sampleCap?: number } = {},
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
    `[map] projecting ${all.length} audio vectors (dim=${all[0]!.vector.length}) · sample cap ${sampleCap} ` +
      `for a ${Math.round(v8.getHeapStatistics().heap_size_limit / 1048576)} MB heap` +
      (sampled ? ` · fitting ${fitIdx.length}, placing the rest` : '') +
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
    const graph = buildSampleGraph(vecs, fitKnnIndices(umap, vecs.length));
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
    const error = v.ok ? null : typeof v.error === 'string' ? v.error : 'failed';
    return {
      ok: v.ok,
      code: typeof v.code === 'number' ? v.code : null,
      signal: typeof v.signal === 'string' ? v.signal : null,
      at: typeof v.at === 'string' ? v.at : '',
      vectors: v.vectors,
      error,
      // A record from before these were stored: its reason says whether it ran
      // out of heap, it counts as one failure, and its heap is unknown.
      oom: v.ok ? false : typeof v.oom === 'boolean' ? v.oom : error === OOM_REASON,
      heapMb: typeof v.heapMb === 'number' ? v.heapMb : null,
      failures: v.ok ? 0 : typeof v.failures === 'number' && v.failures >= 1 ? Math.floor(v.failures) : 1,
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
  const stale = isStale(audioVectors, meta);
  return {
    running: child != null,
    startedAt,
    lastLog: lastLog.slice(-12),
    meta,
    audioVectors,
    stale,
    lastExit,
    lastError: lastExit && !lastExit.ok ? lastExit.error : null,
    // Only a stale map has a boot run to hold.
    bootRetryHeld: stale && holdBootRetry(audioVectors, childHeapSetting(), lastExit),
  };
}

// How long a run's end waits for 'close' after 'exit' before it is recorded
// with the output it has. 'close' comes once the pipes drain, normally within
// milliseconds; something still holding a pipe open must not wedge the slot.
export const RUN_END_CLOSE_GRACE_MS = 10_000;
const LOG_LINES = 40;

/**
 * One child run's output and end, recorded once. The failure reason is read
 * from the child's output, and 'exit' can fire while its last lines (the V8
 * out-of-memory report among them) are still in the pipe, so an exit is
 * recorded on 'close', when every line is in, as the tagger does
 * (broadcast/tagger.ts createRunEndReporter); a spawn that failed has no
 * output coming and is recorded at once. A data chunk can end mid-line, so
 * each stream keeps its own remainder. `settled` runs after the record is
 * written, so whoever frees the run's slot there never shows a finished run
 * without its outcome.
 */
export function createRunTracker({
  vectors,
  heapMb,
  previous,
  log,
  record,
  settled,
  onLine = () => {},
  closeGraceMs = RUN_END_CLOSE_GRACE_MS,
}: {
  vectors: number;
  heapMb: number;
  // The record before this run, for the failure streak.
  previous: ProjectionExit | null;
  log: string[];
  record: (exit: ProjectionExit) => void;
  settled: () => void;
  onLine?: (line: string) => void;
  closeGraceMs?: number;
}) {
  const push = (raw: string) => {
    const line = raw.trim();
    if (!line) return;
    log.push(line);
    if (log.length > LOG_LINES) log.shift();
    onLine(line);
  };
  const makeStream = () => {
    let remainder = '';
    return {
      data(chunk: Buffer | string) {
        remainder += chunk.toString();
        const lines = remainder.split('\n');
        remainder = lines.pop() ?? '';
        for (const l of lines) push(l);
      },
      flush() {
        push(remainder);
        remainder = '';
      },
    };
  };
  const out = makeStream();
  const err = makeStream();
  let exited: { code: number | null; signal: string | null } | null = null;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const finish = (code: number | null, signal: string | null, spawnError?: string) => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    out.flush();
    err.flush();
    const ok = spawnError == null && code === 0;
    const error = spawnError != null ? `spawn failed: ${spawnError}` : ok ? null : describeFailure(code, signal, log);
    try {
      record({
        ok,
        code,
        signal,
        at: new Date().toISOString(),
        vectors,
        error,
        oom: !ok && spawnError == null && isOutOfMemory(log),
        heapMb,
        failures: failureStreak(previous, ok),
      });
    } finally {
      settled();
    }
  };
  return {
    stdout: out.data,
    stderr: err.data,
    /** 'exit': the process is gone, but output may still be in the pipes. */
    exited(code: number | null, signal: string | null) {
      if (done || exited) return;
      exited = { code, signal };
      timer = setTimeout(() => finish(code, signal), closeGraceMs);
      timer.unref?.();
    },
    /** 'close': every line of output is in. */
    closed() {
      if (exited) finish(exited.code, exited.signal);
    },
    /** 'error' with no process: nothing more is coming. */
    failed(message: string) {
      finish(null, null, message);
    },
  };
}

// False when one is already running. Safe to kill: the child writes coords in one
// final transaction, so a dead child means "no new map yet", never a partial one.
export function startProjection(): boolean {
  if (child) return false;
  const vectors = db.audioVectorCount();
  // 0 (unset) keeps Node's default heap limit; a set value is at least MIN_HEAP_MB.
  const heapMb = childHeapSetting();
  const proc = spawn('npx', ['tsx', 'src/music/project-map.ts'], {
    cwd: '/app',
    env: childEnv(process.env, heapMb),
  });
  child = proc;
  startedAt = new Date().toISOString();
  lastLog = [];
  const run = createRunTracker({
    vectors,
    heapMb,
    previous: readLastExit(),
    log: lastLog,
    onLine: (line) => console.log(`[map-projection] ${line}`),
    record: (exit) => {
      if (exit.error) console.error(`[map-projection] sound map not stored: ${exit.error}`);
      recordExit(exit);
    },
    // The slot frees only once the outcome is on disk, so the Observatory's
    // poll never sees a finished run whose error isn't readable yet.
    settled: () => {
      if (child === proc) child = null;
    },
  });
  proc.stdout?.on('data', run.stdout);
  proc.stderr?.on('data', run.stderr);
  proc.on('exit', (code, signal) => {
    console.log(`[map-projection] child exited (code=${code}${signal ? `, signal=${signal}` : ''})`);
    run.exited(code, signal);
  });
  proc.on('close', () => run.closed());
  proc.on('error', (err) => {
    console.error('[map-projection] spawn failed:', err.message);
    run.failed(err.message);
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
      if (holdBootRetry(vectors, childHeapSetting(), last)) {
        const why = last!.oom ? 'ran out of memory' : `failed ${last!.failures} times in a row`;
        console.log(
          `[map-projection] sound map stale, but the last run ${why} at ${last!.vectors} vectors ` +
            `(${last!.error}); not retrying on boot until the library or SUBWAVE_MAP_HEAP_MB changes. ` +
            'Re-project from the Observatory to force.',
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
