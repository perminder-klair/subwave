// Library facade — thin wrapper over library-db.ts.
//
// Public surface preserved for back-compat with the picker, scheduler, llm
// tools, request route, debug route, etc. Only the backing store moves from
// the in-memory JSON map to SQLite + sqlite-vec (state/library.db). Auto-
// migrates any existing state/moods.json on first open.
//
// The mood-widening logic (MOOD_NEIGHBOURS) lives here, on top of the raw
// library-db.songsByMood query — the DB layer is intentionally vocabulary-
// agnostic.

import * as db from './library-db.js';
import { resolveEmbeddingDim } from './embeddings.js';

let loaded = false;

export async function load() {
  if (loaded) return;
  await db.open({ embeddingDim: resolveEmbeddingDim() });
  loaded = true;
}

// SQLite WAL writes are durable per statement — no batched save needed. Kept
// as a no-op so existing callers that call save() at intervals still work.
export async function save() {
  // no-op
}

export function get(songId: string): any {
  if (!loaded) return null;
  const t = db.getTrack(songId);
  if (!t) return null;
  return {
    title: t.title,
    artist: t.artist,
    album: t.album,
    year: t.year,
    genre: t.genre,
    moods: t.moods,
    energy: t.energy,
    source: t.source,
    confidence: t.confidence,
    taggerVersion: t.taggerVersion,
    promptHash: t.promptHash,
    model: t.model,
    taggedAt: t.taggedAt,
    bpm: t.bpm,
    musicalKey: t.musicalKey,
    introMs: t.introMs,
  };
}

// Back-compat shim. Old callers pass {title, artist, album, year, genre,
// moods, energy} in one shot. The DB has split write surfaces (metadata +
// tags + enrichment) but for a single-track legacy write we collapse them.
export function set(songId: string, data: any) {
  db.upsertTrackMeta(songId, {
    title: data.title,
    artist: data.artist,
    album: data.album,
    year: data.year,
    genre: data.genre,
    duration: data.duration ?? null,
  });
  if (Array.isArray(data.moods) || data.energy !== undefined) {
    db.upsertTrackTags(songId, {
      moods: Array.isArray(data.moods) ? data.moods : [],
      energy: data.energy ?? null,
      source: (data.source as db.TagSource) ?? 'llm',
      confidence: data.confidence ?? null,
      promptHash: data.promptHash ?? null,
      model: data.model ?? null,
    });
  }
}

export function has(songId: string): boolean {
  return loaded ? db.hasTags(songId) : false;
}

export function allTaggedIds(): string[] {
  return loaded ? db.allTaggedIds() : [];
}

// Musically-adjacent moods. The LLM tagger is told to tag by how a track
// FEELS, so it rarely assigns time-of-day moods — `morning` ends up with 0
// tracks, `evening` with 1 — which leaves the picker's mood source dark for
// the ~7 morning hours a day that `dominantMood` is `morning`. When a
// requested mood is sparsely tagged, songsByMood() widens the match to these
// neighbours. The picker still hands the full candidate set to the LLM,
// which curates against the real context; widening only deepens the pool.
const MOOD_NEIGHBOURS: Record<string, string[]> = {
  morning:     ['calm', 'focus', 'sunny'],
  evening:     ['calm', 'reflective', 'romantic'],
  night:       ['reflective', 'calm', 'romantic'],
  driving:     ['energetic', 'focus'],
  focus:       ['calm', 'reflective'],
  energetic:   ['workout', 'celebratory'],
  reflective:  ['calm', 'night'],
  celebratory: ['festival', 'energetic'],
  romantic:    ['calm', 'reflective'],
  festival:    ['celebratory', 'cultural', 'spiritual'],
  sunny:       ['energetic', 'calm'],
  rainy:       ['calm', 'reflective'],
};

// Below this many exact matches, songsByMood() widens to adjacent moods.
// 12 leaves comfortable margin above the picker's CAP_MOOD_LIBRARY (10).
const MOOD_MIN_EXACT = 12;

