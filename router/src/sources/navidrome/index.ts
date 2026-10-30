// Navidrome (or any Subsonic server) as a router source. Navidrome IS a
// Subsonic server, so unlike the jellyfin and plex sources — which translate a
// foreign item model — this is a Subsonic client: the router in reverse. Most
// ops are one call whose parameters already match.
//
// You only need this behind the router to MERGE a Navidrome library with
// another source; a station on Navidrome alone talks to it directly. When it
// does sit behind the router, the controller sets `rawIds`, so the ids the
// station already stores keep resolving.
//
// Subsonic reports failure inside an HTTP 200, so call() reads the envelope's
// status rather than resp.status; a JSON body on the binary endpoints means the
// "audio" is an error message, which the router's media guard refuses.

import crypto from 'node:crypto';
import { defineSource, isVariousArtists, type Album, type Artist, type ArtistRef, type Playlist, type ReplayGain, type Song } from '../../sdk/index.js';

const NOT_FOUND = 70;
const UNIMPLEMENTED = [0, 30];

class SubsonicError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

interface SubRef {
  id?: string;
  name?: string;
}

interface SubChild {
  id: string;
  title?: string;
  album?: string;
  albumId?: string;
  artist?: string;
  artistId?: string;
  artists?: SubRef[];
  albumArtists?: SubRef[];
  track?: number;
  discNumber?: number;
  year?: number;
  genre?: string;
  genres?: { name?: string }[];
  coverArt?: string;
  size?: number;
  contentType?: string;
  suffix?: string;
  duration?: number;
  bitRate?: number;
  path?: string;
  playCount?: number;
  created?: string;
  starred?: string;
  musicBrainzId?: string;
  replayGain?: ReplayGain & { baseGain?: number };
}

interface SubDateParts {
  year?: number;
  month?: number;
  day?: number;
}

interface SubAlbum {
  id: string;
  name?: string;
  album?: string;
  artist?: string;
  artistId?: string;
  artists?: SubRef[];
  coverArt?: string;
  songCount?: number;
  duration?: number;
  playCount?: number;
  created?: string;
  year?: number;
  genre?: string;
  genres?: { name?: string }[];
  isCompilation?: boolean;
  originalReleaseDate?: SubDateParts;
  releaseDate?: SubDateParts;
  musicBrainzId?: string;
  song?: SubChild[];
}

interface SubArtist {
  id: string;
  name?: string;
  coverArt?: string;
  albumCount?: number;
  musicBrainzId?: string;
  album?: SubAlbum[];
}

interface SubPlaylist {
  id: string;
  name?: string;
  comment?: string;
  public?: boolean;
  owner?: string;
  created?: string;
  changed?: string;
  entry?: SubChild[];
}

type Params = Record<string, string | number | boolean | undefined | (string | number)[]>;

const names = (multi: { name?: string }[] | undefined, scalar: string | undefined): string[] => {
  const out = (multi ?? []).map((g) => g.name).filter((n): n is string => Boolean(n));
  return out.length ? out : scalar ? [scalar] : [];
};

const refs = (v: SubRef[] | undefined): ArtistRef[] | undefined => {
  const out = (v ?? []).filter((r): r is { id: string; name: string } => Boolean(r.id && r.name)).map((r) => ({ id: r.id, name: r.name }));
  return out.length ? out : undefined;
};

const dateOf = (d: SubDateParts | undefined) => (d?.year ? { year: d.year, month: d.month ?? 1, day: d.day ?? 1 } : undefined);

