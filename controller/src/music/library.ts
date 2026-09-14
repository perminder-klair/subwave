// Library facade over library-db.ts (SQLite + sqlite-vec, state/library.db).
// The mood-widening vocabulary lives here; the DB layer stays vocabulary-free.

import * as db from './library-db.js';
import * as blocklist from './blocklist.js';
import * as sceneVocab from './scene-vocab.js';
import { resolveEmbeddingDim } from './embeddings.js';
import { openingKeyFrom, endingKeyFrom } from './mix.js';
import { DEEP_CUT_DAYS, EMPTY_AIRED_INDEX, type AiredIndex } from './airing.js';
import { trackKey, type CandidateLike } from './recency.js';
import { isInstrumental } from './lyric-vocal.js';

let loaded = false;

export async function load() {
  if (loaded) return;
  // adoptStoredDim honours the dim the tagger probed, so a model whose name
  // resolves to a different default than its real vector width can't wipe a
  // populated index on boot (#319). resolveEmbeddingDim() is only the fallback
  // for a never-tagged DB; a deliberate model swap goes via --reseed.
  await db.open({ embeddingDim: resolveEmbeddingDim(), adoptStoredDim: true });
  loaded = true;
}

// Re-open after a backup restore swaps library.db underneath us.
export async function reload() {
  if (db.isOpen()) db.close();
  loaded = false;
  invalidateAiredIndex();
  await load();
}

// Admin "Reset": unlike reload(), this deletes the file first.
export async function reset() {
  loaded = false;
  invalidateAiredIndex();
  await db.reset();
  await load();
}

// WAL writes are durable per statement; kept as a no-op for existing callers.
export async function save() {
  // no-op
}

// Fold the WAL sidecar back into library.db (best-effort TRUNCATE checkpoint),
// from the scheduler's hourly cleanup and the shutdown path (#786).
export function checkpoint(): void {
  if (!db.isOpen()) return;
  const r = db.checkpointWal();
  if (r && r.busy) {
    console.log('[library] WAL checkpoint incomplete (concurrent reader/writer); will retry next pass');
  }
}

export function shutdown(): void {
  if (db.isOpen()) db.close();
  loaded = false;
  invalidateAiredIndex();
}

// Record one aired track into the play-history table. Called fire-and-forget
// from the queue's now-playing watcher: must never throw, and must tolerate a
// DB not open yet (a first play can beat the lazy load()).
export async function recordPlay(p: db.PlayWrite): Promise<void> {
  try {
    await load();
    db.recordPlay(p);
  } catch (err) {
    console.log(`[library] recordPlay failed: ${(err as Error).message}`);
  }
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
    // Era-year surface (#842, #1418): resolveEraYear reads the composed
    // `yearUntrusted`; `isCompilation` rides along as the raw Navidrome fact.
    originalYear: t.originalYear,
    originalYearSource: t.originalYearSource,
    isCompilation: t.isCompilation,
    eraUntrusted: t.eraUntrusted,
    yearUntrusted: t.yearUntrusted,
    genres: t.genres,
    genre: t.genre,
    moods: t.moods,
    audioMoods: t.audioMoods,
    // show-filter.trackAllTags (blocklist `tag` rules) resolves these through
    // this projection for Subsonic-sourced rows.
    lastfmTags: t.lastfmTags,
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
    // queue.applyLoudnessGain's library-lookup fallback; absent = unity gain.
    loudnessLufs: t.loudnessLufs,
    peakDb: t.peakDb,
    // Acoustic surface for the agent picker's Subsonic-fallback path, kept
    // symmetric with what slimTrack gives library-sourced candidates.
    durationSec: t.durationSec,
    structure: t.structure,
    vocalRanges: t.vocalRanges, // [] = instrumental, null = not computed
    paceMean: paceMeanOf(t.pace),
    // Boundary keys for bpmKeyFor / queue.mixAnalysisFor.
    keyRanges: t.keyRanges,
    // Measured ending (fade vs cold, tail loudness/tempo/grid) for the queue's
    // exit canvas + effect gating. null = no signal.
    outro: t.outro,
    // Edge dead air: music/silence-trim.ts resolves EVERY caller through this
    // projection, so dropping one disables the trim silently. null = no signal.
    leadSilenceMs: t.leadSilenceMs,
    tailSilenceMs: t.tailSilenceMs,
    tailStartMs: t.tailStartMs,
  };
}

// A usable tempo, or null. Navidrome emits `bpm: 0` on files with no tempo
// tag, so a non-positive bpm means "unknown" (#862).
export function realBpm(v: any): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

