// Sound-map projection decisions (#2314), pure so they are testable without
// spawning the child. map-projection.ts reads, writes, spawns and logs.
//
// One drift rule answers both questions: whether the stored map is stale, and
// whether the library has moved far enough since a failed attempt to try again
// on boot. Before #2314 a crashed child wrote nothing, so the map stayed stale
// and every boot launched the same doomed run (a 232k library ran out of heap
// two minutes in, on every restart). A failure now holds the boot retry until
// the vector count passes the stale threshold measured from the failed attempt.
// An operator's manual run is never held.

import { SAMPLE_CAP } from './map-placement.js';

export const MIN_VECTORS = 50; // below this a projection is noise
export const STALE_FRACTION = 0.05;
export const STALE_ABS = 50;

export interface ProjectionMeta {
  algo: string;
  space: string;
  count: number;
  setAt: string;
}

// The last child's outcome, persisted so a restart remembers a failure.
export interface ProjectionExit {
  ok: boolean;
  code: number | null;
  signal: string | null;
  at: string;
  vectors: number; // audio vectors when the attempt started
  error: string | null; // null when ok
}

// Both counts are measured; drift must clear the absolute AND the fractional bar.
export function drifted(vectors: number, from: number): boolean {
  const drift = Math.abs(vectors - from);
  return drift >= STALE_ABS && drift / Math.max(1, vectors) >= STALE_FRACTION;
}

export function isStale(vectors: number, meta: ProjectionMeta | null, algo: string, space: string): boolean {
  if (vectors < MIN_VECTORS) return false; // nothing worth projecting
  if (!meta || meta.algo !== algo || meta.space !== space) return true;
  return drifted(vectors, meta.count);
}

// Old-generation heap one fitted vector needs, judged at the fit's peak (the
// projection forest built and then flattened alongside itself). Measured with
// the limit really applied (--max-old-space-size): 24k fitted in 1,024 MB of
// old generation and 28.3k did not; 40k fitted in 1,536 MB and not in 1,024
// MB. 52 KB keeps every point on the safe side: 1,024 MB gives 20.1k and
// 1,536 MB gives 30.2k.
export const BYTES_PER_FIT_VECTOR = 52 * 1024;
export const MIN_SAMPLE = 5_000;
// v8's heap_size_limit is the old generation plus the young generation's
// reserve, 3 x the max semi-space, 64 MB by default on Node 24: the flag's
// 512 reads back as 704, 1,024 as 1,216, the default 4,096 as 4,288. The fit's
// long-lived forest lives in the old generation, so the young reserve is taken
// off before dividing. A host that sets --max-semi-space-size moves this; an
// over-estimate only makes the sample smaller.
export const YOUNG_GEN_BYTES = 192 * 1024 * 1024;
// SUBWAVE_MAP_HEAP_MB is raised to this. Below it even the minimum sample plus
// loading every vector would not fit: 512 MB fits a 10k sample, and measured,
// placed a 60k library (#2314 review).
export const MIN_HEAP_MB = 512;

// How many vectors the child may fit in the heap it was given, at most
// SAMPLE_CAP. Node's default heap shrinks with the host's memory, so a fixed
// 40k could still run a small NAS out of heap (#2314 review).
export function fitSampleCap(heapLimitBytes: number): number {
  const oldGen = heapLimitBytes - YOUNG_GEN_BYTES;
  if (!(oldGen > 0)) return MIN_SAMPLE;
  return Math.max(MIN_SAMPLE, Math.min(SAMPLE_CAP, Math.floor(oldGen / BYTES_PER_FIT_VECTOR)));
}

// The heap the child is given, in MB: 0 (unset) keeps Node's default, and
// anything set is at least MIN_HEAP_MB.
export function childHeapMb(setting: number): number {
  if (!(setting > 0)) return 0;
  return Math.max(MIN_HEAP_MB, Math.floor(setting));
}

// True while a failed attempt should keep the automatic boot run from starting.
export function holdBootRetry(vectors: number, last: ProjectionExit | null): boolean {
  if (!last || last.ok) return false;
  return !drifted(vectors, last.vectors);
}

// One line an operator can act on, from the child's exit and its log tail.
export function describeFailure(code: number | null, signal: string | null, log: readonly string[]): string {
  if (log.some((l) => /heap out of memory|Reached heap limit/i.test(l))) {
    return 'ran out of memory (JavaScript heap); raise SUBWAVE_MAP_HEAP_MB';
  }
  for (let i = log.length - 1; i >= 0; i--) {
    const m = /^projection failed:\s*(.+)$/.exec(log[i]!);
    if (m) return m[1]!;
  }
  if (signal) return `killed by ${signal}`;
  return `exited with code ${code}`;
}

// The child's env: SUBWAVE_MAP_HEAP_MB (0 = Node's default) becomes a heap
// flag appended to any NODE_OPTIONS, where the later flag wins.
export function childEnv(env: NodeJS.ProcessEnv, heapMb: number): NodeJS.ProcessEnv {
  if (!(heapMb > 0)) return env;
  const flag = `--max-old-space-size=${Math.floor(heapMb)}`;
  return { ...env, NODE_OPTIONS: env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${flag}` : flag };
}