export default defineSource((ctx) => {
  const base = String(ctx.config.url ?? '').replace(/\/+$/, '');
  const user = String(ctx.config.user ?? '');
  const pass = String(ctx.config.password ?? '');

  // A fresh salt per request, as every Subsonic client does.
  function url(path: string, params: Params = {}): string {
    const salt = crypto.randomBytes(8).toString('hex');
    const token = crypto.createHash('md5').update(pass + salt).digest('hex');
    const u = new URL(base + path);
    const all: Params = { u: user, t: token, s: salt, v: '1.16.1', c: 'subwave-router', f: 'json', ...params };
    for (const [k, v] of Object.entries(all)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const item of v) u.searchParams.append(k, String(item));
      else u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  // Auth and permission failures throw rather than degrading to an empty
  // library: health derives "unreachable" from a throw, and a wrong password
  // must read as broken, not as a library with no songs.
  async function call<T>(endpoint: string, params: Params = {}): Promise<T> {
    const resp = await ctx.fetch(url(`/rest/${endpoint}`, params));
    if (!resp.ok) throw new Error(`Navidrome ${endpoint} → HTTP ${resp.status}`);
    const body = (await resp.json()) as { 'subsonic-response'?: { status?: string; error?: { code?: number; message?: string } } };
    const env = body['subsonic-response'];
    if (!env) throw new Error(`Navidrome ${endpoint} → not a Subsonic response`);
    if (env.status === 'failed') {
      const code = env.error?.code ?? 0;
      throw new SubsonicError(code, `Navidrome ${endpoint} → ${env.error?.message ?? 'failed'} (code ${code})`);
    }
    return env as unknown as T;
  }

  async function find<T>(endpoint: string, params: Params = {}): Promise<T | undefined> {
    try {
      return await call<T>(endpoint, params);
    } catch (err) {
      if (err instanceof SubsonicError && err.code === NOT_FOUND) return undefined;
      throw err;
    }
  }

  // The OpenSubsonic fields pass straight through: genres[], artists[],
  // albumArtists[], musicBrainzId and replayGain are what make Navidrome the
  // richest source, and the router normalises whatever is missing.
  const song = (c: SubChild): Song => ({
    id: c.id,
    title: c.title ?? '',
    album: c.album,
    albumId: c.albumId,
    artist: c.artist,
    artistId: c.artistId,
    artists: refs(c.artists),
    albumArtists: refs(c.albumArtists),
    track: c.track,
    discNumber: c.discNumber,
    year: c.year,
    genres: names(c.genres, c.genre),
    coverArt: c.coverArt ?? c.albumId,
    size: c.size,
    contentType: c.contentType,
    suffix: c.suffix,
    duration: c.duration,
    bitRate: c.bitRate,
    path: c.path,
    playCount: c.playCount,
    created: c.created,
    musicBrainzId: c.musicBrainzId,
    replayGain: c.replayGain,
  });

  const album = (a: SubAlbum): Album => ({
    id: a.id,
    name: a.name ?? a.album ?? '',
    artist: a.artist,
    artistId: a.artistId,
    artists: refs(a.artists),
    coverArt: a.coverArt ?? a.id,
    songCount: a.songCount,
    duration: a.duration,
    playCount: a.playCount,
    created: a.created,
    year: a.year,
    genres: names(a.genres, a.genre),
    // A real OpenSubsonic field here; the albumartist convention is the fallback.
    isCompilation: a.isCompilation === true || isVariousArtists(a.artist) || undefined,
    originalReleaseDate: dateOf(a.originalReleaseDate),
    releaseDate: dateOf(a.releaseDate),
    musicBrainzId: a.musicBrainzId,
  });

  const artist = (a: SubArtist): Artist => ({
    id: a.id,
    name: a.name ?? '',
    coverArt: a.coverArt ?? a.id,
    albumCount: a.albumCount,
    musicBrainzId: a.musicBrainzId,
  });

  async function playlistFrom(p: SubPlaylist): Promise<Playlist> {
    const full = p.entry ? p : ((await find<{ playlist?: SubPlaylist }>('getPlaylist', { id: p.id }))?.playlist ?? p);
    return {
      id: p.id,
      name: full.name ?? '',
      comment: full.comment,
      public: full.public,
      owner: full.owner ?? user,
      created: full.created,
      changed: full.changed,
      songs: (full.entry ?? []).map(song),
    };
  }

  async function playlistById(id: string): Promise<Playlist | undefined> {
    const body = await find<{ playlist?: SubPlaylist }>('getPlaylist', { id });
    return body?.playlist && playlistFrom(body.playlist);
  }

  return {
    async song(id) {
      const body = await find<{ song?: SubChild }>('getSong', { id });
      return body?.song && song(body.song);
    },

    async album(id) {
      const body = await find<{ album?: SubAlbum }>('getAlbum', { id });
      return body?.album && { album: album(body.album), songs: (body.album.song ?? []).map(song) };
    },

    async artist(id) {
      const body = await find<{ artist?: SubArtist }>('getArtist', { id });
      return body?.artist && { artist: artist(body.artist), albums: (body.artist.album ?? []).map(album) };
    },

    async artists() {
      const body = await call<{ artists?: { index?: { artist?: SubArtist[] }[] } }>('getArtists');
      return (body.artists?.index ?? []).flatMap((i) => i.artist ?? []).map(artist);
    },

    async artistInfo(id, count) {
      const body = await find<{ artistInfo2?: { biography?: string; musicBrainzId?: string; lastFmUrl?: string; similarArtist?: SubArtist[]; tag?: { name?: string }[] } }>('getArtistInfo2', { id, count });
      const info = body?.artistInfo2;
      if (!info) return undefined;
      return {
        biography: info.biography,
        musicBrainzId: info.musicBrainzId,
        lastFmUrl: info.lastFmUrl,
        similarArtists: (info.similarArtist ?? []).map(artist),
        tags: (info.tag ?? []).map((t) => t.name ?? '').filter(Boolean),
      };
    },

    async genres() {
      const body = await call<{ genres?: { genre?: { value?: string; songCount?: number; albumCount?: number }[] } }>('getGenres');
      return (body.genres?.genre ?? []).map((g) => ({ name: g.value ?? '', songCount: g.songCount, albumCount: g.albumCount }));
    },

    async albumList(type, size, offset) {
      const body = await call<{ albumList2?: { album?: SubAlbum[] } }>('getAlbumList2', { type, size, offset });
      return (body.albumList2?.album ?? []).map(album);
    },

    async songsByGenre(genre, count, offset) {
      const body = await call<{ songsByGenre?: { song?: SubChild[] } }>('getSongsByGenre', { genre, count, offset });
      return (body.songsByGenre?.song ?? []).map(song);
    },

    async randomSongs(size, filter) {
      const body = await call<{ randomSongs?: { song?: SubChild[] } }>('getRandomSongs', { size, genre: filter.genre, fromYear: filter.fromYear, toYear: filter.toYear });
      return (body.randomSongs?.song ?? []).map(song);
    },

    async search(query, limits) {
      const body = await call<{ searchResult3?: { artist?: SubArtist[]; album?: SubAlbum[]; song?: SubChild[] } }>('search3', {
        query: query.trim(),
        artistCount: limits.artistCount,
        albumCount: limits.albumCount,
        songCount: limits.songCount,
      });
      const hit = body.searchResult3 ?? {};
      return { artists: (hit.artist ?? []).map(artist), albums: (hit.album ?? []).map(album), songs: (hit.song ?? []).map(song) };
    },

    // Empty unless Last.fm is configured in Navidrome — a data gap, not a
    // capability gap, so these stay defined.
    async similarSongs(id, count) {
      const body = await find<{ similarSongs2?: { song?: SubChild[] } }>('getSimilarSongs2', { id, count });
      return (body?.similarSongs2?.song ?? []).map(song);
    },

    async topSongs(artistName, count) {
      const body = await call<{ topSongs?: { song?: SubChild[] } }>('getTopSongs', { artist: artistName, count });
      return (body.topSongs?.song ?? []).map(song);
    },

    async starred() {
      const body = await call<{ starred2?: { song?: SubChild[] } }>('getStarred2');
      return new Map((body.starred2?.song ?? []).map((s) => [s.id, s.starred ?? new Date(0).toISOString()]));
    },

    async starredSongs() {
      const body = await call<{ starred2?: { song?: SubChild[] } }>('getStarred2');
      return (body.starred2?.song ?? []).map(song);
    },

    async star(ids) {
      if (ids.length) await call('star', { id: ids });
    },

    async unstar(ids) {
      if (ids.length) await call('unstar', { id: ids });
    },

    async playlists() {
      const body = await call<{ playlists?: { playlist?: SubPlaylist[] } }>('getPlaylists');
      return Promise.all((body.playlists?.playlist ?? []).map(playlistFrom));
    },

    playlist: playlistById,

    async createPlaylist(name, songIds) {
      const body = await call<{ playlist?: SubPlaylist }>('createPlaylist', { name, songId: songIds });
      if (!body.playlist) throw new Error('Navidrome created a playlist it will not return');
      return playlistFrom(body.playlist);
    },

    async overwritePlaylist(id, name, songIds) {
      if (!(await playlistById(id))) return undefined;
      await call('createPlaylist', { playlistId: id, name, songId: songIds });
      return playlistById(id);
    },

    async updatePlaylist(id, patch) {
      if (!(await playlistById(id))) return undefined;
      await call('updatePlaylist', {
        playlistId: id,
        name: patch.name,
        comment: patch.comment,
        public: patch.public,
        songIdToAdd: patch.addIds,
        songIndexToRemove: patch.removeIndexes,
      });
      return playlistById(id);
    },

    async deletePlaylist(id) {
      if (!(await playlistById(id))) return false;
      await call('deletePlaylist', { id });
      return true;
    },

    // format=raw + maxBitRate=0 opts out of per-user transcoding, so the bytes
    // agree with the suffix/contentType/size reported at browse time.
    async stream(id) {
      return { url: url('/rest/stream', { id, format: 'raw', maxBitRate: 0 }) };
    },

    async coverArt(id, size) {
      return { url: url('/rest/getCoverArt', { id, size }) };
    },

    async lyrics(id) {
      let body: { lyricsList?: { structuredLyrics?: { displayArtist?: string; displayTitle?: string; line?: { value?: string }[] }[] } } | undefined;
      try {
        body = await find('getLyricsBySongId', { id });
      } catch (err) {
        if (!(err instanceof SubsonicError) || !UNIMPLEMENTED.includes(err.code)) throw err;
        // A server older than the songLyrics extension says nothing about the song.
        return (await find('getSong', { id })) ? null : undefined;
      }
      if (!body) return undefined;
      const set = (body.lyricsList?.structuredLyrics ?? []).find((l) => l.line?.some((n) => n.value));
      if (!set) return null;
      return { displayArtist: set.displayArtist, displayTitle: set.displayTitle, lines: (set.line ?? []).map((l) => l.value ?? '').filter(Boolean) };
    },

    async scrobble(id, opts) {
      await call('scrobble', { id, submission: opts.submission, time: opts.time });
    },

    async scanStatus() {
      const body = await call<{ scanStatus?: { scanning?: boolean; count?: number } }>('getScanStatus');
      return { scanning: body.scanStatus?.scanning === true, count: body.scanStatus?.count };
    },

    // Subsonic has no counts endpoint: getScanStatus carries the song total,
    // getArtists the artist count and an album sum.
    async stats() {
      const [scan, arts, genres] = await Promise.all([
        call<{ scanStatus?: { count?: number } }>('getScanStatus'),
        call<{ artists?: { index?: { artist?: SubArtist[] }[] } }>('getArtists'),
        call<{ genres?: { genre?: unknown[] } }>('getGenres'),
      ]);
      const all = (arts.artists?.index ?? []).flatMap((i) => i.artist ?? []);
      return {
        artists: all.length,
        albums: all.reduce((n, a) => n + (a.albumCount ?? 0), 0),
        songs: scan.scanStatus?.count ?? 0,
        genres: (genres.genres?.genre ?? []).length,
      };
    },
  };
});