// {bpm, key} for a track: the analyzer's DB numbers first, then whatever the
// track object carries. Single source of truth for the pick/transition paths —
// a per-caller "carries analysis?" guard lets Navidrome's bpm 0 skip the DB
// lookup and mask the analysed value (#862). Boundary keys fall back to the
// dominant key.
export function bpmKeyFor(track: any): { bpm: number | null; key: string | null; keyStart: string | null; keyEnd: string | null } {
  const rec = track?.id ? get(track.id) : null;
  const key = rec?.musicalKey ?? track?.musicalKey ?? null;
  const durSec = rec?.durationSec ?? (Number(track?.duration) || 0);
  const durMs = typeof durSec === 'number' && durSec > 0 ? durSec * 1000 : null;
  return {
    bpm: realBpm(rec?.bpm) ?? realBpm(track?.bpm),
    key,
    keyStart: openingKeyFrom(rec?.keyRanges, key),
    keyEnd: endingKeyFrom(rec?.keyRanges, durMs, key),
  };
}

// Back-compat shim collapsing the DB's split write surfaces (metadata + tags).
export function set(songId: string, data: any) {
  db.upsertTrackMeta(songId, {
    title: data.title,
    artist: data.artist,
    album: data.album,
    albumId: data.albumId ?? null,
    artistId: data.artistId ?? null,
    year: data.year,
    genres: Array.isArray(data.genres) && data.genres.length
      ? data.genres
      : data.genre ? [data.genre] : null,
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

// COUNT(*) of tagged tracks — avoids materialising a ~30k array for a
// length (#723).
export function countTagged(): number {
  return loaded ? db.countTagged() : 0;
}

export function candidateFilterTracks() {
  return loaded ? db.candidateFilterTracks() : [];
}

// One library row in the same slim shape every pool source hands back, so
// blocklist.matchOf reaches its exact id tiers (get()'s projection carries no
// ids and parses the heavy acoustic blobs). null when there is no row.
export function slimById(songId: string): any {
  if (!loaded || !songId) return null;
  const t = db.getTrack(songId);
  return t ? slimTrack(t) : null;
}

// Album-cooldown exemption facts (#1485 FR 3): two columns off the primary
// key, resolved per candidate on every pick, so it skips the heavier lean read
// below. null (a Subsonic-only track) reads as "no evidence".
export function getAlbumFacts(songId: string) {
  return loaded ? db.getAlbumFacts(songId) : null;
}

// Lean metadata for the /now-playing hot path, so a per-listener poll never
// parses the heavy acoustic *_json blobs (#723).
export function getPlaybackMeta(songId: string): db.TrackLite | null {
  return loaded ? db.getTrackLite(songId) : null;
}

// When a track entered the library, null if not in the tagged index. Playlist
// sync keys "new since last sync" off this, so a Subsonic-only track reads
// null and is never blind-appended.
export function taggedAtOf(songId: string): string | null {
  if (!loaded) return null;
  return db.getTrack(songId)?.taggedAt ?? null;
}

// Musically-adjacent moods. The tagger tags by how a track FEELS, so
// time-of-day moods end up near-empty; songsByMood() widens to these
// neighbours when a requested mood is sparsely tagged.
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
  // rejectBlocked here (not on the final return) so the MOOD_MIN_EXACT
  // widening threshold counts airable tracks, not blocked ones.
  const flatten = (rows: db.TrackRecord[]) =>
    blocklist.rejectBlocked(rows.map(r => ({
      id: r.id,
      title: r.title,
      artist: r.artist,
      album: r.album,
      albumId: r.albumId,
      artistId: r.artistId,
      year: r.year,
      genres: r.genres,
      genre: r.genre,
      moods: r.moods,
      energy: r.energy,
      // Seconds, for the max-track-length cap (#447) — without it a long mix
      // reads as "unknown length" and slips past.
      durationSec: r.durationSec,
    })));

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

// Mean of the pace curve (0..1), null when un-analysed. Shared by slimTrack
// and get() so both pick paths see the same scalar.
export function paceMeanOf(pace: Array<{ value: number }> | null | undefined): number | null {
  return pace && pace.length
    ? Math.round((pace.reduce((s, p) => s + p.value, 0) / pace.length) * 1000) / 1000
    : null;
}

// Structural-part count over the opening, null when un-analysed. Shared by
// both pick payloads so `sections` means one thing.
export function sectionCount(t: { structure?: any[] | null } | null | undefined): number | null {
  return Array.isArray(t?.structure) && t.structure.length ? t.structure.length : null;
}

function slimTrack(r: db.TrackRecord) {
  return {
    id: r.id,
    title: r.title,
    artist: r.artist,
    album: r.album,
    // Subsonic ids, so blocklist.matchOf reaches its EXACT id tiers; without
    // them an album entry falls back to (album name, track artist), which a
    // compilation defeats. Not part of the LLM candidate surface —
    // picker/slim.ts whitelists its own fields.
    albumId: r.albumId,
    artistId: r.artistId,
    year: r.year,
    // Era-year surface (#842, #1418), inline so show-filter's era checks need
    // no per-track DB lookup.
    originalYear: r.originalYear,
    isCompilation: r.isCompilation,
    yearUntrusted: r.yearUntrusted,
    genres: r.genres,
    genre: r.genre,
    moods: r.moods,
    // Sound-derived moods (music/audio-moods.ts), [] until scored. Kept
    // separate from the editorial `moods`.
    audioMoods: r.audioMoods,
    energy: r.energy,
    // Seconds, for the max-track-length cap (#447). null = unknown.
    durationSec: r.durationSec,
    // Acoustic analysis — null on un-analysed tracks, read as "no signal".
    bpm: r.bpm,
    musicalKey: r.musicalKey,
    introMs: r.introMs,
    loudnessLufs: r.loudnessLufs,
    structure: r.structure,
    vocalRanges: r.vocalRanges,
    // Scalar mean pace (0..1); the full curve stays in the record.
    paceMean: paceMeanOf(r.pace),
  };
}

export function songsByEnergy(energy: string | null | undefined): any[] {
  if (!energy || !loaded) return [];
  if (energy !== 'low' && energy !== 'medium' && energy !== 'high') return [];
  return blocklist.rejectBlocked(db.songsByEnergy(energy).map(slimTrack));
}

// KNN over the text embedding space. `seed` is normally a track id, but the
// picker agent often passes a title — an id miss retries the string as a
// title. No embedding and no title match gives [], and callers fall back.
export function tracksLikeThis(seed: string, k: number, opts: db.KnnOpts = {}): any[] {
  if (!loaded || !seed) return [];
  let hits = db.knnById(seed, k, opts);
  if (hits.length === 0) {
    for (const row of db.filter({ q: seed, limit: 8 }).rows) {
      if (row.id === seed) continue;            // already tried as an id above
      hits = db.knnById(row.id, k, opts);
      if (hits.length) break;
    }
  }
  const out: any[] = [];
  for (const hit of hits) {
    const t = db.getTrack(hit.id);
    if (t) out.push({ ...slimTrack(t), _similarity: hit.similarity });
  }
  return blocklist.rejectBlocked(out);
}

// Audio KNN over the CLAP vectors — the sonic counterpart to tracksLikeThis,
// same title-fallback shape. [] when the seed has no audio vector.
export function tracksLikeThisAudio(seed: string, k: number, opts: db.KnnOpts = {}): any[] {
  if (!loaded || !seed) return [];
  let hits = db.knnAudioById(seed, k, opts);
  if (hits.length === 0) {
    for (const row of db.filter({ q: seed, limit: 8 }).rows) {
      if (row.id === seed) continue;            // already tried as an id above
      hits = db.knnAudioById(row.id, k, opts);
      if (hits.length) break;
    }
  }
  const out: any[] = [];
  for (const hit of hits) {
    const t = db.getTrack(hit.id);
    if (t) out.push({ ...slimTrack(t), _similarity: hit.similarity });
  }
  return blocklist.rejectBlocked(out);
}

// The task-prefix mode the text-embedding index was built in — query embeds
// must match it (embeddings.embedQueryText). 'plain' when the DB isn't loaded
// or the meta predates mode tracking (legacy indexes were embedded bare).
export function embeddingIndexTextMode(): 'plain' | 'prefixed' {
  if (!loaded) return 'plain';
  return db.getEmbeddingMeta()?.textMode ?? 'plain';
}

// KNN against an externally-computed query vector (lyric-search free text).
export function tracksByVector(vec: number[] | Float32Array, k: number, opts: db.KnnOpts = {}): any[] {
  if (!loaded) return [];
  // On embedding model drift the query vector stops matching the index dim and
  // knnByVector throws sqlite-vec's raw error at the DJ agent. Degrade to an
  // empty result instead.
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
  const hits = db.knnByVector(vec, k, opts);
  const out: any[] = [];
  for (const hit of hits) {
    const t = db.getTrack(hit.id);
    if (t) out.push({ ...slimTrack(t), _similarity: hit.similarity });
  }
  return blocklist.rejectBlocked(out);
}

// Audio KNN against an externally-computed query vector, for when a sonic
// journey waypoint is the anchor instead of the current track.
export function tracksByAudioVector(vec: number[] | Float32Array, k: number, opts: db.KnnOpts = {}): any[] {
  if (!loaded) return [];
  const hits = db.knnByAudioVector(vec, k, opts);
  const out: any[] = [];
  for (const hit of hits) {
    const t = db.getTrack(hit.id);
    if (t) out.push({ ...slimTrack(t), _similarity: hit.similarity });
  }
  return blocklist.rejectBlocked(out);
}

// Whether the CLAP index covers this track — a cheap existence check (no blob
// decode), so a blind sample of a partially-analysed bucket can't yield a
// centroid of two tracks.
export function hasAudioVector(id: string): boolean {
  if (!loaded || !id) return false;
  try { return db.hasAudioVector(id); } catch { return false; }
}

// Last-aired index over the plays table, memoised — every pick path consults
// it and a GROUP BY over the whole history per tool call is wasteful. 5 min
// staleness is harmless: the short horizon is guarded by the recency sets, and
// this signal only separates "days ago" from "never".
const AIRED_INDEX_TTL_MS = 5 * 60 * 1000;
let airedIndexCache: { at: number; val: AiredIndex } | null = null;
let airedIndexWarnedAt = 0;
const AIRED_WARN_THROTTLE_MS = 10 * 60 * 1000;

// Must be called wherever the backing DB is swapped or wiped, or the picker
// re-ranks against a gone database for up to AIRED_INDEX_TTL_MS.
function invalidateAiredIndex(): void {
  airedIndexCache = null;
  invalidateArtistPlayStats();
}

export function trackPlayStatsFor(song: CandidateLike): db.TrackPlayStats | null {
  const index = lastAiredInfo();
  if (song?.id != null) {
    const byId = index.playStatsById?.get(song.id);
    if (byId) return byId;
  }
  return song?.title ? (index.playStatsByKey?.get(trackKey(song)) ?? null) : null;
}

// Same staleness/failure posture as lastAiredInfo, over the artist-grouped
// query. A separate cache because the two are read independently.
const ARTIST_PLAY_TTL_MS = 5 * 60 * 1000;
let artistPlayCache: { at: number; val: Map<string, db.ArtistPlayStats> } | null = null;
let artistPlayWarnedAt = 0;

function invalidateArtistPlayStats(): void {
  artistPlayCache = null;
}

export function artistPlayStats(): Map<string, db.ArtistPlayStats> {
  if (!loaded) return new Map();
  if (artistPlayCache && Date.now() - artistPlayCache.at < ARTIST_PLAY_TTL_MS) {
    return artistPlayCache.val;
  }
  try {
    const val = db.artistPlayIndex();
    artistPlayCache = { at: Date.now(), val };
    return val;
  } catch (err) {
    const now = Date.now();
    if (now - artistPlayWarnedAt > AIRED_WARN_THROTTLE_MS) {
      artistPlayWarnedAt = now;
      console.warn(`[library] artist play index unavailable: ${(err as Error).message} — picks drop artist play-frequency signal`);
    }
    return new Map();
  }
}

// Lookup for one artist name, case/whitespace-insensitive.
export function artistPlayStatsFor(artist: string | null | undefined): db.ArtistPlayStats | null {
  if (!artist) return null;
  return artistPlayStats().get(artist.toLowerCase().trim()) ?? null;
}

export function lastAiredInfo(): AiredIndex {
  if (!loaded) return EMPTY_AIRED_INDEX;
  if (airedIndexCache && Date.now() - airedIndexCache.at < AIRED_INDEX_TTL_MS) {
    return airedIndexCache.val;
  }
  try {
    const val = db.lastAiredIndex();
    airedIndexCache = { at: Date.now(), val };
    return val;
  } catch (err) {
    // Fail open: airing memory is a soft ranking signal and must never block a
    // pick. Warn anyway (throttled), or an unreadable plays table looks
    // exactly like a station with no history.
    const now = Date.now();
    if (now - airedIndexWarnedAt > AIRED_WARN_THROTTLE_MS) {
      airedIndexWarnedAt = now;
      console.warn(`[library] airing index unavailable: ${(err as Error).message} — picks fall back to plain shuffle and drop the "unaired" signal`);
    }
    return EMPTY_AIRED_INDEX;
  }
}

// Random sample of tracks never aired, or unaired for `days`.
export function deepCuts(days: number = DEEP_CUT_DAYS, k = 60): any[] {
  if (!loaded) return [];
  const cutoffIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    return blocklist.rejectBlocked(db.deepCutTracks(cutoffIso, k).map(slimTrack));
  } catch {
    return [];
  }
}

export function stats() {
  if (!loaded) {
    return { total: 0, mirrorTotal: 0, distinctArtists: 0, byMood: {}, byEnergy: {}, byGenre: {}, updatedAt: null, embeddingMeta: null };
  }
  const s = db.stats();
  return {
    total: s.total,
    // Every row, tagged or not — NOT `total`, which counts only what the
    // tagger reached. Anything sizing itself to the library reads this one.
    mirrorTotal: s.mirrorTotal,
    distinctArtists: s.distinctArtists,
    byMood: s.byMood,
    byEnergy: s.byEnergy,
    byGenre: s.byGenre,
    bySource: s.bySource,
    withEmbedding: s.withEmbedding,
    withAudioEmbedding: s.withAudioEmbedding,
    updatedAt: s.updatedAt,
    // Provenance of the text-embedding index ({model, dim} or null), so the
    // admin UI can warn before a provider switch changes the model under it.
    embeddingMeta: db.getEmbeddingMeta(),
  };
}

// Scene vocabulary (#1577). A merge is two halves owned by two modules — the
// durable RULE (scene-vocab.ts) and the in-place REWRITE (library-db) — paired
// here so a route cannot do one and forget the other.

// Not a bare re-export: the `loaded` guard makes an unopened DB answer "no
// vocabulary yet" rather than throw.
export function scenes(): db.SceneCount[] {
  if (!loaded) return [];
  return db.sceneVocabulary();
}

export interface SceneConsolidation extends db.SceneMergeResult {
  target: string;
  /** Alias keys now recorded — what a later walk will rewrite. */
  recorded: string[];
}

export async function consolidateScenes(
  sources: readonly string[],
  target: string,
): Promise<SceneConsolidation> {
  // Rule FIRST: if the rewrite fails the transaction rolls back and the next
  // walk still consolidates. The reverse order leaves rewritten rows with no
  // rule, which the next walk silently undoes.
  const { target: resolved, recorded } = await sceneVocab.recordMerge(sources, target);
  const merged = db.mergeScenes(sources, resolved);
  return { ...merged, target: resolved, recorded };
}

// Share (0..1) of text vectors that embed nothing but the artist/title/album
// label, null when the index is empty/unloaded. On such an index cosine
// similarity ranks by label TEXT while presenting itself as mood similarity
// (#1246), so the picker tools read this and react.
export function labelOnlyShare(): number | null {
  if (!loaded) return null;
  try {
    const embedded = db.stats().withEmbedding ?? 0;
    if (!embedded) return null;
    return db.labelOnlyVectorCount() / embedded;
  } catch {
    return null;
  }
}

// How many tracks have had a vocal pass at all (a stored "[]", an analysed
// instrumental, counts as done). Deliberately NOT folded into stats() — only
// the vocal show filter needs it, so only its callers pay for the COUNT.
export function vocalAnalyzedCount(): number {
  if (!loaded) return 0;
  try { return db.vocalAnalyzedCount(); } catch { return 0; }
}

// Filter contract for the admin Library browse panel; the SQL is in library-db.
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
  // Era surface (#842/#1418) — what era filtering, the DJ line and the picker
  // will read. `originalYearSource` lets the override UI tell "resolved" from
  // "the album tag echoed the release year".
  originalYear?: number | null;
  originalYearSource?: string | null;
  isCompilation?: boolean | null;
  eraUntrusted?: boolean | null;
  genres?: string[];
  genre?: string | null;
  duration?: number | null;
  moods: string[];
  energy: string | null;
  source?: string | null;
  taggedAt?: string | null;
  // Acoustic analysis, null when the analyze pass hasn't touched the track.
  // `instrumental` is derived: null = not computed, true = analysed with no
  // vocal ranges, false = analysed with vocals.
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
      originalYear: r.originalYear,
      originalYearSource: r.originalYearSource,
      isCompilation: r.isCompilation,
      eraUntrusted: r.eraUntrusted,
      genres: r.genres,
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
      instrumental: isInstrumental(r.vocalRanges),
    })),
  };
}
