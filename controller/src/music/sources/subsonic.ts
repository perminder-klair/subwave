// Subsonic API client for Navidrome.
// Uses the proper salt+token auth (not plaintext password).

import crypto from 'node:crypto';
import { config } from '../../config.js';
import * as subLog from '../subsonic-log.js';
import { isStationArchive } from './station-archive.js';
import type { MusicSource, CoverArt, AnalyzableRef } from './types.js';

export { isStationArchive };

function buildAuth() {
  const salt = crypto.randomBytes(8).toString('hex');
  const token = crypto
    .createHash('md5')
    .update(config.navidrome.password + salt)
    .digest('hex');
  return { u: config.navidrome.user, t: token, s: salt };
}

function buildUrl(endpoint, params = {}) {
  const url = new URL(`${config.navidrome.url}/rest/${endpoint}`);
  const auth = buildAuth();
  url.searchParams.set('u', auth.u);
  url.searchParams.set('t', auth.t);
  url.searchParams.set('s', auth.s);
  url.searchParams.set('v', config.navidrome.apiVersion);
  url.searchParams.set('c', config.navidrome.clientName);
  url.searchParams.set('f', 'json');
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    // Subsonic repeats some params (songId, songIdToAdd, songIndexToRemove) —
    // arrays append one query param per element.
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
    else url.searchParams.set(k, String(v));
  }
  return url.toString();
}

// Song-carrying response paths — hand-curated. Add an entry when a NEW
// endpoint returns SONGS that should count toward the song-coverage map in
// subsonic-log.js ("is the picker drawing from the whole library or a narrow
// pool?"). Not auto-derived from response shape: only endpoints whose array
// elements are individual tracks belong here.
const SONG_PATHS = [
  ['searchResult3', 'song'], ['randomSongs', 'song'], ['songsByGenre', 'song'],
  ['similarSongs2', 'song'], ['starred2', 'song'], ['topSongs', 'song'],
  ['album', 'song'], ['playlist', 'entry'],
];

// Non-song response paths — albums, artists, genres, playlists. Used only to
// populate the log's `count` field so /debug reflects how many items every
// endpoint actually returned (a getGenres call that returns 40 genres used to
// log as count:0). These shapes do NOT feed song-coverage analytics.
const OTHER_PATHS = [
  ['albumList2', 'album'], ['searchResult3', 'album'],
  ['searchResult3', 'artist'], ['genres', 'genre'],
  ['playlists', 'playlist'], ['artist', 'album'],
];

// The OpenSubsonic `sonicSimilarity` extension returns a different shape from
// every other song endpoint: a `sonicMatch` array whose elements wrap the song
// in `entry` alongside a `similarity` score, rather than a flat song array.
// Some servers nest it under `sonicSimilarTracks`; tolerate both, and fall back
// to the element itself for servers that inline the Child. Shared by the public
// getter and the coverage-logging extractor so /debug analytics stay accurate.
function sonicSimilarSongs(sub: any): any[] {
  const matches = sub?.sonicMatch ?? sub?.sonicSimilarTracks?.sonicMatch ?? [];
  if (!Array.isArray(matches)) return [];
  return matches.map((m: any) => m?.entry ?? m?.song ?? m).filter(Boolean);
}

function extractSongs(sub) {
  for (const [a, b] of SONG_PATHS) {
    const v = sub[a]?.[b];
    if (Array.isArray(v)) return v;
  }
  // sonicSimilarity uses the `sonicMatch` wrapper shape, not a SONG_PATHS entry.
  const sonic = sonicSimilarSongs(sub);
  if (sonic.length) return sonic;
  return [];
}

// Total items in the response: songs if any, else the first non-song shape
// that matches. Both paths are checked because search3 returns songs AND
// artists in the same response — songs win when present.
function extractCount(sub, songs) {
  if (songs.length > 0) return songs.length;
  for (const [a, b] of OTHER_PATHS) {
    const v = sub[a]?.[b];
    if (Array.isArray(v)) return v.length;
  }
  return 0;
}

