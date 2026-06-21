// Jellyfin provider.
//
// Jellyfin has its own API (not Subsonic), but a nearly-complete music surface:
// search, genres, artists, albums, playlists, InstantMix (≈ similar), favourites,
// recently-added / frequently-played, cover art, token-auth streaming, and (10.9+)
// lyrics. The operator pastes a server URL + an API key (Jellyfin admin → API
// keys) and, for user-scoped surfaces (favourites, play counts, InstantMix), a
// user id.
//
// Auth: the API key goes in the X-Emby-Token header. Streaming/cover URLs bake
// the key into the query string (Liquidsoap/the cover proxy can't send headers).
// Stream goes through the proven subhttp: (curl) protocol; static=true serves the
// original file (no transcode before Liquidsoap's own encode).

import type { MusicSource, Song } from '../source-kit.js';
import { emptyDiscovery, namespaceId, parseId, buildAnnotateUri, sourceConfig } from '../source-kit.js';

const DEFAULT_FIELDS = 'Path,Genres,RunTimeTicks,ProductionYear';

function cfg() {
  return sourceConfig().jellyfin;
}

// GET against the Jellyfin API with the API-key header. Returns parsed JSON or
// null on any failure (no url/key, network, error) so callers degrade cleanly.
async function jget(path: string, params: Record<string, any> = {}): Promise<any | null> {
  const { url, apiKey } = cfg();
  if (!url || !apiKey) return null;
  const u = new URL(`${url}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  }
  try {
    const res = await fetch(u.toString(), {
      headers: { 'X-Emby-Token': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// /Items-style endpoints wrap results in { Items: [...] }.
async function items(path: string, params: Record<string, any> = {}): Promise<any[]> {
  const data = await jget(path, params);
  return Array.isArray(data?.Items) ? data.Items : Array.isArray(data) ? data : [];
}

// SUB/WAVE's hourly archive mixdowns (archive/YYYY-MM-DD/HH-00.mp3) — keep them
// out of selection if a Jellyfin library happens to index them (issue #273).
function isArchive(song: any): boolean {
  const path = String(song?.path ?? song?.Path ?? '');
  if (/(^|\/)archive\/\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}\.mp3$/i.test(path)) return true;
  const title = String(song?.title ?? song?.Name ?? '').trim();
  const blank = (s: any) => {
    const v = String(s ?? '').trim().toLowerCase();
    return v === '' || v.startsWith('[unknown') || v === 'unknown artist' || v === 'unknown album';
  };
  return /^\d{2}-00$/.test(title) && blank(song?.artist ?? song?.Artists?.[0]) && blank(song?.album ?? song?.Album);
}

function toSong(it: any): Song {
  const raw = String(it.Id);
  return {
    id: namespaceId('jellyfin', raw),
    title: it.Name || '',
    artist: (Array.isArray(it.Artists) && it.Artists[0]) || it.AlbumArtist || '',
    album: it.Album || '',
    albumId: it.AlbumId ? namespaceId('jellyfin', String(it.AlbumId)) : undefined,
    year: it.ProductionYear || undefined,
    genre: (Array.isArray(it.Genres) && it.Genres[0]) || undefined,
    duration: it.RunTimeTicks ? Math.round(it.RunTimeTicks / 1e7) : undefined,
    path: it.Path || undefined,
  };
}

const songsFrom = (rows: any[]) => rows.map(toSong).filter((s) => !isArchive({ Path: s.path, Name: s.title, Artists: [s.artist], Album: s.album }));

function norm(s: any): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export const jellyfinSource: MusicSource = {
  ...emptyDiscovery,
  key: 'jellyfin',
  capabilities: {
    pool: true,
    similar: true,        // InstantMix
    genre: true,
    playlists: true,
    starred: true,        // favourites (needs userId)
    recentlyAdded: true,
    frequent: true,       // by PlayCount (needs userId)
    artistGraph: true,    // top/recent songs by artist
    sonicSimilarity: false,
    lyrics: true,         // /Audio/{id}/Lyrics (Jellyfin 10.9+)
    libraryWalk: true,    // finite library — taggable
  },

  isStationArchive: isArchive,

  async search(query, { songCount = 20 } = {}) {
    const rows = await items('/Items', {
      searchTerm: query, IncludeItemTypes: 'Audio', Recursive: true,
      Limit: songCount, Fields: DEFAULT_FIELDS, userId: cfg().userId,
    });
    return songsFrom(rows);
  },

  async getRandomSongs({ size = 20, genre } = {}) {
    const rows = await items('/Items', {
      IncludeItemTypes: 'Audio', Recursive: true, SortBy: 'Random', Limit: size,
      Genres: genre, Fields: DEFAULT_FIELDS, userId: cfg().userId,
    });
    return songsFrom(rows);
  },

  async getSongsByGenre(genre, { count = 20 } = {}) {
    const rows = await items('/Items', {
      IncludeItemTypes: 'Audio', Recursive: true, Genres: genre, SortBy: 'Random',
      Limit: count, Fields: DEFAULT_FIELDS, userId: cfg().userId,
    });
    return songsFrom(rows);
  },

  async getGenres() {
    const rows = await items('/Genres', { userId: cfg().userId });
    return rows.map((g: any) => ({ value: g.Name, songCount: g.SongCount }));
  },

  async resolveGenreName(name) {
    if (!name) return null;
    const target = norm(name);
    if (!target) return null;
    const genres = await jellyfinSource.getGenres();
    let hit = genres.find((g: any) => norm(g.value) === target);
    if (!hit) {
      hit = genres.find((g: any) => {
        const gv = norm(g.value);
        return gv && (gv.includes(target) || target.includes(gv));
      });
    }
    return hit?.value || null;
  },

  async getSimilarSongs(id, { count = 20 } = {}) {
    const rows = await items(`/Items/${parseId(id).raw}/InstantMix`, {
      Limit: count, Fields: DEFAULT_FIELDS, userId: cfg().userId,
    });
    return songsFrom(rows).filter((s) => parseId(s.id).raw !== parseId(id).raw);
  },

  async getStarred() {
    if (!cfg().userId) return [];
    const rows = await items('/Items', {
      IncludeItemTypes: 'Audio', Recursive: true, Filters: 'IsFavorite',
      Limit: 100, Fields: DEFAULT_FIELDS, userId: cfg().userId,
    });
    return songsFrom(rows);
  },

  async getRecentlyAddedAlbums({ size = 20 } = {}) {
    const rows = await items('/Items', {
      IncludeItemTypes: 'MusicAlbum', Recursive: true, SortBy: 'DateCreated',
      SortOrder: 'Descending', Limit: size, userId: cfg().userId,
    });
    return rows.map((a: any) => ({ id: String(a.Id), name: a.Name, artist: a.AlbumArtist, year: a.ProductionYear }));
  },

  async getFrequentAlbums({ size = 20 } = {}) {
    const rows = await items('/Items', {
      IncludeItemTypes: 'MusicAlbum', Recursive: true, SortBy: 'PlayCount',
      SortOrder: 'Descending', Limit: size, userId: cfg().userId,
    });
    return rows.map((a: any) => ({ id: String(a.Id), name: a.Name, artist: a.AlbumArtist, year: a.ProductionYear }));
  },

  async getAlbum(id) {
    const rows = await items('/Items', {
      ParentId: parseId(id).raw, IncludeItemTypes: 'Audio', SortBy: 'ParentIndexNumber,IndexNumber',
      Fields: DEFAULT_FIELDS, userId: cfg().userId,
    });
    return songsFrom(rows);
  },

  async getSong(id) {
    const rows = await items('/Items', { Ids: parseId(id).raw, Fields: DEFAULT_FIELDS, userId: cfg().userId });
    return rows[0] ? toSong(rows[0]) : null;
  },

  async searchArtists(query, { artistCount = 5 } = {}) {
    const rows = await items('/Artists', { searchTerm: query, Limit: artistCount, userId: cfg().userId });
    return rows.map((a: any) => ({ id: String(a.Id), name: a.Name }));
  },

  async resolveArtist(name) {
    const rows = await jellyfinSource.searchArtists(name, { artistCount: 5 });
    if (!rows.length) return null;
    const exact = rows.find((a: any) => norm(a.name) === norm(name));
    return exact || rows[0];
  },

  async getArtist(id) {
    const raw = parseId(id).raw;
    const [artist] = await items('/Items', { Ids: raw, userId: cfg().userId });
    if (!artist) return null;
    const albums = await items('/Items', {
      IncludeItemTypes: 'MusicAlbum', Recursive: true, ArtistIds: raw,
      SortBy: 'ProductionYear', SortOrder: 'Descending', Limit: 30, userId: cfg().userId,
    });
    return {
      id: String(artist.Id),
      name: artist.Name,
      album: albums.map((a: any) => ({ id: String(a.Id), name: a.Name, year: a.ProductionYear })),
    };
  },

  async getTopSongs(artistName, { count = 10 } = {}) {
    const artist = await jellyfinSource.resolveArtist(artistName);
    if (!artist?.id) return [];
    const rows = await items('/Items', {
      IncludeItemTypes: 'Audio', Recursive: true, ArtistIds: artist.id,
      SortBy: 'PlayCount', SortOrder: 'Descending', Limit: count, Fields: DEFAULT_FIELDS, userId: cfg().userId,
    });
    return songsFrom(rows);
  },

  async getRecentSongsByArtist(artistName, { count = 20 } = {}) {
    const artist = await jellyfinSource.resolveArtist(artistName);
    if (!artist?.id) return [];
    const rows = await items('/Items', {
      IncludeItemTypes: 'Audio', Recursive: true, ArtistIds: artist.id,
      SortBy: 'DateCreated', SortOrder: 'Descending', Limit: count, Fields: DEFAULT_FIELDS, userId: cfg().userId,
    });
    return songsFrom(rows);
  },

  async getPlaylists() {
    const rows = await items('/Items', { IncludeItemTypes: 'Playlist', Recursive: true, userId: cfg().userId });
    return rows.map((p: any) => ({ id: String(p.Id), name: p.Name }));
  },

  async getPlaylist(id) {
    const rows = await items(`/Playlists/${parseId(id).raw}/Items`, { Fields: DEFAULT_FIELDS, userId: cfg().userId });
    return songsFrom(rows);
  },

  async getLyrics(id) {
    const data = await jget(`/Audio/${parseId(id).raw}/Lyrics`);
    const lines = Array.isArray(data?.Lyrics) ? data.Lyrics : [];
    return lines.map((l: any) => (typeof l?.Text === 'string' ? l.Text.trim() : '')).filter(Boolean).join(' ');
  },

  async *iterateAllSongs() {
    const PAGE = 500;
    let start = 0;
    while (true) {
      const rows = await items('/Items', {
        IncludeItemTypes: 'Audio', Recursive: true, StartIndex: start, Limit: PAGE,
        SortBy: 'SortName', Fields: DEFAULT_FIELDS, userId: cfg().userId,
      });
      if (!rows.length) break;
      for (const s of songsFrom(rows)) yield s;
      if (rows.length < PAGE) break;
      start += rows.length;
    }
  },

  getCoverArtUrl(id, size = 512) {
    const { url, apiKey } = cfg();
    if (!url || !apiKey) return null;
    return `${url}/Items/${parseId(id).raw}/Images/Primary?maxWidth=${size}&api_key=${encodeURIComponent(apiKey)}`;
  },

  getRawStreamUrl(id) {
    const { url, apiKey } = cfg();
    if (!url || !apiKey) return '';
    return `${url}/Audio/${parseId(id).raw}/stream?static=true&api_key=${encodeURIComponent(apiKey)}`;
  },

  getAnnotatedUri(song) {
    const stream = jellyfinSource.getRawStreamUrl(song.id);
    if (!stream) return '';
    return buildAnnotateUri(song, `subhttp:${stream}`);
  },
};
