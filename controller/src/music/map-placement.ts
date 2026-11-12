// Sound-map placement for tracks outside the UMAP sample (#2314).
//
// umap-js's fit memory grows faster than the library: its random-projection
// forest keeps 5 + sqrt(n)/20 trees, each split node holding a full 512-number
// hyperplane as a plain JS array, and it builds every tree before flattening
// them, so the forest exists twice at its peak. 50k vectors needed 2-3 GB of
// heap; 232k needed an estimated 13-17 GB and crashed Node's default ~4 GB.
// So map-projection.ts fits UMAP on a seeded sample of at most SAMPLE_CAP
// tracks and places every other track here: at the distance-weighted mean of
// its nearest sampled neighbours' 2D positions.
//
// The neighbour search is a best-first walk over the sample's own kNN graph
// (the one UMAP built while fitting, made symmetric), entered from the closest
// of a set of pivots. That graph falls apart into one component per
// well-separated scene, and a walk never leaves the component it starts in, so
// every component gets a pivot of its own: with evenly spaced pivots alone, a
// query whose scene held no pivot landed in the wrong one (40% of queries on
// 300 synthetic clusters, whatever the search width). Memory is the graph plus
// a few typed arrays, so it stays bounded whatever the library size.
//
// Chosen over umap.transform(), measured on 50k placed points around a 10k
// sample (#2314): about the same time (21 s vs 20 s), half the extra heap, and
// 99.7% of points in their true cluster against transform's 4.3%. transform
// also needs the forest and search graph kept alive.
//
// Everything here is pure and deterministic: no Math.random, no DB.

// Fit size above which the rest of the library is placed, not fitted. With
// Float32Array rows a 40k fit ran inside a 1.5 GB heap (2.7 GB peak RSS), under
// Node's default limit on small hosts; 50k with number[] rows failed at 2 GB.
export const SAMPLE_CAP = 40_000;
// Neighbours averaged per placed point.
export const PLACE_K = 10;
// Width of the best-first walk. On overlapping synthetic clusters (one graph
// component) recall@10 against exact kNN was .81 at 16, .90 at 32, .925 at
// 64 and .938 at 128, for .33/.33/.39/.54 ms per query.
export const SEARCH_EF = 64;
// Evenly spaced pivots on top of one per graph component.
const PIVOTS = 256;
const SEEDS = 8;

// mulberry32: small seeded PRNG, so a sample and a fit are reproducible.
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Indices of a seeded random sample of `size` out of `n`, ascending. Returns
// every index when n <= size.
export function sampleIndices(n: number, size: number, random: () => number): number[] {
  if (n <= size) return Array.from({ length: n }, (_, i) => i);
  // Partial Fisher-Yates over an index array.
  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  for (let i = 0; i < size; i++) {
    const j = i + Math.floor(random() * (n - i));
    const t = idx[i]!;
    idx[i] = idx[j]!;
    idx[j] = t;
  }
  return Array.from(idx.subarray(0, size)).sort((a, b) => a - b);
}

export function sqDist(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    s += d * d;
  }
  return s;
}

export interface SampleGraph {
  vectors: ArrayLike<number>[];
  adjacency: Int32Array[];
  pivots: Int32Array;
}

// Symmetrise the sample's kNN graph (UMAP's knnIndices: row i lists i's
// neighbours, usually itself first) so the walk can travel both ways.
export function buildSampleGraph(vectors: ArrayLike<number>[], knnIndices: ArrayLike<number>[]): SampleGraph {
  const n = vectors.length;
  const sets: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
  for (let i = 0; i < n; i++) {
    const row = knnIndices[i];
    if (!row) continue;
    for (let j = 0; j < row.length; j++) {
      const nb = row[j]!;
      if (nb < 0 || nb >= n || nb === i) continue;
      sets[i]!.add(nb);
      sets[nb]!.add(i);
    }
  }
  const adjacency = sets.map((s) => Int32Array.from(s));
  const pivotSet = new Set<number>(componentRoots(adjacency));
  const spread = Math.min(PIVOTS, n);
  for (let i = 0; i < spread; i++) pivotSet.add(Math.floor((i * n) / spread));
  const pivots = Int32Array.from([...pivotSet].sort((a, b) => a - b));
  return { vectors, adjacency, pivots };
}

// The lowest index of each connected component (iterative BFS).
export function componentRoots(adjacency: Int32Array[]): number[] {
  const n = adjacency.length;
  const seen = new Uint8Array(n);
  const roots: number[] = [];
  const queue = new Int32Array(n);
  for (let r = 0; r < n; r++) {
    if (seen[r]) continue;
    roots.push(r);
    seen[r] = 1;
    let head = 0;
    let tail = 0;
    queue[tail++] = r;
    while (head < tail) {
      const nbs = adjacency[queue[head++]!]!;
      for (let j = 0; j < nbs.length; j++) {
        const nb = nbs[j]!;
        if (!seen[nb]) {
          seen[nb] = 1;
          queue[tail++] = nb;
        }
      }
    }
  }
  return roots;
}

