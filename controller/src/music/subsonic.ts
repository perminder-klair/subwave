// Subsonic API client for Navidrome.
// Uses the proper salt+token auth (not plaintext password).

import crypto from 'node:crypto';
import { config } from '../config.js';
import * as subLog from './subsonic-log.js';

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
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
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

function extractSongs(sub) {
  for (const [a, b] of SONG_PATHS) {
    const v = sub[a]?.[b];
    if (Array.isArray(v)) return v;
  }
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
    const res = await fetch(url);
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function search(query, { songCount = 20, songOffset = 0 } = {}) {
  const r = await call('search3', { query, songCount, songOffset, artistCount: 5, albumCount: 5 });
  return r.searchResult3?.song || [];
}

export async function getRandomSongs({ size = 20, genre, fromYear, toYear }: { size?: number; genre?: string; fromYear?: number; toYear?: number } = {}) {
  const r = await call('getRandomSongs', { size, genre, fromYear, toYear });
  return r.randomSongs?.song || [];
}

export async function getSongsByGenre(genre, { count = 20 } = {}) {
  const r = await call('getSongsByGenre', { genre, count });
  return r.songsByGenre?.song || [];
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
  return r.similarSongs2?.song || [];
}

export async function getStarred() {
  const r = await call('getStarred2');
  return r.starred2?.song || [];
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
  return r.topSongs?.song || [];
}

export async function getAlbum(id) {
  const r = await call('getAlbum', { id });
  return r.album?.song || [];
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
  return r.playlist?.entry || [];
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

// Liquidsoap `annotate:` URI — embeds metadata up front so on_track_change
// reports real artist/title/album rather than waiting on stream-level ID3.
function escAnnotate(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
export function getAnnotatedUri(song) {
  const fields = [
    `title="${escAnnotate(song.title)}"`,
    `artist="${escAnnotate(song.artist)}"`,
    `album="${escAnnotate(song.album)}"`,
    `subsonic_id="${escAnnotate(song.id)}"`,
  ];
  if (song.year) fields.push(`year="${escAnnotate(song.year)}"`);
  if (song.genre) fields.push(`genre="${escAnnotate(song.genre)}"`);
  return `annotate:${fields.join(',')}:${getPlayableUri(song)}`;
}
