import { config } from '../config.js';
import { buildAnnotatedUri } from './subsonic.js';
import * as lastfm from './lastfm.js';
import * as db from './library-db.js';

function plexHeaders(): Record<string, string> {
  return {
    'X-Plex-Token': config.plex.token,
    'Accept': 'application/json',
    'X-Plex-Client-Identifier': 'subwave',
    'X-Plex-Product': 'SubWave',
  };
}

async function plexFetch(path: string, params?: Record<string, string>): Promise<any> {
  const url = new URL(config.plex.url + path);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: plexHeaders(),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Plex ${path} -> HTTP ${res.status}`);
  return res.json();
}

let _sectionKey: string | null = null;

async function getSectionKey(): Promise<string> {
  if (_sectionKey) return _sectionKey;
  const data = await plexFetch('/library/sections');
  const sections: any[] = data?.MediaContainer?.Directory || [];
  const music = sections.find((s: any) => s.type === 'artist');
  if (!music) throw new Error('No Plex music library found. Add a Music library in Plex first.');
  _sectionKey = music.key;
  return _sectionKey!;
}

export function normalizePlexTrack(t: any): any {
  const media = Array.isArray(t.Media) ? t.Media[0] : t.Media;
  const partList = t.Part || media?.Part;
  const part = Array.isArray(partList) ? partList[0] : partList;
  return {
    id: `plex:${t.ratingKey}`,
    title: t.title || '',
    artist: t.grandparentTitle || '',
    album: t.parentTitle || '',
    year: t.parentYear || undefined,
    genre: (Array.isArray(t.Genre) ? t.Genre[0]?.tag : t.Genre?.tag) || undefined,
    duration: t.duration ? Math.floor(t.duration / 1000) : undefined,
    path: part?.file || undefined,
    _partKey: part?.key || '',
    _thumb: t.thumb || '',
  };
}

async function fetchTracks(params: Record<string, string>): Promise<any[]> {
  const key = await getSectionKey();
  const data = await plexFetch(`/library/sections/${key}/all`, { type: '10', ...params });
  return (data?.MediaContainer?.Metadata || []).map(normalizePlexTrack);
}

export async function ping(): Promise<{ ok: boolean; reason?: string }> {
  try {
    if (!config.plex.url || !config.plex.token) {
      return { ok: false, reason: 'Plex URL or token not configured' };
    }
    const data = await plexFetch('/identity');
    return { ok: true, reason: `Plex ${data?.MediaContainer?.version || ''}` };
  } catch (err: any) {
    return { ok: false, reason: err.message };
  }
}

export function isStationArchive(song: any): boolean {
  const p = song?.path || '';
  return /\barchive\b/.test(p) && /\d{2}-00\.\w+$/.test(p);
}

export async function search(query: string, opts: { songCount?: number; songOffset?: number } = {}): Promise<any[]> {
  try {
    const key = await getSectionKey();
    const data = await plexFetch('/search', { query, type: '10', sectionId: key, limit: String(opts.songCount ?? 20) });
    return (data?.MediaContainer?.Metadata || []).map(normalizePlexTrack);
  } catch { return []; }
}

export async function getRandomSongs(opts: { size?: number; genre?: string } = {}): Promise<any[]> {
  try {
    const params: Record<string, string> = { sort: 'random', 'X-Plex-Container-Size': String(opts.size ?? 20) };
    if (opts.genre) params.genre = opts.genre;
    return fetchTracks(params);
  } catch { return []; }
}

export async function getSongsByGenre(genre: string, opts: { count?: number } = {}): Promise<any[]> {
  try {
    return fetchTracks({ genre, 'X-Plex-Container-Size': String(opts.count ?? 20) });
  } catch { return []; }
}

export async function getGenres(): Promise<{ value: string; songCount: number; albumCount: number }[]> {
  try {
    const key = await getSectionKey();
    const data = await plexFetch(`/library/sections/${key}/genre`);
    return (data?.MediaContainer?.Directory || []).map((g: any) => ({
      value: g.title || '',
      songCount: g.size || 0,
      albumCount: 0,
    }));
  } catch { return []; }
}

export async function resolveGenreName(name: string): Promise<string | null> {
  const genres = await getGenres();
  const match = genres.find(g => g.value.toLowerCase() === name.toLowerCase());
  return match?.value || null;
}

export async function resolveArtist(name: string): Promise<any | null> {
  try {
    const results = await searchArtists(name, { artistCount: 1 });
    return results[0] || null;
  } catch { return null; }
}

export async function getSimilarSongs(id: string, opts: { count?: number } = {}): Promise<any[]> {
  try {
    const song = await getSong(id);
    if (!song) return [];
    const similarArtists = await lastfm.getSimilarArtists(song.artist, { count: 3 });
    const results: any[] = [];
    for (const artist of similarArtists.slice(0, 3)) {
      const tracks = await search(artist, { songCount: Math.ceil((opts.count || 10) / 3) });
      results.push(...tracks);
      if (results.length >= (opts.count || 10)) break;
    }
    return results.slice(0, opts.count || 10);
  } catch { return []; }
}

export async function supportsSonicSimilarity(): Promise<boolean> {
  return false;
}

export async function getSonicSimilarTracks(id: string, opts: { count?: number } = {}): Promise<any[]> {
  return getSimilarSongs(id, opts);
}

export async function getStarred(): Promise<any[]> {
  try {
    return fetchTracks({ 'userRating>>': '0', sort: 'userRating:desc' });
  } catch { return []; }
}

export async function getRecentlyAddedAlbums(opts: { size?: number } = {}): Promise<any[]> {
  try {
    const key = await getSectionKey();
    const data = await plexFetch(`/library/sections/${key}/all`, {
      type: '9', sort: 'addedAt:desc', 'X-Plex-Container-Size': String(opts.size ?? 20),
    });
    return (data?.MediaContainer?.Metadata || []).map((a: any) => ({
      id: `plex:${a.ratingKey}`,
      name: a.title,
      artist: a.parentTitle,
      year: a.year,
    }));
  } catch { return []; }
}

export async function getFrequentAlbums(opts: { size?: number } = {}): Promise<any[]> {
  try {
    const key = await getSectionKey();
    const data = await plexFetch(`/library/sections/${key}/all`, {
      type: '9', sort: 'viewCount:desc', 'X-Plex-Container-Size': String(opts.size ?? 20),
    });
    return (data?.MediaContainer?.Metadata || []).map((a: any) => ({
      id: `plex:${a.ratingKey}`,
      name: a.title,
      artist: a.parentTitle,
      year: a.year,
    }));
  } catch { return []; }
}

export async function getArtistInfo(id: string, _opts: { count?: number } = {}): Promise<any | null> {
  try {
    const ratingKey = id.replace('plex:', '');
    const data = await plexFetch(`/library/metadata/${ratingKey}`);
    const artist = data?.MediaContainer?.Metadata?.[0];
    if (!artist) return null;
    const lfmInfo = await lastfm.getArtistInfo(artist.title || '');
    return {
      id,
      name: artist.title,
      biography: lfmInfo?.bio || artist.summary || '',
      tags: lfmInfo?.tags || [],
    };
  } catch { return null; }
}

export async function getTopSongs(artistName: string, opts: { count?: number } = {}): Promise<any[]> {
  try {
    const topTracks = await lastfm.getTopTracks(artistName, { count: opts.count || 10 });
    const results: any[] = [];
    for (const t of topTracks.slice(0, opts.count || 10)) {
      const found = await search(`${t.title} ${t.artist}`, { songCount: 1 });
      if (found.length) results.push(found[0]);
    }
    return results;
  } catch { return []; }
}

export async function getRecentSongsByArtist(artistName: string, opts: { count?: number } = {}): Promise<any[]> {
  try {
    return search(artistName, { songCount: opts.count || 10 });
  } catch { return []; }
}

export async function getAlbumList(offset = 0, size = 500): Promise<any[]> {
  try {
    const key = await getSectionKey();
    const data = await plexFetch(`/library/sections/${key}/all`, {
      type: '9',
      sort: 'titleSort',
      'X-Plex-Container-Start': String(offset),
      'X-Plex-Container-Size': String(size),
    });
    return (data?.MediaContainer?.Metadata || []).map((a: any) => ({
      id: `plex:${a.ratingKey}`,
      name: a.title,
      artist: a.parentTitle,
      year: a.year,
    }));
  } catch { return []; }
}

export async function getAlbum(id: string): Promise<any[]> {
  try {
    const ratingKey = id.replace('plex:', '');
    const data = await plexFetch(`/library/metadata/${ratingKey}/children`);
    return (data?.MediaContainer?.Metadata || []).map(normalizePlexTrack);
  } catch { return []; }
}

export async function getSong(id: string): Promise<any | null> {
  try {
    const ratingKey = id.replace('plex:', '');
    const data = await plexFetch(`/library/metadata/${ratingKey}`);
    const track = data?.MediaContainer?.Metadata?.[0];
    return track ? normalizePlexTrack(track) : null;
  } catch { return null; }
}

export async function getArtist(id: string): Promise<any | null> {
  try {
    const ratingKey = id.replace('plex:', '');
    const data = await plexFetch(`/library/metadata/${ratingKey}`);
    const artist = data?.MediaContainer?.Metadata?.[0];
    if (!artist) return null;
    return { id, name: artist.title, albumCount: artist.childCount || 0 };
  } catch { return null; }
}

export async function searchArtists(query: string, opts: { artistCount?: number } = {}): Promise<any[]> {
  try {
    const key = await getSectionKey();
    const data = await plexFetch('/search', { query, type: '8', sectionId: key, limit: String(opts.artistCount ?? 10) });
    return (data?.MediaContainer?.Metadata || []).map((a: any) => ({
      id: `plex:${a.ratingKey}`,
      name: a.title,
    }));
  } catch { return []; }
}

export async function getArtistLastfmTags(id: string, opts: { count?: number } = {}): Promise<string[]> {
  try {
    const artist = await getArtist(id);
    if (!artist) return [];
    return lastfm.getArtistTopTags(artist.name, opts);
  } catch { return []; }
}

export async function getLyrics(songId: string): Promise<string> {
  // Fetch lyrics using the same chain Navidrome's lyrics plugin uses:
  //   1. LRCLIB /api/get  — exact match by title + artist + album + duration
  //   2. LRCLIB /api/search — fuzzy query, pick by duration within 2s
  //   3. lyrics.ovh       — plain text fallback, good coverage for new releases
  //   4. Plex Mood tags   — last resort when nothing else has coverage
  const LRCLIB = 'https://lrclib.net';
  const LYRICS_OVH = 'https://api.lyrics.ovh';
  const UA = { 'User-Agent': 'sub-wave/lyrics' };
  const DURATION_TOLERANCE = 2;
  const EXCERPT = 300;

  async function lrclibGet(title: string, artist: string, album: string, duration: number): Promise<string> {
    const params = new URLSearchParams({
      artist_name: artist,
      track_name: title,
      album_name: album,
      duration: String(Math.round(duration)),
    });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const r = await fetch(`${LRCLIB}/api/get?${params}`, { headers: UA, signal: ctrl.signal });
      if (!r.ok) return '';
      const data = await r.json() as any;
      return (data?.plainLyrics || data?.syncedLyrics || '').trim();
    } catch { return ''; } finally { clearTimeout(timer); }
  }

  async function lrclibSearch(title: string, artist: string, duration: number): Promise<string> {
    const params = new URLSearchParams({ q: `${artist} ${title}` });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const r = await fetch(`${LRCLIB}/api/search?${params}`, { headers: UA, signal: ctrl.signal });
      if (!r.ok) return '';
      const results = await r.json() as any[];
      const match = Array.isArray(results)
        ? results.find(x => typeof x.duration === 'number' && Math.abs(x.duration - duration) <= DURATION_TOLERANCE)
        : null;
      return ((match?.plainLyrics || match?.syncedLyrics) ?? '').trim();
    } catch { return ''; } finally { clearTimeout(timer); }
  }

  async function lyricsOvh(title: string, artist: string): Promise<string> {
    const enc = (s: string) => encodeURIComponent(s);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const r = await fetch(`${LYRICS_OVH}/v1/${enc(artist)}/${enc(title)}`, { headers: UA, signal: ctrl.signal });
      if (!r.ok) return '';
      const data = await r.json() as any;
      return (data?.lyrics || '').trim();
    } catch { return ''; } finally { clearTimeout(timer); }
  }

  try {
    const t = db.isOpen() ? db.getTrack(songId) : null;
    const title = t?.title || '';
    const artist = t?.artist || '';
    const album = t?.album || '';
    const duration = t?.durationSec ?? 0;

    if (title && artist) {
      // 1. LRCLIB exact match
      if (album && duration) {
        const lyrics = await lrclibGet(title, artist, album, duration);
        if (lyrics) return lyrics.slice(0, EXCERPT);
      }

      // 2. LRCLIB fuzzy search
      if (duration) {
        const lyrics = await lrclibSearch(title, artist, duration);
        if (lyrics) return lyrics.slice(0, EXCERPT);
      }

      // 3. lyrics.ovh
      const lyrics = await lyricsOvh(title, artist);
      if (lyrics) return lyrics.slice(0, EXCERPT);
    }

    // 4. Plex Mood tags
    const ratingKey = songId.replace('plex:', '');
    const data = await plexFetch(`/library/metadata/${ratingKey}`);
    const track = data?.MediaContainer?.Metadata?.[0];
    const moods: string[] = (track?.Mood || []).map((m: any) => m.tag).filter(Boolean);
    return moods.length ? `Moods: ${moods.join(', ')}` : '';
  } catch { return ''; }
}

export async function* iterateAllSongs(): AsyncGenerator<any> {
  const key = await getSectionKey();
  let start = 0;
  const size = 100;
  while (true) {
    const data = await plexFetch(`/library/sections/${key}/all`, {
      type: '10',
      'X-Plex-Container-Start': String(start),
      'X-Plex-Container-Size': String(size),
    });
    const tracks: any[] = data?.MediaContainer?.Metadata || [];
    if (tracks.length === 0) break;
    for (const t of tracks) yield normalizePlexTrack(t);
    if (tracks.length < size) break;
    start += size;
  }
}

export async function getPlaylists(): Promise<any[]> {
  try {
    const data = await plexFetch('/playlists', { playlistType: 'audio' });
    return (data?.MediaContainer?.Metadata || []).map((p: any) => ({
      id: `plex:${p.ratingKey}`,
      name: p.title,
      songCount: p.leafCount || 0,
    }));
  } catch { return []; }
}

export async function getPlaylist(id: string): Promise<any[]> {
  try {
    const ratingKey = id.replace('plex:', '');
    const data = await plexFetch(`/playlists/${ratingKey}/items`);
    return (data?.MediaContainer?.Metadata || []).map(normalizePlexTrack);
  } catch { return []; }
}

export async function getCoverArtUrl(id: string, _size?: number): Promise<string> {
  // Plex tracks inherit cover art from their album; the thumb path on the track
  // metadata points to the album ratingKey, not the track's own ratingKey.
  // We store it in plex_thumb during the library walk. When it's not in the DB
  // (track added after last walk), fetch it live from the Plex API rather than
  // guessing /library/metadata/<track-ratingKey>/thumb which always 404s.
  if (db.isOpen()) {
    try {
      const t = db.getTrack(id);
      if (t?.plexThumb) {
        return `${config.plex.url}${t.plexThumb}?X-Plex-Token=${config.plex.token}`;
      }
    } catch { /* ignore */ }
  }
  // Live lookup: the track's own metadata carries a `thumb` field pointing at
  // the album ratingKey (e.g. /library/metadata/55/thumb/…), which Plex serves.
  try {
    const ratingKey = id.replace('plex:', '');
    const data = await plexFetch(`/library/metadata/${ratingKey}`);
    const track = data?.MediaContainer?.Metadata?.[0];
    if (track?.thumb) return `${config.plex.url}${track.thumb}?X-Plex-Token=${config.plex.token}`;
  } catch { /* ignore */ }
  const ratingKey = id.replace('plex:', '');
  return `${config.plex.url}/library/metadata/${ratingKey}/thumb?X-Plex-Token=${config.plex.token}`;
}

export function getStreamUrl(songId: string): string {
  return getRawStreamUrl(songId);
}

export function getRawStreamUrl(songId: string): string {
  let partPath = '';
  if (db.isOpen()) {
    try {
      const t = db.getTrack(songId);
      if (t?.plexPartKey) {
        partPath = t.plexPartKey;
      }
    } catch { /* ignore */ }
  }
  if (!partPath) {
    const ratingKey = songId.replace('plex:', '');
    partPath = `/library/parts/${ratingKey}/0/file`;
  }
  return `${config.plex.url}${partPath}?X-Plex-Token=${config.plex.token}`;
}

export function getLocalPath(_song: any): string | null {
  return null;
}

export function getPlayableUri(song: any): string {
  let partPath = song._partKey || song.plexPartKey;
  if (!partPath && db.isOpen()) {
    try {
      const t = db.getTrack(song.id);
      if (t?.plexPartKey) {
        partPath = t.plexPartKey;
      }
    } catch { /* ignore */ }
  }
  if (!partPath) {
    partPath = `/library/parts/${song.id.replace('plex:', '')}/0/file`;
  }
  return `subhttp:${config.plex.url}${partPath}?X-Plex-Token=${config.plex.token}`;
}

export function getAnnotatedUri(song: any, opts: { maxDurationSec?: number | null } = {}): string {
  return buildAnnotatedUri(song, getPlayableUri(song), opts);
}
