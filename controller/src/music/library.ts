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
  // adoptStoredDim:true makes the live controller honour whatever dim the tagger
  // actually probed and recorded, instead of trusting the name→dim guess. A
  // model whose name resolves to a different default than its real vector width
  // (e.g. a custom embedding model named like an OpenAI one) no longer makes the
  // controller wipe a populated index on boot (#319). resolveEmbeddingDim() is
  // only the fallback used when the DB has never been tagged. A deliberate model
  // swap is reconciled by the tagger's --reseed path, not here.
  await db.open({ embeddingDim: resolveEmbeddingDim(), adoptStoredDim: true });
  loaded = true;
}

// Close and re-open the backing DB. Called after a backup restore swaps the
// library.db file underneath us, so the live picker/tools see the restored
// tags without a controller restart.
export async function reload() {
  if (db.isOpen()) db.close();
  loaded = false;
  await load();
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
    // Phase 2/4 acoustic surface for the agent picker's Subsonic-fallback path
    // (slim() in llm/tools.ts). Library-sourced candidates already carry these
    // via slimTrack; this keeps Subsonic-sourced candidates symmetric.
    durationSec: t.durationSec,
    structure: t.structure,
    vocalRanges: t.vocalRanges, // [] = instrumental, null = not computed
    paceMean: paceMeanOf(t.pace),
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
      // Length (seconds) for the max-track-length cap (issue #447) — without it
      // a locally mood-tagged long mix would read as "unknown length" and slip
      // past the cap.
      durationSec: r.durationSec,
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
// Mean of the pace curve (0..1), or null when un-analysed. Shared by slimTrack
// and get() so the agent picker (Subsonic-fallback path) and the pool picker
// see the same scalar instead of one path computing it and the other missing it.
export function paceMeanOf(pace: Array<{ value: number }> | null | undefined): number | null {
  return pace && pace.length
    ? Math.round((pace.reduce((s, p) => s + p.value, 0) / pace.length) * 1000) / 1000
    : null;
}

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
    // Track length (seconds) so the max-track-length cap (issue #447) can act on
    // library-sourced candidates too — keeps them symmetric with Subsonic's
    // `duration`. null on rows without it; the cap treats null as "unknown".
    durationSec: r.durationSec,
    // Acoustic analysis — null on un-analysed tracks. Consumers (picker
    // re-rank, LLM candidate surface) treat null as "no signal".
    bpm: r.bpm,
    musicalKey: r.musicalKey,
    introMs: r.introMs,
    loudnessLufs: r.loudnessLufs,
    structure: r.structure,
    vocalRanges: r.vocalRanges,
    // Scalar mean pace (0..1) for the picker/LLM — the full curve stays in the
    // record for UI/future use. null when un-analysed.
    paceMean: paceMeanOf(r.pace),
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
//
// `seed` is normally a real track id, but the picker agent often passes a track
// *title* instead (e.g. "Be Mine"). When the id lookup finds no embedding, we
// resolve the string as a title via db.filter (LIKE over title/artist/album,
// scoped to tagged tracks — the same set that carries embeddings) and KNN from
// the first candidate that has one. Tracks with no embedding and no title match
// return []; callers fall back to other sources.
export function tracksLikeThis(seed: string, k: number): any[] {
  if (!loaded || !seed) return [];
  let hits = db.knnById(seed, k);
  if (hits.length === 0) {
    // Treat `seed` as a title — find the best embedded match and KNN from it.
    for (const row of db.filter({ q: seed, limit: 8 }).rows) {
      if (row.id === seed) continue;            // already tried as an id above
      hits = db.knnById(row.id, k);
      if (hits.length) break;
    }
  }
  const out: any[] = [];
  for (const hit of hits) {
    const t = db.getTrack(hit.id);
    if (t) out.push({ ...slimTrack(t), _similarity: hit.similarity });
  }
  return out;
}

// Audio KNN — finds tracks whose CLAP audio embedding (timbre / instrumentation
// / production / energy, derived from the waveform itself) is closest to the
// seed's. The sonic counterpart to tracksLikeThis: text catches "same scene /
// era / lyrical theme", audio catches "same sound". Same title-fallback shape
// (the agent often passes a title rather than an id). Returns [] when the seed
// has no audio vector — un-analysed library, or analysis backend without CLAP —
// so callers fall through to the other sources exactly like the text path.
export function tracksLikeThisAudio(seed: string, k: number): any[] {
  if (!loaded || !seed) return [];
  let hits = db.knnAudioById(seed, k);
  if (hits.length === 0) {
    // Treat `seed` as a title — find the best matching track that HAS an audio
    // vector and KNN from it.
    for (const row of db.filter({ q: seed, limit: 8 }).rows) {
      if (row.id === seed) continue;            // already tried as an id above
      hits = db.knnAudioById(row.id, k);
      if (hits.length) break;
    }
  }
  const out: any[] = [];
  for (const hit of hits) {
    const t = db.getTrack(hit.id);
    if (t) out.push({ ...slimTrack(t), _similarity: hit.similarity });
  }
  return out;
}

// The task-prefix mode the text-embedding index was built in — query embeds
// must match it (embeddings.embedQueryText). 'plain' when the DB isn't loaded
// or the meta predates mode tracking (legacy indexes were embedded bare).
export function embeddingIndexTextMode(): 'plain' | 'prefixed' {
  if (!loaded) return 'plain';
  return db.getEmbeddingMeta()?.textMode ?? 'plain';
}

// KNN against an externally-computed query vector. The lyric-search tool
// embeds a free-text query and calls this to find tracks semantically close
// to the query — including ones whose lyrics don't literally contain those
// words.
export function tracksByVector(vec: number[] | Float32Array, k: number): any[] {
  if (!loaded) return [];
  // Guard against an embedding model/provider drift: if the live query vector's
  // length no longer matches the dim the index was built at, knnByVector would
  // throw a raw "Dimension mismatch" from sqlite-vec (surfaced to the DJ agent
  // as a tool error). Degrade to an empty semantic result instead — the picker
  // falls through to its lexical/other sources — and log an actionable hint.
  const meta = db.getEmbeddingMeta();
  const got = (vec as { length?: number }).length;
  if (meta?.dim && got && meta.dim !== got) {
    console.warn(
      `[library] vector search skipped: query vector is ${got}-d but the index ` +
        `is ${meta.dim}-d (model: ${meta.model}). The embedding model changed — ` +
        `re-embed the library or pin settings.embedding back to the index's model.`,
    );
    return [];
  }
  const hits = db.knnByVector(vec, k);
  const out: any[] = [];
  for (const hit of hits) {
    const t = db.getTrack(hit.id);
    if (t) out.push({ ...slimTrack(t), _similarity: hit.similarity });
  }
  return out;
}

// Audio KNN against an externally-computed query vector — the sonic-journey
// counterpart to tracksByVector. Used by the picker when a journey waypoint is
// the audio anchor instead of the current track. Returns [] on an empty audio
// index, so the picker falls through to its other sources.
export function tracksByAudioVector(vec: number[] | Float32Array, k: number): any[] {
  if (!loaded) return [];
  const hits = db.knnByAudioVector(vec, k);
  const out: any[] = [];
  for (const hit of hits) {
    const t = db.getTrack(hit.id);
    if (t) out.push({ ...slimTrack(t), _similarity: hit.similarity });
  }
  return out;
}

export function stats() {
  if (!loaded) {
    return { total: 0, distinctArtists: 0, byMood: {}, byEnergy: {}, byGenre: {}, updatedAt: null, embeddingMeta: null };
  }
  const s = db.stats();
  return {
    total: s.total,
    distinctArtists: s.distinctArtists,
    byMood: s.byMood,
    byEnergy: s.byEnergy,
    byGenre: s.byGenre,
    bySource: s.bySource,
    withEmbedding: s.withEmbedding,
    withAudioEmbedding: s.withAudioEmbedding,
    updatedAt: s.updatedAt,
    // Provenance of the text-embedding index ({model, dim} or null) so the admin
    // UI can warn before a chat-provider switch silently changes the embedding
    // model out from under an existing index.
    embeddingMeta: db.getEmbeddingMeta(),
  };
}

// Re-export the filter contract — admin Library browse panel calls this.
// Implementation is in library-db.ts as a SQL query (replaces the old ~50-line
// in-memory loop).
export interface FilterOpts {
  moods?: string[];
  energy?: string | null;
  genre?: string | null;
  vocal?: 'instrumental' | 'vocal' | null;
  yearFrom?: number | null;
  yearTo?: number | null;
  q?: string | null;
  sort?: 'artist' | 'title' | 'taggedAt' | 'year' | 'bpm' | 'loudness' | 'pace';
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
  source?: string | null;
  taggedAt?: string | null;
  // Acoustic-analysis surface (null when the analyze pass hasn't touched the
  // track). `instrumental` is derived: null = not computed, true = analysed with
  // no vocal ranges, false = analysed with vocals.
  bpm?: number | null;
  musicalKey?: string | null;
  loudnessLufs?: number | null;
  paceMean?: number | null;
  instrumental?: boolean | null;
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
      source: r.source,
      taggedAt: r.taggedAt,
      bpm: r.bpm,
      musicalKey: r.musicalKey,
      loudnessLufs: r.loudnessLufs,
      paceMean: paceMeanOf(r.pace),
      instrumental: r.vocalRanges == null ? null : r.vocalRanges.length === 0,
    })),
  };
}