async function call(endpoint, params = {}) {
  const started = Date.now();
  try {
    const url = buildUrl(endpoint, params);
    // Bounded fetch: a hung Navidrome must fail fast, not pin the request
    // (and every admin route queued behind it) forever (#786). The abort
    // rejects with a TimeoutError, translated into a readable message.
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(config.navidrome.timeoutMs) });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new Error(
          `Subsonic ${endpoint} timed out after ${config.navidrome.timeoutMs}ms — is Navidrome responding?`,
        );
      }
      throw err;
    }
    if (!res.ok) {
      // Capture the first 200 chars of the body so outage triage gets the
      // actual server message (Cloudflare 522, Navidrome 5xx detail, etc.)
      // instead of just a bare status code.
      let body = '';
      try { body = (await res.text()).slice(0, 200); } catch {}
      throw new Error(`Subsonic ${endpoint} failed: ${res.status}${body ? ` — ${body}` : ''}`);
    }
    const data = await res.json() as any;
    const sub = data['subsonic-response'];
    if (sub.status !== 'ok') throw new Error(`Subsonic error: ${sub.error?.message || 'unknown'}`);
    const songs = extractSongs(sub);
    subLog.record({
      t: new Date().toISOString(), endpoint, params, ms: Date.now() - started,
      ok: true, count: extractCount(sub, songs),
      // Songs carry both id and title; non-song shapes (albums, artists,
      // genres, playlists) are reflected in `count` above but not here.
      songIds: songs
        .filter((i: any) => i?.id && i?.title)
        .map((i: any) => ({ id: i.id, title: i.title, artist: i.artist })),
    });
    return sub;
  } catch (err) {
    subLog.record({
      t: new Date().toISOString(), endpoint, params, ms: Date.now() - started,
      ok: false, count: 0, songIds: [], error: err.message,
    });
    throw err;
  }
}

// Lightweight connectivity + auth check for the admin Doctor. Hits the cheapest
// Subsonic endpoint (`ping`) with the controller's own salt+token creds — mirrors
// the CLI wizard's probeSubsonic but against config.navidrome. Never throws.
export async function ping(): Promise<{ ok: boolean; reason?: string }> {
  if (!config.navidrome.url || !config.navidrome.user || !config.navidrome.password) {
    return { ok: false, reason: 'Navidrome URL / username / password not configured' };
  }
  try {
    await call('ping');
    return { ok: true };
  } catch (err: any) {
    return { ok: false, reason: err?.message || 'unreachable' };
  }
}

// The station-archive guard (issue #273) lives in sources/station-archive.js —
// it's source-agnostic and shared with the local-folder source. `call()` logging
// is untouched, so /debug still shows the raw Subsonic responses.
const rejectArchive = (arr: any[]) => (arr || []).filter((s) => !isStationArchive(s));

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function search(query, { songCount = 20, songOffset = 0 } = {}) {
  const r = await call('search3', { query, songCount, songOffset, artistCount: 5, albumCount: 5 });
  return rejectArchive(r.searchResult3?.song || []);
}

export async function getRandomSongs({ size = 20, genre, fromYear, toYear }: { size?: number; genre?: string; fromYear?: number; toYear?: number } = {}) {
  const r = await call('getRandomSongs', { size, genre, fromYear, toYear });
  return rejectArchive(r.randomSongs?.song || []);
}

export async function getSongsByGenre(genre, { count = 20 } = {}) {
  const r = await call('getSongsByGenre', { genre, count });
  return rejectArchive(r.songsByGenre?.song || []);
}

// All genre tags present in the library, each with { value, songCount,
// albumCount }. Used to resolve a listener's free-text genre ("hip hop") to
// the exact tag the library actually carries ("Hip-Hop").
export async function getGenres() {
  const r = await call('getGenres');
  return r.genres?.genre || [];
}

export async function getSimilarSongs(id, { count = 20 } = {}) {
  const r = await call('getSimilarSongs2', { id, count });
  return rejectArchive(r.similarSongs2?.song || []);
}

