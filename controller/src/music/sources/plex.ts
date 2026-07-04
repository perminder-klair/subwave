// Plex Media Server music source (settings.music.source === 'plex').
// Static server URL + X-Plex-Token auth. Talks the PMS HTTP API (JSON via the
// `Accept: application/json` header) and maps Plex's `MediaContainer.Metadata`
// rows into the loose Song/Album/Artist shapes the rest of the app consumes.
//
// Playback: Plex serves the original file bytes at `${url}${part.key}?X-Plex-
// Token=…`. We hand Liquidsoap that URL wrapped in the `subhttp:` protocol (the
// same curl-backed path Navidrome uses) so the broadcast container fetches it
// with curl rather than Liquidsoap's own http.get.stream. The track's part key
// is stashed on `song.path` at map time because getPlayableUri is synchronous.
//
// The pure mappers (mapTrack/mapAlbum/mapArtist/partKeyOf/msToSec) are exported
// and unit-pinned in scripts/plex-mapping.test.ts — no network in that test.

import { config } from '../../config.js';
import { isStationArchive } from './station-archive.js';
import type { MusicSource, Song, Artist, Album, Genre, Playlist, CoverArt, AnalyzableRef } from './types.js';

export { isStationArchive };

// Plex `type` codes for the library query API. (8 = artist — unused; artist
// lookups go through /hubs/search and metadata children instead.)
const TYPE_ALBUM = 9;
const TYPE_TRACK = 10;

// ---------------------------------------------------------------------------
// Pure mappers (exported for unit tests — no network, no config side effects)
// ---------------------------------------------------------------------------

// Plex durations are milliseconds; Song.duration is seconds (Subsonic parity).
export function msToSec(ms: any): number | undefined {
  return typeof ms === 'number' && ms > 0 ? Math.round(ms / 1000) : undefined;
}

// The direct file part key of a track's first media/part, e.g.
// "/library/parts/12/1600000000/file.mp3". Null when Plex returned no media
// (album/artist rows, or a track whose Media was stripped from the response).
export function partKeyOf(md: any): string | null {
  const part = md?.Media?.[0]?.Part?.[0];
  return part?.key || null;
}

export function mapTrack(md: any): Song {
  return {
    id: String(md.ratingKey),
    title: md.title || '',
    artist: md.grandparentTitle || md.originalTitle || '',
    album: md.parentTitle || '',
    albumId: md.parentRatingKey != null ? String(md.parentRatingKey) : undefined,
    artistId: md.grandparentRatingKey != null ? String(md.grandparentRatingKey) : undefined,
    // Track year is often absent — fall back to the album's parentYear.
    year: typeof md.year === 'number' ? md.year
      : (typeof md.parentYear === 'number' ? md.parentYear : undefined),
    // Genre is tagged at album/artist level in Plex; a track row carries it in
    // Genre[] only sometimes. Take the first tag when present.
    genre: Array.isArray(md.Genre) && md.Genre.length ? String(md.Genre[0].tag) : undefined,
    duration: msToSec(md.duration),
    // getPlayableUri / getAnnotatedUri read `path` to build the stream URL.
    path: partKeyOf(md) || undefined,
    // thumb order: track → album → artist, so a track with no art still shows
    // its album/artist cover.
    coverArt: md.thumb || md.parentThumb || md.grandparentThumb || undefined,
    index: typeof md.index === 'number' ? md.index : undefined,
    // Heuristic-ordering signals (Plex has no Last.fm graph): play count feeds
    // top-songs/frequent, user rating feeds starred. Underscore-prefixed so they
    // never collide with the annotate: field names.
    _viewCount: typeof md.viewCount === 'number' ? md.viewCount : 0,
    _userRating: typeof md.userRating === 'number' ? md.userRating : 0,
  };
}

export function mapAlbum(md: any): Album {
  return {
    id: String(md.ratingKey),
    name: md.title || '',
    artist: md.parentTitle || '',
    artistId: md.parentRatingKey != null ? String(md.parentRatingKey) : undefined,
    year: typeof md.year === 'number' ? md.year : undefined,
    songCount: typeof md.leafCount === 'number' ? md.leafCount : undefined,
    coverArt: md.thumb || undefined,
    // Plex addedAt is epoch SECONDS — ISO string keeps parity with Subsonic's
    // `created` (albumReleaseRank in source.ts parses it with Date.parse).
    created: typeof md.addedAt === 'number' ? new Date(md.addedAt * 1000).toISOString() : undefined,
    _viewCount: typeof md.viewCount === 'number' ? md.viewCount : 0,
  };
}

