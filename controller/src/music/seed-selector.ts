// Hybrid seed picker for the embedding-propagated tagger.
//
// Waterfall (each layer takes from the pool only what the earlier layers
// haven't already taken):
//   1. Already-tagged tracks (legacy v1 + prior runs) — free, count toward budget
//   2. Operator's explicit signals — starred + mood-named playlists + frequent
//      (capped at ~30% of seedCount so they don't crowd out coverage)
//   3. Stratified-by-(genre, decade) — guarantees rare-mood corners of the
//      library get at least one seed (capped at ~35%)
//   4. K-means over embedding space — fill the remainder with diverse picks
//
// Layers 1-3 are deterministic given the same library state; layer 4's
// k-means init and shuffle fall back to Math.random, so only the earlier
// layers are stable across runs. Tests exercise the deterministic layers.

import * as source from './source.js';
import * as db from './library-db.js';
import { SHOW_MOODS } from '../settings.js';
import { shuffle } from '../util/shuffle.js';

export interface SeedSelection {
  seeds: string[];                          // ids to LLM-tag
  alreadyTagged: string[];                  // ids already tagged (free seeds)
  layerCounts: Record<string, number>;
}

export interface SelectorOpts {
  seedCount: number;
  embeddingForId?: (id: string) => Float32Array | number[] | null;
  // When omitted we skip the k-means layer (useful in tests with no embeddings).
  // When set, every candidate id any layer surfaces is rejected if it's not in
  // this set. Callers pass this to honour `--limit`: layers 2 (operator
  // signals — starred/playlists/frequent) and 3 (stratified buckets) and 4
  // (k-means residual) all pull from the full library by default, so without
  // this gate a `--limit 10` run would still tag up to seedCount (default
  // 200) tracks from outside the in-scope window.
  untaggedPool?: Set<string>;
}

const MOOD_WORDS = new Set(SHOW_MOODS.map(s => s.toLowerCase()));