// ---------------------------------------------------------------------------
// OpenSubsonic `sonicSimilarity` extension (Navidrome ≥0.62 + plugin enabled)
// ---------------------------------------------------------------------------
// Audio-based neighbours computed from the actual audio by Navidrome's plugin
// system — a third similarity signal alongside the Last.fm graph
// (getSimilarSongs) and the controller's own embedding-KNN (library.tracksLikeThis).
// Gated behind a capability probe because the extension is optional: when the
// operator hasn't installed/enabled the plugin the endpoint 404s, so the picker
// must check support first rather than eat a failing call every pick.

let sonicExtCache: { ok: boolean; at: number } | null = null;
const EXT_PROBE_TTL_MS = 30 * 60 * 1000;

// True if the server advertises the `sonicSimilarity` extension. Result cached
// 30 min: a missing extension won't appear mid-session and a present one won't
// vanish, but the TTL means a just-upgraded Navidrome is picked up without a
// controller restart. Failures (old Navidrome, network) resolve to false and
// are cached the same way — the probe is best-effort, never throws.
export async function supportsSonicSimilarity(): Promise<boolean> {
  if (sonicExtCache && Date.now() - sonicExtCache.at < EXT_PROBE_TTL_MS) return sonicExtCache.ok;
  let ok = false;
  try {
    const r = await call('getOpenSubsonicExtensions');
    const exts = r.openSubsonicExtensions || [];
    ok = exts.some((e: any) => (typeof e === 'string' ? e : e?.name) === 'sonicSimilarity');
  } catch {
    ok = false;
  }
  sonicExtCache = { ok, at: Date.now() };
  return ok;
}

export async function getSonicSimilarTracks(id, { count = 20 } = {}) {
  const r = await call('getSonicSimilarTracks', { id, count });
  return rejectArchive(sonicSimilarSongs(r));
}

export async function getStarred() {
  const r = await call('getStarred2');
  return rejectArchive(r.starred2?.song || []);
}

export async function getAlbumList(offset = 0, size = 500) {
  const r = await call('getAlbumList2', { type: 'alphabeticalByName', size, offset });
  return r.albumList2?.album || [];
}

// Most-recently imported albums. Drives the "new in the crates" picker source.
export async function getRecentlyAddedAlbums({ size = 20 } = {}) {
  const r = await call('getAlbumList2', { type: 'newest', size });
  return r.albumList2?.album || [];
}

// Albums sorted by play count — Navidrome's scrobble-backed "favourites".
export async function getFrequentAlbums({ size = 20 } = {}) {
  const r = await call('getAlbumList2', { type: 'frequent', size });
  return r.albumList2?.album || [];
}

// Last.fm-backed artist info: bio, images, and (most usefully) similar artists.
export async function getArtistInfo(id, { count = 10 } = {}) {
  const r = await call('getArtistInfo2', { id, count });
  return r.artistInfo2 || null;
}

// Last.fm "top songs" for an artist, intersected with what's in the library.
// Note: keyed by artist NAME, not id.
export async function getTopSongs(artistName, { count = 10 } = {}) {
  const r = await call('getTopSongs', { artist: artistName, count });
  return rejectArchive(r.topSongs?.song || []);
}

export async function getAlbum(id) {
  const r = await call('getAlbum', { id });
  return rejectArchive(r.album?.song || []);
}

// Single song lookup — the Child carries albumId, which is how manual album
// tagging resolves a whole album from one track id (the UI never sees albumIds).
export async function getSong(id) {
  const r = await call('getSong', { id });
  return r.song || null;
}

// Returns { id, name, albumCount, album: [{ id, name, year, ... }] }
export async function getArtist(id) {
  const r = await call('getArtist', { id });
  return r.artist || null;
}

// Search just the artist index and return matching artist objects.
export async function searchArtists(query, { artistCount = 5 } = {}) {
  const r = await call('search3', { query, artistCount, albumCount: 0, songCount: 0 });
  return r.searchResult3?.artist || [];
}

