// Genre suggestions use cosine similarity between mean text embeddings.
// Without embeddings, return genre counts with an empty related list.

import * as db from './library-db.js';
import * as library from './library.js';

export interface GenreItem {
  value: string;
  songCount: number;
}

export interface GenreSuggest {
  genres: GenreItem[]; // every known genre, descending by track count
  related: Record<string, GenreItem[]>; // genre → nearest genres by embedding
  hasEmbeddings: boolean;
  computedAt: string;
}

const NEIGHBOURS = 8;
// Cosine below this isn't a meaningful neighbour.
const MIN_SIM = 0.2;
const MIN_FOR_EMBEDDINGS = 3;

let cache: { key: string; payload: GenreSuggest } | null = null;

export function buildGenreSuggest(): GenreSuggest {
  const stats = library.stats();
  const byGenre = stats.byGenre || {};
  const key = `${stats.updatedAt ?? ''}:${db.vectorCount()}`;
  if (cache && cache.key === key) return cache.payload;

  const centroids = db.genreCentroids();
  const centroidCount = new Map(centroids.map((c) => [c.genre, c.count]));
  const countOf = (g: string) => byGenre[g] ?? centroidCount.get(g) ?? 0;

  // Union of the tagged-index genres and any genre with a centroid.
  const names = new Set<string>([...Object.keys(byGenre), ...centroids.map((c) => c.genre)]);
  const genres: GenreItem[] = [...names]
    .map((value) => ({ value, songCount: countOf(value) }))
    .sort((a, b) => b.songCount - a.songCount);

  const related: Record<string, GenreItem[]> = {};
  const hasEmbeddings = centroids.length >= MIN_FOR_EMBEDDINGS;

  if (hasEmbeddings) {
    // Unit-normalise each centroid so a dot product is the cosine similarity.
    const units = centroids.map((c) => normalise(c.centroid));
    const neighbours: Array<Array<{ value: string; sim: number }>> = centroids.map(() => []);
    const offer = (index: number, value: string, sim: number) => {
      const sims = neighbours[index];
      const higher = sims.findIndex(other => sim > other.sim);
      const position = higher < 0 ? sims.length : higher;
      if (position >= NEIGHBOURS) return;
      // Equal scores retain centroid order. Keep at most NEIGHBOURS per genre.
      sims.splice(position, 0, { value, sim });
      if (sims.length > NEIGHBOURS) sims.pop();
    };
    for (let i = 0; i < centroids.length; i++) {
      for (let j = i + 1; j < centroids.length; j++) {
        const sim = dot(units[i], units[j]);
        if (sim >= MIN_SIM) {
          offer(i, centroids[j].genre, sim);
          offer(j, centroids[i].genre, sim);
        }
      }
    }
    for (let i = 0; i < centroids.length; i++) {
      related[centroids[i].genre] = neighbours[i]
        .map((s) => ({ value: s.value, songCount: countOf(s.value) }));
    }
  }

  const payload: GenreSuggest = {
    genres,
    related,
    hasEmbeddings,
    computedAt: new Date().toISOString(),
  };
  cache = { key, payload };
  return payload;
}

function normalise(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