// Sorted-ascending bounded list of (dist, index); ef is small, so insertion is cheap.
function insertSorted(ds: number[], is: number[], d: number, i: number, cap: number): void {
  let pos = ds.length;
  while (pos > 0 && ds[pos - 1]! > d) pos--;
  if (pos >= cap) return;
  ds.splice(pos, 0, d);
  is.splice(pos, 0, i);
  if (ds.length > cap) {
    ds.pop();
    is.pop();
  }
}

export interface Searcher {
  search(query: ArrayLike<number>, k: number): { indices: number[]; dists: number[] };
}

// Approximate k nearest sample points (squared euclidean). The visit stamps are
// one Uint32Array reused across queries, so a query allocates only small arrays.
export function makeSearcher(graph: SampleGraph, ef = SEARCH_EF): Searcher {
  const { vectors, adjacency, pivots } = graph;
  const n = vectors.length;
  const stamp = new Uint32Array(n);
  let tick = 0;
  return {
    search(query, k) {
      tick++;
      if (tick === 0xffffffff) {
        stamp.fill(0);
        tick = 1;
      }
      const width = Math.max(ef, k);
      const rd: number[] = [];
      const ri: number[] = [];
      const cd: number[] = [];
      const ci: number[] = [];
      // Seed from the closest pivots.
      const pd: number[] = [];
      const pi: number[] = [];
      for (let p = 0; p < pivots.length; p++) {
        const idx = pivots[p]!;
        insertSorted(pd, pi, sqDist(query, vectors[idx]!), idx, SEEDS);
      }
      for (let s = 0; s < pd.length; s++) {
        stamp[pi[s]!] = tick;
        insertSorted(rd, ri, pd[s]!, pi[s]!, width);
        insertSorted(cd, ci, pd[s]!, pi[s]!, Number.MAX_SAFE_INTEGER);
      }
      while (cd.length > 0) {
        const d0 = cd.shift()!;
        const i0 = ci.shift()!;
        if (rd.length >= width && d0 > rd[rd.length - 1]!) break;
        const nbs = adjacency[i0]!;
        for (let j = 0; j < nbs.length; j++) {
          const nb = nbs[j]!;
          if (stamp[nb] === tick) continue;
          stamp[nb] = tick;
          const d = sqDist(query, vectors[nb]!);
          if (rd.length < width || d < rd[rd.length - 1]!) {
            insertSorted(rd, ri, d, nb, width);
            insertSorted(cd, ci, d, nb, Number.MAX_SAFE_INTEGER);
          }
        }
      }
      return { indices: ri.slice(0, k), dists: rd.slice(0, k) };
    },
  };
}

// Distance-weighted mean of the neighbours' 2D positions (weight 1/distance).
// An exact duplicate of a sampled track lands on it.
export function weightedPlace(indices: number[], sqDists: number[], embedding: ArrayLike<number>[]): [number, number] {
  let wx = 0;
  let wy = 0;
  let wsum = 0;
  for (let j = 0; j < indices.length; j++) {
    const d = Math.sqrt(sqDists[j]!);
    if (d < 1e-9) {
      const p = embedding[indices[j]!]!;
      return [p[0]!, p[1]!];
    }
    const w = 1 / d;
    const p = embedding[indices[j]!]!;
    wx += w * p[0]!;
    wy += w * p[1]!;
    wsum += w;
  }
  return wsum > 0 ? [wx / wsum, wy / wsum] : [0, 0];
}

// Place every query into the sample's 2D embedding. `onProgress` fires every
// `every` points so the CLI child can log and yield.
export async function placeAll(
  queries: ArrayLike<number>[],
  graph: SampleGraph,
  embedding: ArrayLike<number>[],
  { k = PLACE_K, ef = SEARCH_EF, every = 10_000, onProgress }: {
    k?: number;
    ef?: number;
    every?: number;
    onProgress?: (done: number) => void | Promise<void>;
  } = {},
): Promise<[number, number][]> {
  const searcher = makeSearcher(graph, ef);
  const out: [number, number][] = new Array(queries.length);
  for (let q = 0; q < queries.length; q++) {
    const { indices, dists } = searcher.search(queries[q]!, k);
    out[q] = weightedPlace(indices, dists, embedding);
    if (onProgress && (q + 1) % every === 0) await onProgress(q + 1);
  }
  return out;
}
