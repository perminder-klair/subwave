// Several sources served as one library — only when the operator turns on
// `merge`. Not a backend of its own: it implements HostSource by delegating to
// its children, so the Subsonic handlers never learn that more than one
// source exists.
//
// Every op is one of three shapes:
//
//   routed — the id names its owner (owns()), so exactly one child answers.
//            Ids never overlap between sources (ids.ts), which is what makes
//            this safe. A raw-id child owns whatever no prefixed child claims,
//            so prefixed children are always asked first.
//   merged — no id to route on, so every child answers and the lists are
//            interleaved (not concatenated: handlers slice, and concatenation
//            would hide every source after the first until it ran out).
//   writes — stars go to each id's owner; a new playlist goes to the owner of
//            the first song whose source can hold playlists, and ids that
//            backend cannot hold are dropped.
//
// A child that throws during a merge is logged and left out of that answer:
// one dead backend shrinks the library instead of failing the request.
// Routed ops surface the owner's error, since there is nothing to fall back to.
// The exception is an ENUMERATION (the alphabetical album list a library walk
// pages to the end): the controller treats what it walked as the whole
// catalogue and prunes the rest, so a list missing a source would delete that
// source's tracks. An enumeration is all-or-nothing.
//
// Nothing is deduplicated. The same album exposed by two sources appears twice
// under two ids; the admin UI says so before merging.

import type { AlbumListType, PlaylistPatch } from '../sdk/types.js';
import type { Capabilities, HostSource, SubAlbum, SubGenre } from './types.js';
import { UnsupportedError } from './types.js';

/** How long a merged album-list snapshot answers paged requests. */
const SNAPSHOT_TTL_MS = Number(process.env.ROUTER_SNAPSHOT_TTL_MS || 10 * 60_000);
const SNAPSHOT_PAGE = 500;
const SNAPSHOT_MAX = 200_000;
/** Album lists a library walk pages through completely (controller music/subsonic.ts getAlbumList). */
const ENUMERATIONS: ReadonlySet<AlbumListType> = new Set(['alphabeticalByName']);

