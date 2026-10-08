// One handler per Subsonic endpoint the SUB/WAVE controller calls
// (controller/src/music/subsonic.ts — treat that client as the spec when
// changing a response shape). Handlers never touch a backend: they call the
// active HostSource and render its Subsonic-shaped objects into envelopes.
//
// The active source can be swapped at runtime, so each handler receives the
// instance resolved ONCE for the request and uses it for the whole response.

import type { Request, Response } from 'express';
import type { AlbumListType } from '../sdk/types.js';
import { UnsupportedError, type HostSource, type SubPlaylist, type SubSong } from '../host/types.js';
import { MediaError } from '../host/media.js';
import { respondError, respondOk } from './respond.js';

export type Handler = (req: Request, res: Response, src: HostSource) => void | Promise<void>;

type Query = Record<string, unknown>;

/** Resolves when a backpressured response can take more, or is gone. */
function drainOrClose(res: Response): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

function qs(req: Request, key: string): string | undefined {
  const v = (req.query as Query)[key];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

function qi(req: Request, key: string, dflt: number): number {
  const raw = qs(req, key);
  if (raw === undefined || raw.trim() === '') return dflt;
  const v = Number(raw);
  return Number.isFinite(v) ? v : dflt;
}

// Repeated params (songId=a&songId=b) arrive as arrays; singles as strings.
function qa(req: Request, key: string): string[] {
  const v = (req.query as Query)[key];
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return [];
}

function qYear(req: Request, key: string): number | undefined {
  const v = qs(req, key);
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function qBool(req: Request, key: string): boolean | undefined {
  const v = qs(req, key);
  return v === undefined ? undefined : v === 'true' || v === '1';
}

const cap = (n: number, max = 500) => Math.max(0, Math.min(max, Math.floor(n)));

// A song gains `starred` while starred. One starred-map read per request
// (wrap.ts caches it briefly), then any number of songs decorated.
async function starDecorator(src: HostSource): Promise<(song: SubSong) => Record<string, unknown>> {
  let starred: Map<string, string>;
  try {
    starred = await src.starred();
  } catch {
    // Decoration is cosmetic; a failing favourites query must not fail a read.
    starred = new Map();
  }
  return (song) => {
    const at = starred.get(song.id);
    return at ? { ...song, starred: at } : { ...song };
  };
}

function playlistMeta(pl: SubPlaylist): Record<string, unknown> {
  return {
    id: pl.id,
    name: pl.name,
    comment: pl.comment,
    owner: pl.owner,
    public: pl.public,
    songCount: pl.songs.length,
    duration: pl.songs.reduce((a, s) => a + s.duration, 0),
    created: pl.created,
    changed: pl.changed,
  };
}

async function respondPlaylist(req: Request, res: Response, src: HostSource, pl: SubPlaylist): Promise<void> {
  const withStar = await starDecorator(src);
  respondOk(req, res, src.name, { playlist: { ...playlistMeta(pl), entry: pl.songs.map(withStar) } });
}

// Endpoints whose success path is raw bytes. A failure there must never be an
// HTTP 200 (see respond.ts); server.ts reads this to pick the crash status.
export const BINARY_ENDPOINTS = new Set(['stream', 'getCoverArt']);

function indexLetter(name: string): string {
  const c = name.trim().normalize('NFD').charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : '#';
}

export const handlers: Record<string, Handler> = {
  ping(req, res, src) {
    respondOk(req, res, src.name);
  },

  getLicense(req, res, src) {
    respondOk(req, res, src.name, { license: { valid: true } });
  },

  getOpenSubsonicExtensions(req, res, src) {
    const extensions = [
      { name: 'transcodeOffset', versions: [1] },
      { name: 'formPost', versions: [1] },
    ];
    if (src.capabilities.lyrics) extensions.push({ name: 'songLyrics', versions: [1] });
    if (src.capabilities.sonicSimilarity) extensions.push({ name: 'sonicSimilarity', versions: [1] });
    respondOk(req, res, src.name, { openSubsonicExtensions: extensions });
  },

  getMusicFolders(req, res, src) {
    respondOk(req, res, src.name, { musicFolders: { musicFolder: [{ id: 1, name: src.label }] } });
  },

  // --- browsing ---------------------------------------------------------------

  async getSong(req, res, src) {
    const id = qs(req, 'id');
    const song = id ? await src.song(id) : undefined;
    if (!song) return respondError(req, res, src.name, 70, 'Song not found');
    const withStar = await starDecorator(src);
    respondOk(req, res, src.name, { song: withStar(song) });
  },

  async getAlbum(req, res, src) {
    const id = qs(req, 'id');
    const hit = id ? await src.album(id) : undefined;
    if (!hit) return respondError(req, res, src.name, 70, 'Album not found');
    const withStar = await starDecorator(src);
    respondOk(req, res, src.name, { album: { ...hit.album, song: hit.songs.map(withStar) } });
  },

  async getArtist(req, res, src) {
    const id = qs(req, 'id');
    const hit = id ? await src.artist(id) : undefined;
    if (!hit) return respondError(req, res, src.name, 70, 'Artist not found');
    respondOk(req, res, src.name, { artist: { ...hit.artist, album: hit.albums } });
  },

  async getArtists(req, res, src) {
    const artists = await src.artists();
    const groups = new Map<string, typeof artists>();
    for (const a of [...artists].sort((x, y) => x.name.localeCompare(y.name))) {
      const letter = indexLetter(a.name);
      const list = groups.get(letter) ?? [];
      list.push(a);
      groups.set(letter, list);
    }
    respondOk(req, res, src.name, {
      artists: {
        ignoredArticles: '',
        index: [...groups.entries()].map(([name, artist]) => ({ name, artist })),
      },
    });
  },

  async getArtistInfo2(req, res, src) {
    const id = qs(req, 'id');
    if (!id) return respondError(req, res, src.name, 10, "Required parameter 'id' is missing");
    if (!src.capabilities.artistInfo) return respondOk(req, res, src.name, { artistInfo2: {} });
    const info = await src.artistInfo(id, cap(qi(req, 'count', 20), 50));
    if (!info) return respondError(req, res, src.name, 70, 'Artist not found');
    respondOk(req, res, src.name, {
      artistInfo2: {
        biography: info.biography,
        musicBrainzId: info.musicBrainzId,
        lastFmUrl: info.lastFmUrl,
        similarArtist: info.similarArtists,
        // Not in the strict spec; the controller's getArtistLastfmTags reads it when present.
        tag: info.tags.map((g) => ({ name: g.toLowerCase() })),
      },
    });
  },

  async getGenres(req, res, src) {
    respondOk(req, res, src.name, { genres: { genre: await src.genres() } });
  },

  async getAlbumList2(req, res, src) {
    const raw = qs(req, 'type');
    const type: AlbumListType = raw === 'newest' || raw === 'frequent' || raw === 'random' ? raw : 'alphabeticalByName';
    const size = cap(qi(req, 'size', 10));
    const offset = Math.max(0, Math.floor(qi(req, 'offset', 0)));
    respondOk(req, res, src.name, { albumList2: { album: await src.albumList(type, size, offset) } });
  },

  async getSongsByGenre(req, res, src) {
    const genre = qs(req, 'genre');
    if (!genre) return respondError(req, res, src.name, 10, "Required parameter 'genre' is missing");
    const withStar = await starDecorator(src);
    const songs = await src.songsByGenre(genre, cap(qi(req, 'count', 10)), Math.max(0, Math.floor(qi(req, 'offset', 0))));
    respondOk(req, res, src.name, { songsByGenre: { song: songs.map(withStar) } });
  },

  async getRandomSongs(req, res, src) {
    const withStar = await starDecorator(src);
    const songs = await src.randomSongs(cap(qi(req, 'size', 10)), {
      genre: qs(req, 'genre'),
      fromYear: qYear(req, 'fromYear'),
      toYear: qYear(req, 'toYear'),
    });
    respondOk(req, res, src.name, { randomSongs: { song: songs.map(withStar) } });
  },

  async search3(req, res, src) {
    const query = (qs(req, 'query') ?? '').replace(/^"(.*)"$/, '$1');
    const songCount = cap(qi(req, 'songCount', 20));
    const songOffset = Math.max(0, Math.floor(qi(req, 'songOffset', 0)));
    const artistCount = cap(qi(req, 'artistCount', 20));
    const artistOffset = Math.max(0, Math.floor(qi(req, 'artistOffset', 0)));
    const albumCount = cap(qi(req, 'albumCount', 20));
    const albumOffset = Math.max(0, Math.floor(qi(req, 'albumOffset', 0)));
    const { artists, albums, songs } = await src.search(query, {
      artistCount: artistOffset + artistCount,
      albumCount: albumOffset + albumCount,
      songCount: songOffset + songCount,
    });
    const withStar = await starDecorator(src);
    respondOk(req, res, src.name, {
      searchResult3: {
        artist: artists.slice(artistOffset, artistOffset + artistCount),
        album: albums.slice(albumOffset, albumOffset + albumCount),
        song: songs.slice(songOffset, songOffset + songCount).map(withStar),
      },
    });
  },

  // --- discovery --------------------------------------------------------------

  async getSimilarSongs2(req, res, src) {
    const id = qs(req, 'id');
    if (!id) return respondError(req, res, src.name, 10, "Required parameter 'id' is missing");
    const withStar = await starDecorator(src);
    const songs = await src.similarSongs(id, cap(qi(req, 'count', 50)));
    respondOk(req, res, src.name, { similarSongs2: { song: songs.map(withStar) } });
  },

  async getTopSongs(req, res, src) {
    const artist = qs(req, 'artist');
    if (!artist) return respondError(req, res, src.name, 10, "Required parameter 'artist' is missing");
    const withStar = await starDecorator(src);
    const songs = await src.topSongs(artist, cap(qi(req, 'count', 50)));
    respondOk(req, res, src.name, { topSongs: { song: songs.map(withStar) } });
  },

  async getSonicSimilarTracks(req, res, src) {
    if (!src.capabilities.sonicSimilarity) {
      return respondError(req, res, src.name, 70, 'sonicSimilarity is not supported by this music source');
    }
    const id = qs(req, 'id');
    if (!id) return respondError(req, res, src.name, 10, "Required parameter 'id' is missing");
    const withStar = await starDecorator(src);
    // Its own op, never getSimilarSongs2's under another name: the controller
    // weighs the two as separate picker signals (wrap.ts keeps the older
    // flag-only plugins answering from similarSongs). The plugin returns
    // neighbours in order; the extension wants a score per match, so a
    // descending one is synthesised from the rank. Nothing in the controller
    // thresholds on it.
    const sonicMatch = (await src.sonicSimilar(id, cap(qi(req, 'count', 20)))).map((song, i) => ({
      entry: withStar(song),
      similarity: Math.max(0.05, Math.round((0.95 - i * 0.03) * 100) / 100),
    }));
    respondOk(req, res, src.name, { sonicSimilarTracks: { sonicMatch } });
  },

  // --- stars ------------------------------------------------------------------

  async getStarred2(req, res, src) {
    const withStar = await starDecorator(src);
    const songs = await src.starredSongs();
    respondOk(req, res, src.name, { starred2: { artist: [], album: [], song: songs.map(withStar) } });
  },

  async star(req, res, src) {
    await src.star(qa(req, 'id'));
    respondOk(req, res, src.name);
  },

  async unstar(req, res, src) {
    await src.unstar(qa(req, 'id'));
    respondOk(req, res, src.name);
  },

  async scrobble(req, res, src) {
    const ids = qa(req, 'id');
    if (!ids.length) return respondError(req, res, src.name, 10, "Required parameter 'id' is missing");
    const submission = qBool(req, 'submission') ?? true;
    const timeRaw = qs(req, 'time');
    const time = timeRaw && Number.isFinite(Number(timeRaw)) ? Number(timeRaw) : undefined;
    for (const id of ids) await src.scrobble(id, { submission, time });
    respondOk(req, res, src.name);
  },

  async getScanStatus(req, res, src) {
    const status = await src.scanStatus();
    // A source that cannot tell is reported as an error rather than "not
    // scanning": the controller reads a failed call as "unknown", which is
    // the honest answer, and "not scanning" would be a claim.
    if (!status) return respondError(req, res, src.name, 0, `${src.label} does not report scan status`);
    respondOk(req, res, src.name, { scanStatus: status });
  },

  // --- playlists --------------------------------------------------------------

  async getPlaylists(req, res, src) {
    const playlists = await src.playlists();
    respondOk(req, res, src.name, { playlists: { playlist: playlists.map(playlistMeta) } });
  },

  async getPlaylist(req, res, src) {
    const id = qs(req, 'id');
    const pl = id ? await src.playlist(id) : undefined;
    if (!pl) return respondError(req, res, src.name, 70, 'Playlist not found');
    await respondPlaylist(req, res, src, pl);
  },

  async createPlaylist(req, res, src) {
    const playlistId = qs(req, 'playlistId');
    const name = qs(req, 'name');
    const songIds = qa(req, 'songId');
    if (playlistId) {
      const pl = await src.overwritePlaylist(playlistId, name, songIds);
      if (!pl) return respondError(req, res, src.name, 70, 'Playlist not found');
      return respondPlaylist(req, res, src, pl);
    }
    if (!name) return respondError(req, res, src.name, 10, "Required parameter 'name' is missing");
    await respondPlaylist(req, res, src, await src.createPlaylist(name, songIds));
  },

  async updatePlaylist(req, res, src) {
    const playlistId = qs(req, 'playlistId');
    if (!playlistId) return respondError(req, res, src.name, 10, "Required parameter 'playlistId' is missing");
    const pl = await src.updatePlaylist(playlistId, {
      name: qs(req, 'name'),
      comment: qs(req, 'comment'),
      public: qBool(req, 'public'),
      addIds: qa(req, 'songIdToAdd'),
      removeIndexes: qa(req, 'songIndexToRemove').map(Number).filter(Number.isFinite),
    });
    if (!pl) return respondError(req, res, src.name, 70, 'Playlist not found');
    respondOk(req, res, src.name);
  },

  async deletePlaylist(req, res, src) {
    const id = qs(req, 'id');
    if (!id || !(await src.deletePlaylist(id))) return respondError(req, res, src.name, 70, 'Playlist not found');
    respondOk(req, res, src.name);
  },

  // --- media ------------------------------------------------------------------

  async stream(req, res, src) {
    const id = qs(req, 'id');
    const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;
    let stream;
    try {
      stream = id ? await src.stream(id, range) : undefined;
    } catch (err) {
      if (err instanceof MediaError) return respondError(req, res, src.name, 0, err.message, err.httpStatus);
      throw err;
    }
    // 404, not the usual 200 envelope — see respond.ts.
    if (!stream) return respondError(req, res, src.name, 70, 'Song not found', 404);
    res.status(stream.status);
    for (const [k, v] of Object.entries(stream.headers)) res.setHeader(k, v);
    if (!stream.body) return void res.end();
    // The client going away (Liquidsoap timeout, analyzer cap reached) must
    // stop the upstream download too. It may already be gone: 'close' fires
    // only once, and a client can give up while stream() is still waiting on
    // the backend. A write to a closed response never drains, so the wait
    // ends on 'close' as well, or the upstream is held until it times out.
    const iterator = stream.body[Symbol.asyncIterator]();
    let closed = false;
    const stop = () => {
      if (closed) return;
      closed = true;
      void iterator.return?.();
    };
    res.on('close', stop);
    if (res.destroyed) stop();
    try {
      while (!closed) {
        const { done, value } = await iterator.next();
        if (done || closed) break;
        if (!res.write(value)) await drainOrClose(res);
      }
      res.end();
    } catch (err) {
      console.warn(`[rest] stream ${id} broke mid-body: ${(err as Error).message}`);
      res.destroy();
    }
  },

  async getCoverArt(req, res, src) {
    const id = qs(req, 'id');
    if (!id) return respondError(req, res, src.name, 10, "Required parameter 'id' is missing", 400);
    const size = cap(qi(req, 'size', 300), 2000) || 300;
    let art = await src.coverArt(id, size);
    // The controller asks for art by SONG id (/cover/:id is keyed by the
    // track on air). Many backends only hold an image on the album, so a song
    // without its own art falls back to the art id the source declared for it.
    if (!art) {
      const song = await src.song(id).catch(() => undefined);
      if (song?.coverArt && song.coverArt !== id) art = await src.coverArt(song.coverArt, size);
    }
    if (!art) return respondError(req, res, src.name, 70, 'Cover art not found', 404);
    res.status(200).setHeader('Content-Type', art.contentType);
    res.setHeader('Content-Length', String(art.data.byteLength));
    res.end(Buffer.from(art.data.buffer, art.data.byteOffset, art.data.byteLength));
  },

  async getLyricsBySongId(req, res, src) {
    const id = qs(req, 'id');
    if (!id) return respondError(req, res, src.name, 10, "Required parameter 'id' is missing");
    const lyr = await src.lyrics(id);
    if (lyr === undefined) return respondError(req, res, src.name, 70, 'Song not found');
    if (lyr === null) return respondOk(req, res, src.name, { lyricsList: {} });
    respondOk(req, res, src.name, {
      lyricsList: {
        structuredLyrics: [
          {
            displayArtist: lyr.displayArtist,
            displayTitle: lyr.displayTitle,
            lang: 'xxx',
            synced: false,
            line: lyr.lines.map((value) => ({ value })),
          },
        ],
      },
    });
  },
};

/** Map an error thrown by a handler to a Subsonic error code and message. */
export function describeError(err: unknown): { code: number; message: string } {
  if (err instanceof UnsupportedError) return { code: 0, message: err.message };
  return { code: 0, message: err instanceof Error ? err.message : 'internal error' };
}
