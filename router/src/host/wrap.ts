// The enforcement layer around one plugin instance. Everything the station
// relies on but a plugin author could get wrong is applied here, once:
//
//   - ids are decoded on the way in and namespaced on the way out (ids.ts)
//   - every answer is normalised into the full Subsonic shape (normalize.ts)
//   - every op has a timeout, so a hung backend cannot stall a request forever
//   - streams and art pass the media guard (media.ts)
//   - optional ops degrade: a read the plugin lacks answers empty, a write it
//     lacks throws UnsupportedError, which the handlers turn into a Subsonic
//     error the controller already handles
//
// The router's op timeout sits under the controller's own 30s per-request cap
// (NAVIDROME_TIMEOUT_MS), so a slow backend surfaces as a router error the
// controller can log, rather than as the controller giving up first.

import type { PlaylistPatch, SourceLogger, SourcePlugin } from '../sdk/types.js';
import type { IdCodec } from './ids.js';
import { resolveArt, resolveStream } from './media.js';
import {
  list,
  normAlbum,
  normArtist,
  normArtistInfo,
  normGenre,
  normLyrics,
  normPlaylist,
  normSong,
} from './normalize.js';
import { UnsupportedError, type Capabilities, type HostSource } from './types.js';

export const OP_TIMEOUT_MS = Number(process.env.ROUTER_OP_TIMEOUT_MS || 25_000);
const STARRED_TTL_MS = 30_000;
const WARN_WINDOW_MS = 60_000;

export interface WrapOptions {
  name: string;
  label: string;
  codec: IdCodec;
  log: SourceLogger;
  rawIds?: boolean;
  opTimeoutMs?: number;
}

// A plugin with no `sonicSimilar` op may still claim the extension through the
// older `capabilities.sonicSimilarity` flag, served by `similarSongs` (the
// mock does). The op wins when both are present.
const legacySonic = (plugin: SourcePlugin) =>
  typeof plugin.sonicSimilar !== 'function' && Boolean(plugin.capabilities?.sonicSimilarity) && typeof plugin.similarSongs === 'function';

export function introspect(plugin: SourcePlugin): Capabilities {
  const has = (op: keyof SourcePlugin) => typeof plugin[op] === 'function';
  return {
    sonicSimilarity: has('sonicSimilar') || legacySonic(plugin),
    artists: has('artists'),
    artistInfo: has('artistInfo'),
    similarSongs: has('similarSongs'),
    topSongs: has('topSongs'),
    lyrics: has('lyrics'),
    stars: has('starred'),
    playlists: has('playlists'),
    scrobble: has('scrobble'),
    scanStatus: has('scanStatus'),
    stats: has('stats'),
  };
}

