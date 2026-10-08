// Navidrome (or any Subsonic server) as a router source. Navidrome IS a
// Subsonic server, so unlike the jellyfin and plex sources — which translate a
// foreign item model — this is a Subsonic client: the router in reverse. Most
// ops are one call whose parameters already match.
//
// It is the station's default source: a station on Navidrome reaches it
// through the router, and the controller sets `rawIds`, so the ids the station
// already stores keep resolving.
//
// Subsonic reports failure inside an HTTP 200, so call() reads the envelope's
// status rather than resp.status; a JSON body on the binary endpoints means the
// "audio" is an error message, which the router's media guard refuses.
//
// Sonic similarity is the one op that depends on the server rather than on
// this code: getSonicSimilarTracks exists only when the server advertises the
// OpenSubsonic `sonicSimilarity` extension (Navidrome >= 0.62 with a
// similarity plugin). The router reads capabilities off the object the factory
// returns, so the factory asks once, before it resolves, and defines
// `sonicSimilar` only on a yes.

import crypto from 'node:crypto';
import { defineSource, isVariousArtists, type Album, type Artist, type ArtistRef, type Playlist, type ReplayGain, type Song } from '../../sdk/index.js';

const NOT_FOUND = 70;
const UNIMPLEMENTED = [0, 30];
// The extensions probe runs inside construction, which the registry gives 15s
// before refusing the whole selection (registry.ts CONSTRUCT_TIMEOUT_MS), so it
// gets a third of that and is a "no" when it runs out.
const EXTENSIONS_PROBE_MS = Number(process.env.ROUTER_NAVIDROME_PROBE_MS) || 5_000;

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

// getSonicSimilarTracks wraps each song in a `sonicMatch` entry
// ({ entry: Child, similarity }), nested under `sonicSimilarTracks` or at the
// top of the envelope, and some servers inline the Child itself. The same three
// shapes the controller tolerates (music/subsonic.ts sonicSimilarSongs).
interface SonicMatch extends Partial<SubChild> {
  entry?: SubChild;
  song?: SubChild;
  similarity?: number;
}

interface SonicBody {
  sonicMatch?: SonicMatch[];
  sonicSimilarTracks?: { sonicMatch?: SonicMatch[] };
}

function sonicChildren(body: SonicBody | undefined): SubChild[] {
  const matches = body?.sonicMatch ?? body?.sonicSimilarTracks?.sonicMatch ?? [];
  if (!Array.isArray(matches)) return [];
  return matches
    .map((m) => m?.entry ?? m?.song ?? m)
    .filter((c): c is SubChild => typeof c?.id === 'string' && c.id !== '');
}

export default defineSource(async (ctx) => {
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
  async function call<T>(endpoint: string, params: Params = {}, init: RequestInit = {}): Promise<T> {
    const resp = await ctx.fetch(url(`/rest/${endpoint}`, params), init);
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

  // Any failure is a "no", never a failed build: the library still serves, and
  // the next rebuild (a save, a Rescan, a router restart) asks again. A server
  // that answered is quietly a no (one older than OpenSubsonic refuses the
  // endpoint); one that could not be reached is worth a line, since that no
  // lasts until the rebuild.
  async function advertisesSonicSimilarity(): Promise<boolean> {
    try {
      const body = await call<{ openSubsonicExtensions?: unknown }>('getOpenSubsonicExtensions', {}, { signal: AbortSignal.timeout(EXTENSIONS_PROBE_MS) });
      const exts = Array.isArray(body.openSubsonicExtensions) ? (body.openSubsonicExtensions as unknown[]) : [];
      return exts.some((e) => (typeof e === 'string' ? e : (e as { name?: unknown } | null)?.name) === 'sonicSimilarity');
    } catch (err) {
      if (!(err instanceof SubsonicError)) {
        ctx.log.warn(`could not read the server's OpenSubsonic extensions (${err instanceof Error ? err.message : String(err)}); sonic similarity is off until this source is rebuilt`);
      }
      return false;
    }
  }

  // Audio-based neighbours: a different endpoint, and a different picker
  // signal, from getSimilarSongs2's Last.fm ones — never answered by it.
  async function sonicSimilar(id: string, count: number): Promise<Song[]> {
    return sonicChildren(await find<SonicBody>('getSonicSimilarTracks', { id, count })).map(song);
  }

  const sonic = await advertisesSonicSimilarity();

  return {
    ...(sonic ? { sonicSimilar } : {}),

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