// Last.fm-backed crowd tags for an artist, normalised to lowercase trimmed
// strings. Used by the embedding-propagated tagger to enrich the embedding
// text — see music/embeddings.ts formatTrackText. Returns [] if the artist
// has no Last.fm coverage (common for very obscure releases).
export async function getArtistLastfmTags(id, { count = 20 } = {}) {
  try {
    const info = await getArtistInfo(id, { count: 0 });
    const tags = info?.tag || info?.tags?.tag || [];
    const arr = Array.isArray(tags) ? tags : [tags];
    return arr
      .map((t) => (typeof t === 'string' ? t : t?.name))
      .filter((s) => typeof s === 'string' && s.trim().length > 0)
      .map((s) => s.toLowerCase().trim())
      .slice(0, count);
  } catch {
    return [];
  }
}

// Track lyrics via Subsonic's getLyricsBySongId. Returns the plain-text
// lyrics, or '' if no lyrics are indexed for this track. Navidrome v0.49+
// supports this; older Navidromes return a `lyricsList` shape without a
// match — both paths normalise to a string.
export async function getLyrics(songId) {
  try {
    const r = await call('getLyricsBySongId', { id: songId });
    // Modern Navidrome: { lyricsList: { structuredLyrics: [{ line: [{ value: '...' }] }] } }
    const structured = r.lyricsList?.structuredLyrics;
    if (Array.isArray(structured) && structured.length) {
      const lines: string[] = [];
      for (const sl of structured) {
        const lineArr = Array.isArray(sl.line) ? sl.line : [];
        for (const l of lineArr) {
          if (typeof l?.value === 'string' && l.value.trim()) lines.push(l.value.trim());
        }
      }
      return lines.join(' ');
    }
    // Legacy getLyrics shape: { lyrics: { value: '...' } }
    if (typeof r.lyrics?.value === 'string') return r.lyrics.value;
    return '';
  } catch {
    return '';
  }
}

// Async iterator over every song in the library. Walks albums in batches.
export async function* iterateAllSongs() {
  let offset = 0;
  const BATCH = 500;
  while (true) {
    const albums = await getAlbumList(offset, BATCH);
    if (albums.length === 0) break;
    for (const album of albums) {
      try {
        // getAlbum already drops station-archive recordings (issue #273).
        const songs = await getAlbum(album.id);
        for (const s of songs) yield s;
      } catch (err) {
        console.error(`[subsonic] getAlbum(${album.id}) failed: ${err.message}`);
      }
    }
    if (albums.length < BATCH) break;
    offset += albums.length;
  }
}

export async function getPlaylists() {
  const r = await call('getPlaylists');
  return r.playlists?.playlist || [];
}

export async function getPlaylist(id) {
  const r = await call('getPlaylist', { id });
  return rejectArchive(r.playlist?.entry || []);
}

// ---------------------------------------------------------------------------
// Playlist mutations (admin library UI). Song-id lists ride the query string,
// so they are chunked to keep URLs well under length limits.
// ---------------------------------------------------------------------------
const PLAYLIST_CHUNK = 100;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Creates a playlist and returns it. Extra ids beyond the first chunk are
// appended via updatePlaylist; playlists are made public so the operator's
// own Navidrome login sees them, not just the SUB/WAVE service account.
export async function createPlaylist(name: string, songIds: string[] = []) {
  const [first = [], ...rest] = chunk(songIds, PLAYLIST_CHUNK);
  const r = await call('createPlaylist', { name, songId: first });
  const playlist = r.playlist;
  if (playlist?.id) {
    for (const ids of rest) {
      await call('updatePlaylist', { playlistId: playlist.id, songIdToAdd: ids });
    }
    await call('updatePlaylist', { playlistId: playlist.id, public: true });
  }
  return playlist;
}

// Appends songs to an existing playlist. Returns how many ids were sent.
export async function addToPlaylist(playlistId: string, songIds: string[]) {
  for (const ids of chunk(songIds, PLAYLIST_CHUNK)) {
    await call('updatePlaylist', { playlistId, songIdToAdd: ids });
  }
  return songIds.length;
}

// Removes entries by position (Subsonic removes by index, not song id).
export async function removeFromPlaylist(playlistId: string, indexes: number[]) {
  await call('updatePlaylist', { playlistId, songIndexToRemove: indexes });
}