export function wrapPlugin(plugin: SourcePlugin, opts: WrapOptions): HostSource {
  const { name, codec, log } = opts;
  const timeoutMs = opts.opTimeoutMs ?? OP_TIMEOUT_MS;
  const caps = introspect(plugin);

  // One malformed row per page is common on a real library; one log line per
  // distinct problem per minute is enough to find it.
  const lastWarned = new Map<string, number>();
  const warn = (message: string) => {
    const now = Date.now();
    if ((lastWarned.get(message) ?? 0) > now - WARN_WINDOW_MS) return;
    lastWarned.set(message, now);
    log.warn(message);
  };

  async function timed<T>(op: string, run: () => Promise<T> | T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(run),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${name}.${op} timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const song = (raw: unknown) => normSong(raw, codec, warn);
  const album = (raw: unknown) => normAlbum(raw, codec, warn);
  const artist = (raw: unknown) => normArtist(raw, codec, warn);
  const playlist = (raw: unknown) => normPlaylist(raw, codec, warn);

  // Ids from the caller that this source cannot own are dropped, with a note:
  // the caller asked for something it is not getting.
  function natives(op: string, ids: string[]): string[] {
    const out: string[] = [];
    for (const id of ids) {
      const native = codec.decode(id);
      if (native !== undefined) out.push(native);
    }
    if (out.length !== ids.length) warn(`${op}: ignored ${ids.length - out.length} id(s) that are not ${name}'s`);
    return out;
  }

  function require<K extends keyof SourcePlugin>(op: K): NonNullable<SourcePlugin[K]> {
    const fn = plugin[op];
    if (typeof fn !== 'function') throw new UnsupportedError(name, String(op));
    return (fn as (...a: unknown[]) => unknown).bind(plugin) as NonNullable<SourcePlugin[K]>;
  }

  let starredCache: { at: number; map: Map<string, string> } | null = null;

  async function starredMap(): Promise<Map<string, string>> {
    if (!plugin.starred) return new Map();
    if (starredCache && Date.now() - starredCache.at < STARRED_TTL_MS) return starredCache.map;
    const raw = await timed('starred', () => plugin.starred!());
    const entries = raw instanceof Map ? [...raw.entries()] : Object.entries(raw ?? {});
    const map = new Map<string, string>();
    for (const [native, at] of entries) {
      const id = codec.encode(String(native));
      if (!id) continue;
      const d = new Date(String(at));
      map.set(id, Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString());
    }
    starredCache = { at: Date.now(), map };
    return map;
  }

  const source: HostSource = {
    name,
    label: opts.label,
    capabilities: caps,
    rawIds: opts.rawIds ?? false,
    owns: (id) => codec.owns(id),

    async song(id) {
      const native = codec.decode(id);
      if (native === undefined) return undefined;
      return song(await timed('song', () => plugin.song(native)));
    },

    async album(id) {
      const native = codec.decode(id);
      if (native === undefined) return undefined;
      const hit = await timed('album', () => plugin.album(native));
      const a = hit && album(hit.album);
      if (!a) return undefined;
      const songs = list(hit.songs, song);
      // The album object's counts are derived when the plugin did not send them.
      if (!a.songCount) a.songCount = songs.length;
      if (!a.duration) a.duration = songs.reduce((n, s) => n + s.duration, 0);
      return { album: a, songs };
    },

    async artist(id) {
      const native = codec.decode(id);
      if (native === undefined) return undefined;
      const hit = await timed('artist', () => plugin.artist(native));
      const a = hit && artist(hit.artist);
      if (!a) return undefined;
      const albums = list(hit.albums, album);
      if (!a.albumCount) a.albumCount = albums.length;
      return { artist: a, albums };
    },

    async artists() {
      if (!plugin.artists) throw new UnsupportedError(name, 'artists');
      return list(await timed('artists', () => plugin.artists!()), artist);
    },

    async artistInfo(id, count) {
      const native = codec.decode(id);
      if (native === undefined || !plugin.artistInfo) return undefined;
      return normArtistInfo(await timed('artistInfo', () => plugin.artistInfo!(native, count)), codec, warn);
    },

    async genres() {
      const genres = list(await timed('genres', () => plugin.genres()), normGenre);
      return genres.sort((a, b) => a.value.localeCompare(b.value));
    },

    async albumList(type, size, offset) {
      return list(await timed('albumList', () => plugin.albumList(type, size, offset)), album);
    },

    async songsByGenre(genre, count, offset) {
      return list(await timed('songsByGenre', () => plugin.songsByGenre(genre, count, offset)), song);
    },

    async randomSongs(size, filter) {
      return list(await timed('randomSongs', () => plugin.randomSongs(size, filter)), song);
    },

    async search(query, limits) {
      const hit = await timed('search', () => plugin.search(query, limits));
      return {
        artists: list(hit?.artists, artist),
        albums: list(hit?.albums, album),
        songs: list(hit?.songs, song),
      };
    },

    async similarSongs(id, count) {
      const native = codec.decode(id);
      if (native === undefined || !plugin.similarSongs) return [];
      return list(await timed('similarSongs', () => plugin.similarSongs!(native, count)), song);
    },

    async sonicSimilar(id, count) {
      const native = codec.decode(id);
      if (native === undefined) return [];
      if (plugin.sonicSimilar) return list(await timed('sonicSimilar', () => plugin.sonicSimilar!(native, count)), song);
      if (legacySonic(plugin)) return list(await timed('similarSongs', () => plugin.similarSongs!(native, count)), song);
      return [];
    },

    async topSongs(artistName, count) {
      if (!plugin.topSongs) return [];
      return list(await timed('topSongs', () => plugin.topSongs!(artistName, count)), song);
    },

    starred: starredMap,

    async starredSongs() {
      if (!plugin.starredSongs) {
        if (!plugin.starred) return [];
        // A source that knows its starred ids but has no listing op still
        // answers getStarred2: resolve each id.
        const ids = [...(await starredMap()).keys()];
        const songs = await Promise.all(ids.map((id) => source.song(id).catch(() => undefined)));
        return songs.filter((s) => s !== undefined);
      }
      return list(await timed('starredSongs', () => plugin.starredSongs!()), song);
    },

    async star(ids) {
      const fn = require('star');
      const own = natives('star', ids);
      starredCache = null;
      if (own.length) await timed('star', () => fn(own));
    },

    async unstar(ids) {
      const fn = require('unstar');
      const own = natives('unstar', ids);
      starredCache = null;
      if (own.length) await timed('unstar', () => fn(own));
    },

    async playlists() {
      if (!plugin.playlists) return [];
      return list(await timed('playlists', () => plugin.playlists!()), playlist);
    },

    async playlist(id) {
      const native = codec.decode(id);
      if (native === undefined || !plugin.playlist) return undefined;
      return playlist(await timed('playlist', () => plugin.playlist!(native)));
    },

    async createPlaylist(name_, songIds) {
      const fn = require('createPlaylist');
      const created = playlist(await timed('createPlaylist', () => fn(name_, natives('createPlaylist', songIds))));
      if (!created) throw new Error(`${name} created a playlist it could not describe`);
      return created;
    },

    async overwritePlaylist(id, name_, songIds) {
      const fn = require('overwritePlaylist');
      const native = codec.decode(id);
      if (native === undefined) return undefined;
      return playlist(await timed('overwritePlaylist', () => fn(native, name_, natives('overwritePlaylist', songIds))));
    },

    async updatePlaylist(id, patch: PlaylistPatch) {
      const fn = require('updatePlaylist');
      const native = codec.decode(id);
      if (native === undefined) return undefined;
      const addIds = patch.addIds ? natives('updatePlaylist', patch.addIds) : undefined;
      return playlist(await timed('updatePlaylist', () => fn(native, { ...patch, addIds })));
    },

    async deletePlaylist(id) {
      const fn = require('deletePlaylist');
      const native = codec.decode(id);
      if (native === undefined) return false;
      return Boolean(await timed('deletePlaylist', () => fn(native)));
    },

    async stream(id, range) {
      const native = codec.decode(id);
      if (native === undefined) return undefined;
      const result = await timed('stream', () => plugin.stream(native, { range }));
      return result ? resolveStream(result, range) : undefined;
    },

    async coverArt(id, size) {
      const native = codec.decode(id);
      if (native === undefined) return undefined;
      const result = await timed('coverArt', () => plugin.coverArt(native, size));
      return result ? resolveArt(result) : undefined;
    },

    async lyrics(id) {
      const native = codec.decode(id);
      if (native === undefined) return undefined;
      if (!plugin.lyrics) return (await source.song(id)) ? null : undefined;
      return normLyrics(await timed('lyrics', () => plugin.lyrics!(native)));
    },

    async scrobble(id, o) {
      const native = codec.decode(id);
      // A scrobble is a courtesy signal; a source without one simply does not
      // record plays, the same as a Subsonic server with scrobbling off.
      if (native === undefined || !plugin.scrobble) return;
      await timed('scrobble', () => plugin.scrobble!(native, o));
    },

    async scanStatus() {
      if (!plugin.scanStatus) return null;
      const s = await timed('scanStatus', () => plugin.scanStatus!());
      return { scanning: Boolean(s?.scanning), count: Math.max(0, Math.round(Number(s?.count) || 0)) };
    },

    async stats() {
      if (!plugin.stats) throw new UnsupportedError(name, 'stats');
      const s = await timed('stats', () => plugin.stats!());
      const n = (v: unknown) => Math.max(0, Math.round(Number(v) || 0));
      return { artists: n(s?.artists), albums: n(s?.albums), songs: n(s?.songs), genres: n(s?.genres) };
    },

    async close() {
      try {
        await plugin.close?.();
      } catch (err) {
        log.warn(`close failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
  return source;
}

