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

// The centroid walk reads every embedded track, which takes seconds at 150k,
// all of it on the event loop (#1976). So it runs in slices that hand the loop
// back between them, and a request is answered from the last result while a
// changed library is re-read behind it. "Changed" is genreInputsToken(), which
// moves only on writes to what the walk reads (#1991), never on a play, an
// analysis result or an audio vector, so a library whose genres are untouched
// is never re-read however long the station plays. A changed one is re-read at
// most once per floor: a tagging run commits every batch, and without the
// floor every Show-editor open would start another full walk.
//
// The last result is only answered at once while its walk is younger than the
// max age (#1991). How often the editor is opened is not a clock: a week-old
// walk would otherwise be served to the first open after a week of tagging. So
// a changed library whose last walk is past the max age waits for the re-read,
// which costs that one request the walk's wall time and nobody else anything,
// and answers with the last result only if that walk fails.
const SLICE_MS = 25;
export const GENRE_SUGGEST_REFRESH_FLOOR_MS = 60_000;
export const GENRE_SUGGEST_MAX_AGE_MS = 10 * 60_000;

// walkedAt is the walk's start, when its token was read: the payload is the
// library as of then.
type Cached = { nonce: string; token: string; walkedAt: number; payload: GenreSuggest };
let cache: Cached | null = null;
let inflight: { nonce: string; promise: Promise<GenreSuggest> } | null = null;
let lastWalkAt = 0;

const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export async function genreSuggest(): Promise<GenreSuggest> {
  const nonce = db.getDbNonce();
  try {
    return await answer();
  } catch (err) {
    // A handle swapped while this request waited (reload, restore, reset)
    // abandons the walk it was waiting on. Wait once for the new handle's
    // rather than answer 500, which leaves the editor with no chips at all.
    if (db.getDbNonce() === nonce) throw err;
    return answer();
  }
}

async function answer(): Promise<GenreSuggest> {
  // A new handle (reset, restore) is a different library: never answer with
  // the previous one's genres, wait for this one's.
  if (!cache || cache.nonce !== db.getDbNonce()) return refresh();
  const last = cache;
  if (last.token === db.genreInputsToken()) return last.payload;
  const now = Date.now();
  const floorPassed = now - lastWalkAt >= GENRE_SUGGEST_REFRESH_FLOOR_MS;
  if (now - last.walkedAt >= GENRE_SUGGEST_MAX_AGE_MS) {
    // Too old to answer with: wait for the re-read, joining one in flight. A
    // walk that failed inside the floor is not retried, so the last result
    // stands until the floor passes.
    if (floorPassed || inflight?.nonce === last.nonce) {
      return refresh().catch((err) => {
        // Never the previous handle's result; genreSuggest() retries that.
        if (db.getDbNonce() !== last.nonce) throw err;
        return last.payload;
      });
    }
  } else if (floorPassed) {
    refresh().catch(() => {});
  }
  return last.payload;
}

// Resolves once no walk is in flight. For tests and the bench.
export async function genreSuggestIdle(): Promise<void> {
  while (inflight) await inflight.promise.catch(() => {});
}

// One walk per handle at a time. A walk still running on a handle that has
// since been swapped is not joined: it fails at its next slice. A failed walk
// logs once here, however many requests were waiting on it.
function refresh(): Promise<GenreSuggest> {
  const nonce = db.getDbNonce();
  if (inflight?.nonce === nonce) return inflight.promise;
  const promise = build(nonce).finally(() => {
    if (inflight?.promise === promise) inflight = null;
  });
  promise.catch((err) => console.warn(`[genre-suggest] refresh failed: ${(err as Error).message}`));
  inflight = { nonce, promise };
  return promise;
}

async function build(nonce: string): Promise<GenreSuggest> {
  // Read before the walk, so a write landing mid-walk leaves a token the next
  // call no longer matches. Every writer bumps after its write, never before.
  const token = db.genreInputsToken();
  const walkedAt = Date.now();
  lastWalkAt = walkedAt;
  const acc = db.newGenreVectorSums();
  // Yield first, so a request answered from the last result is not held for a
  // slice. Each slice closes its statement before the next yield, which leaves
  // the connection free for every other request in between.
  for (let after: number | null = db.GENRE_WALK_START; after !== null;) {
    await yieldLoop();
    // A handle swapped mid-walk would mix two libraries' rows.
    if (db.getDbNonce() !== nonce) throw new Error('library reopened during the genre walk');
    after = db.addGenreVectors(acc, after, SLICE_MS);
  }
  const payload = await assemble(db.centroidsOf(acc));
  if (db.getDbNonce() !== nonce) throw new Error('library reopened during the genre walk');
  cache = { nonce, token, walkedAt, payload };
  return payload;
}

async function assemble(centroids: db.GenreCentroid[]): Promise<GenreSuggest> {
  // Never TTL-held: the payload is cached under the token read before the walk,
  // and tallies from before that token would be served until the next write.
  const byGenre = library.stats({ fresh: true }).byGenre || {};
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
    // Every pair of genres: quadratic in the genre count, so it yields too.
    let sliceEnd = performance.now() + SLICE_MS;
    for (let i = 0; i < centroids.length; i++) {
      for (let j = i + 1; j < centroids.length; j++) {
        const sim = dot(units[i], units[j]);
        if (sim >= MIN_SIM) {
          offer(i, centroids[j].genre, sim);
          offer(j, centroids[i].genre, sim);
        }
      }
      if (performance.now() >= sliceEnd) {
        await yieldLoop();
        sliceEnd = performance.now() + SLICE_MS;
      }
    }
    for (let i = 0; i < centroids.length; i++) {
      related[centroids[i].genre] = neighbours[i]
        .map((s) => ({ value: s.value, songCount: countOf(s.value) }));
    }
  }

  return {
    genres,
    related,
    hasEmbeddings,
    computedAt: new Date().toISOString(),
  };
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
