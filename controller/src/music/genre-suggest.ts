// Genre suggestions for the show editor's "genre lean" field.
//
// The embedding data's real value at a single-value field is *adjacency*: given
// a genre, what else sounds like it. We compute that as genre→genre cosine
// similarity over each genre's mean text-embedding (the centroid; see
// library-db.genreCentroids) and return the nearest neighbours per genre.
// Backs GET /library/genres/related → the related-genre chips
// (web/components/admin/GenreSuggest.tsx).
//
// Also returns the full genre list (by track count) so the picker can offer
// popular quick-picks when the field is empty and substring matches while the
// operator types — both useful even with no embeddings, where `related` is
// simply empty and `hasEmbeddings` is false.

import * as db from './library-db-core.js';
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

// Nearest neighbours kept per genre. Eight is enough to surface the obvious
// cousins without turning into a wall of chips.
const NEIGHBOURS = 8;
// Cosine below this isn't a meaningful neighbour — drop it rather than pad the
// list with unrelated genres.
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

  // Full genre list — union of the tagged-index genres and any genre that has a
  // centroid — sorted by how much music sits under it.
  const names = new Set<string>([...Object.keys(byGenre), ...centroids.map((c) => c.genre)]);
  const genres: GenreItem[] = [...names]
    .map((value) => ({ value, songCount: countOf(value) }))
    .sort((a, b) => b.songCount - a.songCount);

  const related: Record<string, GenreItem[]> = {};
  const hasEmbeddings = centroids.length >= MIN_FOR_EMBEDDINGS;

  if (hasEmbeddings) {
    // Unit-normalise each centroid so a dot product is the cosine similarity.
    const units = centroids.map((c) => normalise(c.centroid));
    for (let i = 0; i < centroids.length; i++) {
      const sims: Array<{ value: string; sim: number }> = [];
      for (let j = 0; j < centroids.length; j++) {
        if (j === i) continue;
        const sim = dot(units[i], units[j]);
        if (sim >= MIN_SIM) sims.push({ value: centroids[j].genre, sim });
      }
      sims.sort((a, b) => b.sim - a.sim);
      related[centroids[i].genre] = sims
        .slice(0, NEIGHBOURS)
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