export function songsByMood(mood: string | null | undefined): any[] {
  if (!mood || !loaded) return [];
  const flatten = (rows: db.TrackRecord[]) =>
    rows.map(r => ({
      id: r.id,
      title: r.title,
      artist: r.artist,
      album: r.album,
      year: r.year,
      genre: r.genre,
      moods: r.moods,
      energy: r.energy,
    }));

  const exact = flatten(db.songsByMood(mood));
  if (exact.length >= MOOD_MIN_EXACT) return exact;

  const seen = new Set(exact.map(s => s.id));
  const widened = [...exact];
  for (const neighbour of MOOD_NEIGHBOURS[mood] || []) {
    for (const row of flatten(db.songsByMood(neighbour))) {
      if (seen.has(row.id)) continue;
      widened.push(row);
      seen.add(row.id);
    }
  }
  return widened;
}

// Slim shape the picker + LLM tools expect — title/artist/album/year/genre
// plus the two tagger axes. Matches what songsByMood returns above; pulled
// out so the new embedding-similar helpers can share the same projection.
function slimTrack(r: db.TrackRecord) {
  return {
    id: r.id,
    title: r.title,
    artist: r.artist,
    album: r.album,
    year: r.year,
    genre: r.genre,
    moods: r.moods,
    energy: r.energy,
    // Acoustic analysis — null on un-analysed tracks. Consumers (picker
    // re-rank, LLM candidate surface) treat null as "no signal".
    bpm: r.bpm,
    musicalKey: r.musicalKey,
    introMs: r.introMs,
  };
}

export function songsByEnergy(energy: string | null | undefined): any[] {
  if (!energy || !loaded) return [];
  if (energy !== 'low' && energy !== 'medium' && energy !== 'high') return [];
  return db.songsByEnergy(energy).map(slimTrack);
}

// KNN over the embedding space — finds tracks whose metadata + lyrics +
// (optional) Last.fm tags embed close to the seed track's. Used by the picker's
// embedding-similar pool source and the agent's tracksLikeThis tool.
// Tracks without an embedding return []; callers fall back to other sources.
export function tracksLikeThis(songId: string, k: number): any[] {
  if (!loaded || !songId) return [];
  const hits = db.knnById(songId, k);
  const out: any[] = [];
  for (const hit of hits) {
    const t = db.getTrack(hit.id);
    if (t) out.push({ ...slimTrack(t), _similarity: hit.similarity });
  }
  return out;
}

// KNN against an externally-computed query vector. The lyric-search tool
// embeds a free-text query and calls this to find tracks semantically close
// to the query — including ones whose lyrics don't literally contain those
// words.
export function tracksByVector(vec: number[] | Float32Array, k: number): any[] {
  if (!loaded) return [];
  const hits = db.knnByVector(vec, k);
  const out: any[] = [];
  for (const hit of hits) {
    const t = db.getTrack(hit.id);
    if (t) out.push({ ...slimTrack(t), _similarity: hit.similarity });
  }
  return out;
}

export function stats() {
  if (!loaded) {
    return { total: 0, byMood: {}, byEnergy: {}, byGenre: {}, updatedAt: null };
  }
  const s = db.stats();
  return {
    total: s.total,
    byMood: s.byMood,
    byEnergy: s.byEnergy,
    byGenre: s.byGenre,
    bySource: s.bySource,
    withEmbedding: s.withEmbedding,
    updatedAt: s.updatedAt,
  };
}

// Re-export the filter contract — admin Library browse panel calls this.
// Implementation is in library-db.ts as a SQL query (replaces the old ~50-line
// in-memory loop).
export interface FilterOpts {
  moods?: string[];
  energy?: string | null;
  genre?: string | null;
  yearFrom?: number | null;
  yearTo?: number | null;
  q?: string | null;
  sort?: 'artist' | 'title' | 'taggedAt' | 'year';
  limit?: number;
  offset?: number;
}

export interface FilteredRow {
  id: string;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  year?: number | string | null;
  genre?: string | null;
  duration?: number | null;
  moods: string[];
  energy: string | null;
  taggedAt?: string | null;
}

export function filter(opts: FilterOpts = {}): { total: number; rows: FilteredRow[] } {
  if (!loaded) return { total: 0, rows: [] };
  const res = db.filter(opts);
  return {
    total: res.total,
    rows: res.rows.map(r => ({
      id: r.id,
      title: r.title,
      artist: r.artist,
      album: r.album,
      year: r.year,
      genre: r.genre,
      duration: r.durationSec,
      moods: r.moods,
      energy: r.energy,
      taggedAt: r.taggedAt,
    })),
  };
}