// Rename / visibility. Undefined fields are dropped by buildUrl, so callers
// can patch a single attribute without touching the rest.
export async function updatePlaylistMeta(
  playlistId: string,
  meta: { name?: string; comment?: string; public?: boolean },
) {
  await call('updatePlaylist', {
    playlistId, name: meta.name, comment: meta.comment, public: meta.public,
  });
}

export async function deletePlaylist(id: string) {
  await call('deletePlaylist', { id });
}

// Authenticated cover-art URL for a given Subsonic song id. Returns the
// `getCoverArt` REST endpoint with auth params baked in; bytes are JPEG (or
// PNG/WebP depending on what Subsonic resampled). The controller proxies
// this through /cover/:id so listener browsers never see Subsonic creds.
export function getCoverArtUrl(id, size = 512) {
  return buildUrl('getCoverArt', { id, size });
}

// Returns a streamable URL for Liquidsoap to read. Wrapped in the `subhttp:`
// protocol scheme so Liquidsoap's radio.liq routes the fetch through curl
// instead of its built-in http.get.stream (which returns spurious 522s
// against the Cloudflare-fronted Navidrome origin).
//
// format=raw asks Navidrome to stream the original file bytes (no transcode).
// Library is AAC 256 kbps m4a from gamdl; without `raw`, Navidrome would
// transcode to ~192 kbps MP3 on the way out, adding a lossy generation before
// Liquidsoap's own MP3 re-encode. Liquidsoap decodes m4a/AAC via ffmpeg.
export function getStreamUrl(songId) {
  return `subhttp:${buildUrl('stream', { id: songId, format: 'raw' })}`;
}

// Plain HTTP stream URL (no `subhttp:` prefix) with auth baked into the query
// string — for the analysis worker, which fetches the original bytes with
// urllib and decodes the first chunk. `format=raw` avoids a transcode hop.
export function getRawStreamUrl(songId: string): string {
  return buildUrl('stream', { id: songId, format: 'raw' });
}

// Returns the local file path if Navidrome and the controller share the music
// volume — much more efficient than streaming over HTTP for the radio.
// Set MUSIC_LIBRARY_PATH to mount your library inside the controller container.
export function getLocalPath(song) {
  const libRoot = process.env.MUSIC_LIBRARY_PATH;
  if (!libRoot || !song.path) return null;
  return `${libRoot}/${song.path}`;
}

// Best URI for Liquidsoap — local file if available, otherwise stream URL
export function getPlayableUri(song) {
  return getLocalPath(song) || getStreamUrl(song.id);
}


// ---------------------------------------------------------------------------
// MusicSource interface adapters
// ---------------------------------------------------------------------------

// Cover art as a proxied URL — the /cover/:id route fetches these bytes so
// listener browsers never see Subsonic creds. (A byte-returning source, e.g.
// the local folder, returns `{ buf, contentType }` instead.)
export async function getCoverArt(id: string, size = 512): Promise<CoverArt | null> {
  return { url: getCoverArtUrl(id, size) };
}

// Audio for the acoustic-analysis worker: a plain HTTP URL it fetches with
// urllib. (A local source returns `{ path }` on the shared mount instead.)
export async function getAnalyzableRef(songId: string): Promise<AnalyzableRef | null> {
  return { url: getRawStreamUrl(songId) };
}


// The Navidrome/Subsonic music source. Functions stay module-level (internal
// call structure untouched); this object is just the interface handle the
// registry hands to the facade.
export const subsonicSource: MusicSource = {
  id: 'subsonic',
  // core
  ping, search, getSong, getAlbum, getArtist, searchArtists, getGenres,
  getRandomSongs, getSongsByGenre, getAlbumList, iterateAllSongs,
  getPlayableUri, getCoverArt, getAnalyzableRef,
  // discovery
  getSimilarSongs, supportsSonicSimilarity, getSonicSimilarTracks,
  getStarred, getTopSongs, getArtistInfo, getArtistLastfmTags, getLyrics,
  getPlaylists, getPlaylist, getRecentlyAddedAlbums, getFrequentAlbums,
};
