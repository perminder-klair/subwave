// Hybrid seed picker for the embedding-propagated tagger. Waterfall, each layer
// taking only what the earlier ones left:
//   1. already-tagged tracks (free, outside the budget)
//   2. operator signals - starred, mood-named playlists, frequent (cap ~30%)
//   3. stratified by (genre, decade), so rare corners get a seed (cap ~35%)
//   4. k-means over embedding space for the remainder
// Layers 1-3 are deterministic; layer 4 uses Math.random.

import * as subsonic from './source.js';
import * as db from './library-db.js';
import { moodVocab } from '../settings.js';
import { shuffle } from '../util/shuffle.js';

export interface SeedSelection {
  seeds: string[];                          // ids to LLM-tag
  alreadyTagged: string[];                  // ids already tagged (free seeds)
  layerCounts: Record<string, number>;
}

export interface SelectorOpts {
  seedCount: number;
  embeddingForId?: (id: string) => Float32Array | number[] | null;
  // Every layer pulls from the full library by default, so this set is how
  // `--limit` is honoured: an id outside it is rejected whichever layer found it.
  untaggedPool?: Set<string>;
}

// Read per call, not at module load, so operator-added moods still match.
function moodWords(): Set<string> {
  return new Set(moodVocab().map(s => s.toLowerCase()));
}

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

  // Budget is seedCount NEW tracks; already-tagged ones don't consume it.
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

  // Layer 2: operator's explicit signals.
  const operatorCap = Math.ceil(budget * 0.3);

  if (chosen.size < operatorCap) {
    try {
      const starred = await subsonic.getStarred();
      for (const s of starred) {
        if (chosen.size >= operatorCap) break;
        if (s?.id) take('operatorStarred', s.id);
      }
    } catch { /* ignore */ }
  }

  if (chosen.size < operatorCap) {
    try {
      const playlists = await subsonic.getPlaylists();
      const moodTokens = moodWords();
      const moodPlaylists = (Array.isArray(playlists) ? playlists : []).filter(
        (p: any) => {
          const name = String(p?.name || '').toLowerCase();
          for (const mood of moodTokens) {
            if (name.includes(mood)) return true;
          }
          return false;
        },
      );
      for (const pl of moodPlaylists.slice(0, 6)) {
        if (chosen.size >= operatorCap) break;
        try {
          const songs = await subsonic.getPlaylist(pl.id);
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
      const freqAlbums = await subsonic.getFrequentAlbums({ size: 12 });
      for (const album of freqAlbums.slice(0, 8)) {
        if (chosen.size >= operatorCap) break;
        try {
          const songs = await subsonic.getAlbum(album.id);
          for (const s of songs.slice(0, 3)) {
            if (chosen.size >= operatorCap) break;
            if (s?.id) take('operatorFrequent', s.id);
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  // Layer 3: stratified by (genre, decade), so every bucket gets at least one
  // representative and rare corners can't be invisible to seeds.
  const stratCap = Math.ceil(budget * 0.35) + chosen.size;
  const buckets = db.trackIdsByGenreDecade
    ? db.trackIdsByGenreDecade()
    : new Map<string, string[]>();
  // Round-robin: one id per bucket per round, until the cap or buckets empty.
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

  // Layer 4: k-means over embeddings. Without an embedding lookup, top up
  // randomly instead, so this still works before phase 1 has run.
  if (chosen.size < budget) {
    const remaining = budget - chosen.size;
    // With untaggedPool set, iterate that smaller window rather than the library.
    const basePool = opts.untaggedPool
      ? [...opts.untaggedPool]
      : db.untaggedIds();
    const candidatePool = basePool
      .filter(id => !chosen.has(id) && !alreadyTagged.has(id));
    if (opts.embeddingForId) {
      const picks = kmeansSeedPicks(candidatePool, opts.embeddingForId, remaining);
      for (const id of picks) take('kmeans', id);
      // k-means can return fewer than asked (un-embedded candidates drop out,
      // cluster count is capped), so top up randomly to spend the budget.
      if (chosen.size < budget) {
        const rest = shuffle(candidatePool.filter(id => !chosen.has(id)))
          .slice(0, budget - chosen.size);
        for (const id of rest) take('kmeans-topup', id);
      }
    } else {
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

// Lightweight k-means, bounded to stay affordable on real libraries: the pool is
// sampled to KMEANS_POOL_CAP and k capped at KMEANS_MAX_K, keeping this
// O(POOL_CAP * MAX_K * dim). Good enough for diverse seeds, not optimal.
const KMEANS_POOL_CAP = 4000;
const KMEANS_MAX_K = 150;

function kmeansSeedPicks(
  ids: string[],
  vecOf: (id: string) => Float32Array | number[] | null,
  k: number,
): string[] {
  if (ids.length === 0 || k <= 0) return [];
  const kk = Math.min(k, KMEANS_MAX_K);
  const sampledIds = ids.length > KMEANS_POOL_CAP
    ? shuffle([...ids]).slice(0, KMEANS_POOL_CAP)
    : ids;
  const vectors: { id: string; v: number[] }[] = [];
  for (const id of sampledIds) {
    const v = vecOf(id);
    if (v && v.length > 0) vectors.push({ id, v: Array.from(v) });
  }
  if (vectors.length === 0) return [];
  if (vectors.length <= kk) return vectors.map(x => x.id);

  // k-means++ init, incremental: each point keeps its distance to the nearest
  // centroid, refreshed against only the newest one per round. O(n*k*dim); a
  // from-scratch recompute is O(n*k^2*dim) and too slow on real libraries.
  const dim = vectors[0].v.length;
  const centroids: number[][] = [vectors[Math.floor(Math.random() * vectors.length)].v.slice()];
  const nearest = vectors.map(x => sqDist(x.v, centroids[0]));
  while (centroids.length < kk) {
    const total = nearest.reduce((a, b) => a + b, 0);
    if (total === 0) break;
    let pick = Math.random() * total;
    let idx = 0;
    for (; idx < nearest.length; idx++) {
      pick -= nearest[idx];
      if (pick <= 0) break;
    }
    const c = vectors[Math.min(idx, vectors.length - 1)].v.slice();
    centroids.push(c);
    for (let i = 0; i < vectors.length; i++) {
      const d = sqDist(vectors[i].v, c);
      if (d < nearest[i]) nearest[i] = d;
    }
  }

  // Lloyd iterations.
  const ITER = 8;
  const assignments = new Array(vectors.length).fill(0);
  for (let it = 0; it < ITER; it++) {
    for (let i = 0; i < vectors.length; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = sqDist(vectors[i].v, centroids[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      assignments[i] = best;
    }
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