export function mapArtist(md: any): Artist {
  return {
    id: String(md.ratingKey),
    name: md.title || '',
    albumCount: typeof md.childCount === 'number' ? md.childCount : undefined,
  };
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

function base(): string {
  return String(config.plex.url || '').replace(/\/+$/, '');
}

// Build a PMS URL with the token baked into the query string. Used for both
// API calls and the file/cover URLs handed to Liquidsoap / the analyzer / the
// cover proxy — the token never reaches a listener browser (those URLs are
// fetched server-side).
function plexUrl(pathname: string, params: Record<string, any> = {}): string {
  const url = new URL(base() + pathname);
  url.searchParams.set('X-Plex-Token', config.plex.token || '');
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

async function call(pathname: string, params: Record<string, any> = {}): Promise<any> {
  const res = await fetch(plexUrl(pathname, params), { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    let body = '';
    try { body = (await res.text()).slice(0, 200); } catch {}
    throw new Error(`Plex ${pathname} failed: ${res.status}${body ? ` — ${body}` : ''}`);
  }
  const data = await res.json() as any;
  return data?.MediaContainer ?? {};
}

const metadataOf = (mc: any): any[] => (Array.isArray(mc?.Metadata) ? mc.Metadata : []);
const directoryOf = (mc: any): any[] => (Array.isArray(mc?.Directory) ? mc.Directory : []);
const rejectArchive = (arr: any[]) => (arr || []).filter((s) => !isStationArchive(s));

// ---------------------------------------------------------------------------
// Music library section — auto-discovered (first `artist`-type section) and
// cached, unless PLEX_LIBRARY pins it. Mirrors the subsonic sonic-ext probe TTL.
// ---------------------------------------------------------------------------

let sectionCache: { id: string; at: number } | null = null;
const SECTION_TTL_MS = 30 * 60 * 1000;

async function musicSectionId(): Promise<string> {
  if (config.plex.section) return String(config.plex.section);
  if (sectionCache && Date.now() - sectionCache.at < SECTION_TTL_MS) return sectionCache.id;
  const mc = await call('/library/sections');
  const music = directoryOf(mc).find((d: any) => d.type === 'artist');
  if (!music) throw new Error('no music (artist) library section found on the Plex server — set PLEX_LIBRARY to the section id');
  sectionCache = { id: String(music.key), at: Date.now() };
  return sectionCache.id;
}

// Section genres, cached title→key so getSongsByGenre can resolve a name to the
// filter id Plex needs. Rebuilt on the same TTL as the section.
let genreCache: { map: Map<string, string>; at: number } | null = null;

async function genreMap(): Promise<Map<string, string>> {
  if (genreCache && Date.now() - genreCache.at < SECTION_TTL_MS) return genreCache.map;
  const sec = await musicSectionId();
  const mc = await call(`/library/sections/${sec}/genre`);
  const map = new Map<string, string>();
  for (const d of directoryOf(mc)) {
    if (d?.title && d?.key != null) map.set(String(d.title).toLowerCase(), String(d.key));
  }
  genreCache = { map, at: Date.now() };
  return map;
}

// ---------------------------------------------------------------------------
// MusicSource interface
// ---------------------------------------------------------------------------

async function ping(): Promise<{ ok: boolean; reason?: string }> {
  if (!config.plex.url || !config.plex.token) {
    return { ok: false, reason: 'Plex URL / token not configured (set PLEX_URL + PLEX_TOKEN)' };
  }
  try {
    const sec = await musicSectionId();
    return { ok: true, reason: `music section ${sec}` };
  } catch (err: any) {
    return { ok: false, reason: err?.message || 'unreachable' };
  }
}

// Full-text search via the global hubs endpoint, filtered to the track hub.
async function search(query: string, { songCount = 20, songOffset = 0 }: { songCount?: number; songOffset?: number } = {}): Promise<Song[]> {
  if (!String(query || '').trim()) return [];
  const mc = await call('/hubs/search', { query, limit: songCount + songOffset });
  const hubs = Array.isArray(mc?.Hub) ? mc.Hub : [];
  const trackHub = hubs.find((h: any) => h.type === 'track');
  const rows = metadataOf(trackHub).map(mapTrack);
  return rejectArchive(rows).slice(songOffset, songOffset + songCount);
}

async function searchArtists(query: string, { artistCount = 5 }: { artistCount?: number } = {}): Promise<Artist[]> {
  if (!String(query || '').trim()) return [];
  const mc = await call('/hubs/search', { query, limit: artistCount });
  const hubs = Array.isArray(mc?.Hub) ? mc.Hub : [];
  const artistHub = hubs.find((h: any) => h.type === 'artist');
  // Artist hubs surface rows under Metadata on modern PMS, Directory on older.
  const rows = [...metadataOf(artistHub), ...directoryOf(artistHub)];
  return rows.slice(0, artistCount).map(mapArtist);
}

async function getSong(id: string): Promise<Song | null> {
  const mc = await call(`/library/metadata/${id}`);
  const md = metadataOf(mc)[0];
  return md ? mapTrack(md) : null;
}

async function getAlbum(id: string): Promise<Song[]> {
  const mc = await call(`/library/metadata/${id}/children`);
  return rejectArchive(metadataOf(mc).map(mapTrack));
}

async function getArtist(id: string): Promise<Artist | null> {
  const mc = await call(`/library/metadata/${id}`);
  const md = metadataOf(mc)[0];
  if (!md) return null;
  const artist = mapArtist(md);
  let album: Album[] = [];
  try {
    const children = await call(`/library/metadata/${id}/children`);
    album = metadataOf(children).map(mapAlbum);
  } catch {
    // artist with no readable children — return the bare artist
  }
  return { ...artist, album };
}

async function getGenres(): Promise<Genre[]> {
  const sec = await musicSectionId();
  const mc = await call(`/library/sections/${sec}/genre`);
  return directoryOf(mc).map((d: any) => ({ value: String(d.title || ''), songCount: undefined }));
}

async function getSongsByGenre(genre: string, { count = 20 }: { count?: number } = {}): Promise<Song[]> {
  const sec = await musicSectionId();
  const key = (await genreMap()).get(String(genre || '').toLowerCase());
  if (!key) return [];
  const mc = await call(`/library/sections/${sec}/all`, {
    type: TYPE_TRACK, genre: key, sort: 'random', 'X-Plex-Container-Size': count,
  });
  return rejectArchive(metadataOf(mc).map(mapTrack));
}

async function getRandomSongs({ size = 20, genre, fromYear, toYear }: { size?: number; genre?: string; fromYear?: number; toYear?: number } = {}): Promise<Song[]> {
  const sec = await musicSectionId();
  const params: Record<string, any> = { type: TYPE_TRACK, sort: 'random' };
  if (genre) {
    const key = (await genreMap()).get(String(genre).toLowerCase());
    if (key) params.genre = key;
  }
  // Year is filtered client-side (Plex's range-filter query syntax varies by
  // server version, so we over-fetch and trim rather than depend on it).
  const yearFilter = fromYear != null || toYear != null;
  params['X-Plex-Container-Size'] = yearFilter ? size * 6 : size;
  const mc = await call(`/library/sections/${sec}/all`, params);
  let rows = rejectArchive(metadataOf(mc).map(mapTrack));
  if (fromYear != null) rows = rows.filter((s) => s.year != null && s.year >= fromYear);
  if (toYear != null) rows = rows.filter((s) => s.year != null && s.year <= toYear);
  return rows.slice(0, size);
}

async function getAlbumList(offset = 0, size = 500): Promise<Album[]> {
  const sec = await musicSectionId();
  const mc = await call(`/library/sections/${sec}/all`, {
    type: TYPE_ALBUM, sort: 'titleSort', 'X-Plex-Container-Start': offset, 'X-Plex-Container-Size': size,
  });
  return metadataOf(mc).map(mapAlbum);
}

async function getRecentlyAddedAlbums({ size = 20 }: { size?: number } = {}): Promise<Album[]> {
  const sec = await musicSectionId();
  const mc = await call(`/library/sections/${sec}/all`, {
    type: TYPE_ALBUM, sort: 'addedAt:desc', 'X-Plex-Container-Size': size,
  });
  return metadataOf(mc).map(mapAlbum);
}

async function getFrequentAlbums({ size = 20 }: { size?: number } = {}): Promise<Album[]> {
  const sec = await musicSectionId();
  const mc = await call(`/library/sections/${sec}/all`, {
    type: TYPE_ALBUM, sort: 'viewCount:desc', 'X-Plex-Container-Size': size,
  });
  return metadataOf(mc).map(mapAlbum);
}

// Popularity-ranked songs for an artist. Plex keys everything by ratingKey, so
// resolve the NAME to an artist id first, then pull the artist's leaves
// (all tracks under it) sorted by play count.
async function getTopSongs(artistName: string, { count = 10 }: { count?: number } = {}): Promise<Song[]> {
  const [artist] = await searchArtists(artistName, { artistCount: 1 });
  if (!artist?.id) return [];
  const mc = await call(`/library/metadata/${artist.id}/allLeaves`, {
    sort: 'viewCount:desc', 'X-Plex-Container-Size': count,
  });
  return rejectArchive(metadataOf(mc).map(mapTrack));
}

// The operator's rated favourites. Plex has no boolean "star", so we take
// user-rated tracks (rating is 0–10; ≥6 == 3★+) and enforce the threshold
// client-side — robust even if the server ignores the sort hint.
async function getStarred(): Promise<Song[]> {
  const sec = await musicSectionId();
  const mc = await call(`/library/sections/${sec}/all`, {
    type: TYPE_TRACK, sort: 'userRating:desc', 'X-Plex-Container-Size': 100,
  });
  const rows = rejectArchive(metadataOf(mc).map(mapTrack));
  return rows.filter((s: any) => (s._userRating ?? 0) >= 6);
}

async function* iterateAllSongs(): AsyncGenerator<Song> {
  const sec = await musicSectionId();
  const BATCH = 500;
  let offset = 0;
  while (true) {
    const mc = await call(`/library/sections/${sec}/all`, {
      type: TYPE_TRACK, 'X-Plex-Container-Start': offset, 'X-Plex-Container-Size': BATCH,
    });
    const rows = metadataOf(mc);
    if (rows.length === 0) break;
    for (const s of rejectArchive(rows.map(mapTrack))) yield s;
    if (rows.length < BATCH) break;
    offset += rows.length;
  }
}

async function getPlaylists(): Promise<Playlist[]> {
  const mc = await call('/playlists', { playlistType: 'audio' });
  return metadataOf(mc).map((p: any) => ({
    id: String(p.ratingKey),
    name: p.title || '',
    songCount: typeof p.leafCount === 'number' ? p.leafCount : undefined,
  }));
}

async function getPlaylist(id: string): Promise<Song[]> {
  const mc = await call(`/playlists/${id}/items`);
  return rejectArchive(metadataOf(mc).map(mapTrack));
}

// Liquidsoap stream URI. `song.path` is the Plex Part key captured at map time;
// wrap the token'd file URL in `subhttp:` so radio.liq fetches it via curl.
function getPlayableUri(song: Song): string {
  return `subhttp:${plexUrl(String(song.path || ''))}`;
}

// Audio for the acoustic-analysis worker — a plain HTTP URL it fetches with
// urllib. Needs the part key, so resolve the track first.
async function getAnalyzableRef(songId: string): Promise<AnalyzableRef | null> {
  const song = await getSong(songId);
  if (!song?.path) return null;
  return { url: plexUrl(String(song.path)) };
}

// Cover art as a proxied URL — the /cover/:id route fetches these bytes so
// listener browsers never see the Plex token. Resolve the track's thumb path.
async function getCoverArt(id: string): Promise<CoverArt | null> {
  const song = await getSong(id);
  const thumb = song?.coverArt;
  if (!thumb) return null;
  return { url: plexUrl(String(thumb)) };
}

export const plexSource: MusicSource = {
  id: 'plex',
  // core
  ping, search, getSong, getAlbum, getArtist, searchArtists, getGenres,
  getRandomSongs, getSongsByGenre, getAlbumList, iterateAllSongs,
  getPlayableUri, getCoverArt, getAnalyzableRef,
  // discovery (capability table gates these — Plex serves the server-side ones)
  getStarred, getTopSongs, getPlaylists, getPlaylist,
  getRecentlyAddedAlbums, getFrequentAlbums,
  // Intentionally absent (capabilities OFF): getSimilarSongs,
  // supportsSonicSimilarity, getSonicSimilarTracks, getArtistInfo,
  // getArtistLastfmTags, getLyrics.
};