export function interleave<T>(lists: T[][]): T[] {
  const out: T[] = [];
  const depth = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < depth; i++) for (const l of lists) if (i < l.length) out.push(l[i]!);
  return out;
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createComposite(children: HostSource[]): HostSource {
  if (children.length < 2) throw new Error('a merged set needs at least two sources');

  // Raw-id children own "everything else", so they are consulted last.
  const ordered = [...children].sort((a, b) => Number(a.rawIds) - Number(b.rawIds));
  if (children.filter((c) => c.rawIds).length > 1) throw new Error('only one source in a merged set can keep raw ids');
  const owner = (id: string): HostSource | undefined => ordered.find((c) => c.owns(id));

  // `complete`: every child must answer, or the whole op fails (see ENUMERATIONS).
  async function fanOut<T>(op: string, fn: (c: HostSource) => Promise<T>, { complete = false } = {}): Promise<T[]> {
    const settled = await Promise.allSettled(children.map(fn));
    const out: T[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') out.push(r.value);
      else if (complete) throw new Error(`${children[i]!.label} did not answer (${message(r.reason)}), so the merged library cannot be listed in full`);
      else if (!(r.reason instanceof UnsupportedError)) console.warn(`[merge] ${children[i]!.name}.${op} failed: ${message(r.reason)}`);
    });
    return out;
  }

  function ownedBy(target: HostSource, ids: string[], op: string): string[] {
    const kept = ids.filter((id) => owner(id) === target);
    if (kept.length !== ids.length) {
      console.warn(`[merge] ${op}: dropped ${ids.length - kept.length} id(s) that ${target.name} cannot hold`);
    }
    return kept;
  }

  // Each source gets only its own ids. A track on a source that cannot star
  // is skipped with a note rather than failing the stars that can land; only
  // a set where nothing can star reports the op as unsupported.
  async function fanStars(op: 'star' | 'unstar', ids: string[]): Promise<void> {
    if (!children.some((c) => c.capabilities.stars)) throw new UnsupportedError(name, op);
    await Promise.all(children.map(async (c) => {
      const own = ids.filter((id) => owner(id) === c);
      if (!own.length) return;
      if (!c.capabilities.stars) {
        console.warn(`[merge] ${op}: ${c.name} cannot hold stars; skipped ${own.length} id(s)`);
        return;
      }
      await c[op](own);
    }));
  }

  // A deterministic album list paged with an offset would otherwise cost
  // `offset + size` albums from EVERY child per page — quadratic over a
  // library walk, which pages the whole catalogue 500 at a time. Instead the
  // first page builds the merged ordering once (one pass per child) and later
  // pages slice it until the snapshot expires.
  const snapshots = new Map<AlbumListType, { at: number; albums: Promise<SubAlbum[]> }>();
  async function fullList(child: HostSource, type: AlbumListType): Promise<SubAlbum[]> {
    const out: SubAlbum[] = [];
    for (let offset = 0; offset < SNAPSHOT_MAX; offset += SNAPSHOT_PAGE) {
      const page = await child.albumList(type, SNAPSHOT_PAGE, offset);
      out.push(...page);
      if (page.length < SNAPSHOT_PAGE) break;
    }
    return out;
  }
  function snapshot(type: AlbumListType): Promise<SubAlbum[]> {
    const hit = snapshots.get(type);
    if (hit && Date.now() - hit.at < SNAPSHOT_TTL_MS) return hit.albums;
    const albums = fanOut('albumList', (c) => fullList(c, type), { complete: ENUMERATIONS.has(type) }).then(interleave);
    albums.catch(() => snapshots.delete(type));
    snapshots.set(type, { at: Date.now(), albums });
    return albums;
  }

  const caps = (key: keyof Capabilities) => children.some((c) => c.capabilities[key]);
  const capabilities: Capabilities = {
    sonicSimilarity: caps('sonicSimilarity'),
    artists: caps('artists'),
    artistInfo: caps('artistInfo'),
    similarSongs: caps('similarSongs'),
    topSongs: caps('topSongs'),
    lyrics: caps('lyrics'),
    stars: caps('stars'),
    playlists: caps('playlists'),
    scrobble: caps('scrobble'),
    scanStatus: caps('scanStatus'),
    stats: caps('stats'),
  };

  const name = children.map((c) => c.name).join('+');

  return {
    name,
    label: children.map((c) => c.label).join(' + '),
    capabilities,
    rawIds: false,
    owns: (id) => owner(id) !== undefined,

    // --- routed ---
    song: async (id) => owner(id)?.song(id),
    album: async (id) => owner(id)?.album(id),
    artist: async (id) => owner(id)?.artist(id),
    artistInfo: async (id, count) => owner(id)?.artistInfo(id, count),
    similarSongs: async (id, count) => (await owner(id)?.similarSongs(id, count)) ?? [],
    sonicSimilar: async (id, count) => (await owner(id)?.sonicSimilar(id, count)) ?? [],
    stream: async (id, range) => owner(id)?.stream(id, range),
    coverArt: async (id, size) => owner(id)?.coverArt(id, size),
    lyrics: async (id) => {
      const o = owner(id);
      return o ? o.lyrics(id) : undefined;
    },
    playlist: async (id) => owner(id)?.playlist(id),
    scrobble: async (id, o) => {
      await owner(id)?.scrobble(id, o);
    },

    // --- merged ---
    async artists() {
      return interleave(await fanOut('artists', (c) => c.artists()));
    },

    async search(query, limits) {
      const results = await fanOut('search', (c) => c.search(query, limits));
      return {
        artists: interleave(results.map((r) => r.artists)),
        albums: interleave(results.map((r) => r.albums)),
        songs: interleave(results.map((r) => r.songs)),
      };
    },

    async genres() {
      const merged = new Map<string, SubGenre>();
      for (const g of (await fanOut('genres', (c) => c.genres())).flat()) {
        const key = g.value.toLowerCase();
        const hit = merged.get(key);
        if (hit) {
          hit.songCount += g.songCount;
          hit.albumCount += g.albumCount;
        } else merged.set(key, { ...g });
      }
      return [...merged.values()].sort((a, b) => a.value.localeCompare(b.value));
    },

    async albumList(type, size, offset) {
      if (type === 'random') {
        return shuffle((await fanOut('albumList', (c) => c.albumList(type, size, 0))).flat()).slice(0, size);
      }
      return (await snapshot(type)).slice(offset, offset + size);
    },

    async songsByGenre(genre, count, offset) {
      const lists = await fanOut('songsByGenre', (c) => c.songsByGenre(genre, count + offset, 0));
      return interleave(lists).slice(offset, offset + count);
    },

    async randomSongs(size, filter) {
      return shuffle((await fanOut('randomSongs', (c) => c.randomSongs(size, filter))).flat()).slice(0, size);
    },

    async topSongs(artistName, count) {
      return interleave(await fanOut('topSongs', (c) => c.topSongs(artistName, count))).slice(0, count);
    },

    async starred() {
      const merged = new Map<string, string>();
      for (const m of await fanOut('starred', (c) => c.starred())) for (const [id, at] of m) merged.set(id, at);
      return merged;
    },

    async starredSongs() {
      return interleave(await fanOut('starredSongs', (c) => c.starredSongs()));
    },

    async playlists() {
      return (await fanOut('playlists', (c) => c.playlists())).flat();
    },

    async scanStatus() {
      const all = (await fanOut('scanStatus', (c) => c.scanStatus())).filter((s) => s !== null);
      if (!all.length) return null;
      return { scanning: all.some((s) => s!.scanning), count: all.reduce((n, s) => n + s!.count, 0) };
    },

    async stats() {
      const parts = await fanOut('stats', (c) => c.stats());
      if (!parts.length) throw new UnsupportedError(name, 'stats');
      // Genres overlap across sources, so the sum over-counts them; the exact
      // figure would mean merging every genre list on each health probe.
      return parts.reduce(
        (a, p) => ({ artists: a.artists + p.artists, albums: a.albums + p.albums, songs: a.songs + p.songs, genres: a.genres + p.genres }),
        { artists: 0, albums: 0, songs: 0, genres: 0 },
      );
    },

    // --- writes ---
    star: (ids) => fanStars('star', ids),
    unstar: (ids) => fanStars('unstar', ids),

    async createPlaylist(name_, songIds) {
      // The first song whose source can hold playlists decides; a source
      // without them (a music folder) must not refuse a playlist another
      // source in the set could take.
      const target = songIds.map(owner).find((o) => o?.capabilities.playlists) ?? children.find((c) => c.capabilities.playlists);
      if (!target) throw new UnsupportedError(name, 'createPlaylist');
      return target.createPlaylist(name_, ownedBy(target, songIds, 'createPlaylist'));
    },

    async overwritePlaylist(id, name_, songIds) {
      const target = owner(id);
      return target ? target.overwritePlaylist(id, name_, ownedBy(target, songIds, 'overwritePlaylist')) : undefined;
    },

    async updatePlaylist(id, patch: PlaylistPatch) {
      const target = owner(id);
      if (!target) return undefined;
      const addIds = patch.addIds?.length ? ownedBy(target, patch.addIds, 'updatePlaylist') : patch.addIds;
      return target.updatePlaylist(id, { ...patch, addIds });
    },

    async deletePlaylist(id) {
      return (await owner(id)?.deletePlaylist(id)) ?? false;
    },

    async close() {
      await Promise.all(children.map((c) => c.close()));
    },
  };
}