export async function selectSeeds(opts: SelectorOpts): Promise<SeedSelection> {
  const alreadyTagged = new Set(db.allTaggedIds());
  const layerCounts: Record<string, number> = {
    alreadyTagged: alreadyTagged.size,
    operatorStarred: 0,
    operatorPlaylists: 0,
    operatorFrequent: 0,
    stratified: 0,
    kmeans: 0,
  };

  // The target is `seedCount` NEW tracks to LLM-tag; the already-tagged pool
  // counts as ambient context (they'll show up as neighbours during
  // propagation), but they don't consume the seed budget.
  const chosen = new Set<string>();
  const budget = Math.max(0, opts.seedCount);

  const take = (label: string, id: string) => {
    if (chosen.size >= budget) return false;
    if (alreadyTagged.has(id)) return false;
    if (chosen.has(id)) return false;
    if (opts.untaggedPool && !opts.untaggedPool.has(id)) return false;
    chosen.add(id);
    layerCounts[label] = (layerCounts[label] ?? 0) + 1;
    return true;
  };

  // --- Layer 2: operator's explicit signals -------------------------------
  const operatorCap = Math.ceil(budget * 0.3);

  if (chosen.size < operatorCap) {
    try {
      const starred = await source.getStarred();
      for (const s of starred) {
        if (chosen.size >= operatorCap) break;
        if (s?.id) take('operatorStarred', s.id);
      }
    } catch { /* ignore */ }
  }

  if (chosen.size < operatorCap) {
    try {
      const playlists = await source.getPlaylists();
      const moodPlaylists = (Array.isArray(playlists) ? playlists : []).filter(
        (p: any) => {
          const name = String(p?.name || '').toLowerCase();
          for (const mood of MOOD_WORDS) {
            if (name.includes(mood)) return true;
          }
          return false;
        },
      );
      for (const pl of moodPlaylists.slice(0, 6)) {
        if (chosen.size >= operatorCap) break;
        try {
          const songs = await source.getPlaylist(pl.id);
          for (const s of songs) {
            if (chosen.size >= operatorCap) break;
            if (s?.id) take('operatorPlaylists', s.id);
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  if (chosen.size < operatorCap) {
    try {
      const freqAlbums = await source.getFrequentAlbums({ size: 12 });
      for (const album of freqAlbums.slice(0, 8)) {
        if (chosen.size >= operatorCap) break;
        try {
          const songs = await source.getAlbum(album.id);
          for (const s of songs.slice(0, 3)) {
            if (chosen.size >= operatorCap) break;
            if (s?.id) take('operatorFrequent', s.id);
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  // --- Layer 3: stratified by (genre, decade) ------------------------------
  // Allocate up to budget*0.35 — give every (genre, decade) bucket at least
  // one representative so rare-mood corners can't be invisible to seeds.
  const stratCap = Math.ceil(budget * 0.35) + chosen.size;
  const buckets = db.trackIdsByGenreDecade
    ? db.trackIdsByGenreDecade()
    : new Map<string, string[]>();
  // Round-robin: pick one id per bucket per round, repeat until cap or buckets empty
  const bucketKeys = [...buckets.keys()].sort();
  let added = true;
  let round = 0;
  while (added && chosen.size < stratCap) {
    added = false;
    for (const key of bucketKeys) {
      if (chosen.size >= stratCap) break;
      const ids = buckets.get(key) || [];
      const pick = ids[round];
      if (!pick) continue;
      if (take('stratified', pick)) added = true;
    }
    round += 1;
  }

  // --- Layer 4: k-means over embeddings -----------------------------------
  // Without an embedding lookup, skip k-means and top up randomly from
  // unembedded ids. This keeps the function useful in early-bootstrap phases
  // when phase 1 hasn't run yet, AND keeps tests not-needing-real-embeddings.
  if (chosen.size < budget) {
    const remaining = budget - chosen.size;
    // When untaggedPool is set (i.e. honouring --limit), only iterate that
    // smaller window — saves building a 6k-id array just to filter it down.
    const basePool = opts.untaggedPool
      ? [...opts.untaggedPool]
      : db.untaggedIds();
    const candidatePool = basePool
      .filter(id => !chosen.has(id) && !alreadyTagged.has(id));
    if (opts.embeddingForId) {
      const picks = kmeansSeedPicks(candidatePool, opts.embeddingForId, remaining);
      for (const id of picks) take('kmeans', id);
    } else {
      // No embeddings — shuffle and take. Deterministic seed for testability
      // is left as an implementation-time detail; default is Math.random.
      const shuffled = shuffle(candidatePool).slice(0, remaining);
      for (const id of shuffled) take('kmeans', id);
    }
  }

  return {
    seeds: [...chosen],
    alreadyTagged: [...alreadyTagged],
    layerCounts,
  };
}

// Lightweight k-means in pure JS — fine for our cluster counts (≤500) and
// vector dims (≤1536). Iterates a fixed small number of times for speed;
// quality is "good enough for picking diverse seeds," not "optimal."
function kmeansSeedPicks(
  ids: string[],
  vecOf: (id: string) => Float32Array | number[] | null,
  k: number,
): string[] {
  if (ids.length === 0 || k <= 0) return [];
  const vectors: { id: string; v: number[] }[] = [];
  for (const id of ids) {
    const v = vecOf(id);
    if (v && v.length > 0) vectors.push({ id, v: Array.from(v) });
  }
  if (vectors.length === 0) return [];
  if (vectors.length <= k) return vectors.map(x => x.id);

  // Init centroids with k-means++ — pick first at random, then each next
  // proportional to squared-distance from the closest existing centroid.
  const dim = vectors[0].v.length;
  const centroids: number[][] = [vectors[Math.floor(Math.random() * vectors.length)].v.slice()];
  while (centroids.length < k) {
    const dists = vectors.map(x => minSqDist(x.v, centroids));
    const total = dists.reduce((a, b) => a + b, 0);
    if (total === 0) break;
    let pick = Math.random() * total;
    let idx = 0;
    for (; idx < dists.length; idx++) {
      pick -= dists[idx];
      if (pick <= 0) break;
    }
    centroids.push(vectors[Math.min(idx, vectors.length - 1)].v.slice());
  }

  // Lloyd iterations
  const ITER = 8;
  const assignments = new Array(vectors.length).fill(0);
  for (let it = 0; it < ITER; it++) {
    // assign
    for (let i = 0; i < vectors.length; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = sqDist(vectors[i].v, centroids[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      assignments[i] = best;
    }
    // update
    const sums = Array.from({ length: centroids.length }, () => new Array(dim).fill(0));
    const counts = new Array(centroids.length).fill(0);
    for (let i = 0; i < vectors.length; i++) {
      const a = assignments[i];
      counts[a] += 1;
      for (let d = 0; d < dim; d++) sums[a][d] += vectors[i].v[d];
    }
    for (let c = 0; c < centroids.length; c++) {
      if (counts[c] === 0) continue;
      for (let d = 0; d < dim; d++) centroids[c][d] = sums[c][d] / counts[c];
    }
  }

  // For each cluster, pick the vector closest to its centroid.
  const bestForCluster = new Map<number, { id: string; d: number }>();
  for (let i = 0; i < vectors.length; i++) {
    const a = assignments[i];
    const d = sqDist(vectors[i].v, centroids[a]);
    const cur = bestForCluster.get(a);
    if (!cur || d < cur.d) bestForCluster.set(a, { id: vectors[i].id, d });
  }
  return [...bestForCluster.values()].map(x => x.id);
}

function sqDist(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

function minSqDist(v: number[], centroids: number[][]): number {
  let best = Infinity;
  for (const c of centroids) {
    const d = sqDist(v, c);
    if (d < best) best = d;
  }
  return best;
}
