// Subsonic API client for Navidrome.
// Uses the proper salt+token auth (not plaintext password).

import crypto from 'node:crypto';
import { config } from '../config.js';

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

async function call(endpoint, params = {}) {
  const url = buildUrl(endpoint, params);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Subsonic ${endpoint} failed: ${res.status}`);
  const data = await res.json();
  const sub = data['subsonic-response'];
  if (sub.status !== 'ok') throw new Error(`Subsonic error: ${sub.error?.message || 'unknown'}`);
  return sub;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function search(query, { songCount = 20, songOffset = 0 } = {}) {
  const r = await call('search3', { query, songCount, songOffset, artistCount: 5, albumCount: 5 });
  return r.searchResult3?.song || [];
}

export async function getRandomSongs({ size = 20, genre, fromYear, toYear } = {}) {
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
