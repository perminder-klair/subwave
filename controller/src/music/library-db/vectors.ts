// Vector search over the sqlite-vec tables — text embeddings, audio (CLAP)
// embeddings, and the 2-D sound-map projection derived from them.

import { requireDb } from './handle.js';

export interface KnnHit {
  id: string;
  similarity: number; // 1 - cosine_distance, so 1.0 = identical, 0 = orthogonal
}

export interface KnnOpts {
  // Excluded INSIDE the walk, so the result is the k nearest NON-excluded
  // neighbours rather than a post-filtered k that can thin toward empty.
  excludeIds?: ReadonlySet<string> | null;
}

export function knnById(id: string, k: number, opts: KnnOpts = {}): KnnHit[] {
  const d = requireDb();
  const row = d.prepare(`SELECT embedding FROM track_vectors WHERE id = ?`).get(id) as
    | { embedding: Buffer }
    | undefined;
  if (!row) return [];
  return knnByBuffer(row.embedding, k, id, 'track_vectors', opts.excludeIds);
}

export function knnByVector(vec: number[] | Float32Array, k: number, opts: KnnOpts = {}): KnnHit[] {
  const buf = Buffer.from(
    vec instanceof Float32Array ? vec.buffer : new Float32Array(vec).buffer,
  );
  return knnByBuffer(buf, k, null, 'track_vectors', opts.excludeIds);
}

// Audio (CLAP) KNN. [] when the seed has no audio vector.
export function knnAudioById(id: string, k: number, opts: KnnOpts = {}): KnnHit[] {
  const d = requireDb();
  const row = d.prepare(`SELECT embedding FROM track_audio_vectors WHERE id = ?`).get(id) as
    | { embedding: Buffer }
    | undefined;
  if (!row) return [];
  return knnByBuffer(row.embedding, k, id, 'track_audio_vectors', opts.excludeIds);
}

export function knnByAudioVector(vec: number[] | Float32Array, k: number, opts: KnnOpts = {}): KnnHit[] {
  const buf = Buffer.from(
    vec instanceof Float32Array ? vec.buffer : new Float32Array(vec).buffer,
  );
  return knnByBuffer(buf, k, null, 'track_audio_vectors', opts.excludeIds);
}

// How far past k the first pass widens for the exclusion set, as a multiple of k.
// Sizing by the raw set size over-reads; the exact pass below covers the rest.
const EXCLUDE_WIDEN_K_FACTOR = 3;

// `table` is a hardcoded vec0 table name, never user input, so interpolating it
// is safe; the MATCH buffer is still bound.
function knnByBuffer(
  buf: Buffer,
  k: number,
  excludeId: string | null,
  table: 'track_vectors' | 'track_audio_vectors',
  excludeIds?: ReadonlySet<string> | null,
): KnnHit[] {
  const base = excludeId ? k + 1 : k;
  const want = excludeIds ? excludeIds.size : 0;
  const stmt = requireDb().prepare(
    `SELECT id, distance FROM ${table} WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
  );
  const run = (limit: number): KnnHit[] => {
    const rows = stmt.all(buf, limit) as Array<{ id: string; distance: number }>;
    const hits: KnnHit[] = [];
    for (const r of rows) {
      if (excludeId && r.id === excludeId) continue;
      if (excludeIds && excludeIds.has(r.id)) continue;
      hits.push({ id: r.id, similarity: 1 - r.distance });
      if (hits.length === k) break;
    }
    return hits;
  };

  const widened = Math.min(want, k * EXCLUDE_WIDEN_K_FACTOR);
  const hits = run(base + widened);
  // Short of k means the overlap is larger than assumed; pay for full widening.
  if (hits.length < k && widened < want) return run(base + want);
  return hits;
}

// Cheap gate: does this track have a CLAP vector, without decoding the blob.
export function hasAudioVector(id: string): boolean {
  return !!requireDb()
    .prepare(`SELECT 1 FROM track_audio_vectors WHERE id = ? LIMIT 1`)
    .get(id);
}

export function vectorCount(): number {
  return (requireDb().prepare('SELECT COUNT(*) AS n FROM track_vectors').get() as {
    n: number;
  }).n;
}

// A copy, not a view into the DB buffer. vec0 stores a packed float32 blob.
export function getVector(id: string): Float32Array | null {
  const row = requireDb()
    .prepare(`SELECT embedding FROM track_vectors WHERE id = ?`)
    .get(id) as { embedding: Buffer } | undefined;
  if (!row) return null;
  const b = row.embedding;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)).slice();
}

// A copy, not a view into the DB buffer.
export function getAudioVector(id: string): Float32Array | null {
  const row = requireDb()
    .prepare(`SELECT embedding FROM track_audio_vectors WHERE id = ?`)
    .get(id) as { embedding: Buffer } | undefined;
  if (!row) return null;
  const b = row.embedding;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)).slice();
}

export function audioVectorCount(): number {
  return (requireDb().prepare('SELECT COUNT(*) AS n FROM track_audio_vectors').get() as {
    n: number;
  }).n;
}

// Every stored CLAP vector in one pass (the sound-map projection's input). Copies,
// safe to hold across further DB work (~18MB at 9k x 512).
export function allAudioVectors(): { id: string; vector: Float32Array }[] {
  const rows = requireDb()
    .prepare('SELECT id, embedding FROM track_audio_vectors')
    .all() as { id: string; embedding: Buffer }[];
  return rows.map((r) => ({
    id: r.id,
    vector: new Float32Array(
      r.embedding.buffer,
      r.embedding.byteOffset,
      Math.floor(r.embedding.byteLength / 4),
    ).slice(),
  }));
}

// Sound-map projection coordinates (music/map-projection.ts).

export function setMapCoordsBulk(coords: { id: string; x: number; y: number }[]): void {
  const d = requireDb();
  const clear = d.prepare('UPDATE tracks SET map_x = NULL, map_y = NULL WHERE map_x IS NOT NULL');
  const stmt = d.prepare('UPDATE tracks SET map_x = ?, map_y = ? WHERE id = ?');
  // Clear-then-set in one transaction, so a deleted vector leaves no stale point.
  const tx = d.transaction((list: { id: string; x: number; y: number }[]) => {
    clear.run();
    for (const c of list) stmt.run(c.x, c.y, c.id);
  });
  tx(coords);
}

export function mapCoordsCount(): number {
  return (requireDb().prepare('SELECT COUNT(*) AS n FROM tracks WHERE map_x IS NOT NULL').get() as {
    n: number;
  }).n;
}

export function getMapProjectionMeta(): { algo: string; space: string; count: number; setAt: string } | null {
  const row = requireDb()
    .prepare('SELECT algo, space, count, set_at FROM map_projection_meta WHERE pk = 1')
    .get() as { algo: string; space: string; count: number; set_at: string } | undefined;
  return row ? { algo: row.algo, space: row.space, count: row.count, setAt: row.set_at } : null;
}

export function setMapProjectionMeta(algo: string, space: string, count: number): void {
  requireDb()
    .prepare(
      `INSERT INTO map_projection_meta (pk, algo, space, count, set_at) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(pk) DO UPDATE SET algo = excluded.algo, space = excluded.space,
         count = excluded.count, set_at = excluded.set_at`,
    )
    .run(algo, space, count, new Date().toISOString());
}


