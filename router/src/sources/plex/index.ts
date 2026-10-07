// Plex as a router source, over the Plex Media Server REST API (JSON via the
// Accept header). Duration ms → seconds, addedAt unix → ISO, a rating of 10 →
// starred, Plex audio playlists → playlists, /:/scrobble → plays.
//
// Two Plex behaviours shape this file, both silent when you get them wrong:
//   - Pagination needs X-Plex-Container-Start. A lone Size is ignored and the
//     whole library comes back without a totalSize (see paged()).
//   - Genres are indexed on albums and artists, never tracks. Filtering tracks
//     by `genre` matches nothing; the nested `album.genre` filter is the way in,
//     and a track's genres are inherited from its album.
//
// Gaps: no lyrics op, genre counts are zeros, no MusicBrainz ids, and similar
// songs prefer Plex's sonic analysis (/nearest) with a same-artist fallback.

import { defineSource, isVariousArtists, type Album, type Artist, type Playlist, type Song } from '../../sdk/index.js';
import { norm } from '../../util.js';

const isoFromUnix = (secs: number | undefined) => (secs ? new Date(secs * 1000).toISOString() : undefined);

interface PxTag {
  tag: string;
}

interface PxItem {
  ratingKey: string;
  type?: string;
  title?: string;
  summary?: string;
  parentRatingKey?: string;
  grandparentRatingKey?: string;
  parentTitle?: string;
  grandparentTitle?: string;
  originalTitle?: string;
  index?: number;
  parentIndex?: number;
  year?: number;
  // Plex sets `year` on albums but NOT on tracks — a track carries its album's
  // year as parentYear. Reading `year` alone gave every song year 0.
  parentYear?: number;
  originallyAvailableAt?: string;
  duration?: number;
  addedAt?: number;
  updatedAt?: number;
  viewCount?: number;
  userRating?: number;
  lastRatedAt?: number;
  leafCount?: number;
  childCount?: number;
  playlistItemID?: number;
  Genre?: PxTag[];
  Media?: { bitrate?: number; container?: string; Part?: { key?: string; size?: number; file?: string }[] }[];
}

interface PxDir {
  key: string;
  title?: string;
  type?: string;
  refreshing?: boolean;
}

interface PxMC {
  Metadata?: PxItem[];
  Directory?: PxDir[];
  totalSize?: number;
  machineIdentifier?: string;
}

const TYPE_ARTIST = 8;
const TYPE_ALBUM = 9;
const TYPE_TRACK = 10;

type Params = Record<string, string | number | undefined>;

export default defineSource((ctx) => {
  const base = String(ctx.config.url ?? '').replace(/\/+$/, '');
  const token = String(ctx.config.token ?? '');
  const sectionOverride = ctx.config.section ? String(ctx.config.section) : undefined;
  const headers = { 'X-Plex-Token': token, Accept: 'application/json' };

  function url(path: string, params: Params = {}): string {
    const u = new URL(base + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  async function px(path: string, params: Params = {}, init: RequestInit = {}): Promise<PxMC> {
    const resp = await ctx.fetch(url(path, params), { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
    if (!resp.ok) throw new Error(`Plex ${init.method || 'GET'} ${path} → HTTP ${resp.status}`);
    const text = await resp.text();
    if (!text.trimStart().startsWith('{')) return {}; // mutations may answer with XML or nothing
    return (JSON.parse(text) as { MediaContainer?: PxMC }).MediaContainer ?? {};
  }

  async function metadata(id: string): Promise<PxItem | undefined> {
    const resp = await ctx.fetch(url(`/library/metadata/${encodeURIComponent(id)}`), { headers });
    if (resp.status === 404 || resp.status === 400) return undefined;
    if (!resp.ok) throw new Error(`Plex GET /library/metadata/${id} → HTTP ${resp.status}`);
    return ((await resp.json()) as { MediaContainer?: PxMC }).MediaContainer?.Metadata?.[0];
  }

  let sectionPromise: Promise<string> | null = null;
  function sectionId(): Promise<string> {
    sectionPromise ??= (async () => {
      if (sectionOverride) return sectionOverride;
      const music = ((await px('/library/sections')).Directory ?? []).find((d) => d.type === 'artist');
      if (!music) throw new Error('Plex server has no music (artist-type) library section');
      return music.key;
    })();
    sectionPromise.catch(() => (sectionPromise = null));
    return sectionPromise;
  }

  let machinePromise: Promise<string> | null = null;
  function machineId(): Promise<string> {
    machinePromise ??= px('/identity').then((mc) => {
      if (!mc.machineIdentifier) throw new Error('Plex /identity returned no machineIdentifier');
      return mc.machineIdentifier;
    });
    machinePromise.catch(() => (machinePromise = null));
    return machinePromise;
  }

  const genreMaps = new Map<number, Promise<Map<string, { key: string; title: string }>>>();
  function genreMap(type: number) {
    let p = genreMaps.get(type);
    if (!p) {
      p = (async () => {
        const mc = await px(`/library/sections/${await sectionId()}/genre`, { type });
        return new Map(
          (mc.Directory ?? []).filter((d): d is PxDir & { title: string } => Boolean(d.title)).map((d) => [norm(d.title), { key: d.key, title: d.title }]),
        );
      })();
      p.catch(() => genreMaps.delete(type));
      genreMaps.set(type, p);
    }
    return p;
  }

  // Plex only paginates when X-Plex-Container-Start is present.
  const paged = (params: Params): Params =>
    params['X-Plex-Container-Size'] === undefined || params['X-Plex-Container-Start'] !== undefined
      ? params
      : { 'X-Plex-Container-Start': 0, ...params };

  async function sectionItems(params: Params): Promise<PxItem[]> {
    return (await px(`/library/sections/${await sectionId()}/all`, paged(params))).Metadata ?? [];
  }

  // Tracks carry no Genre of their own, so a song inherits its album's. One
  // listing of the section's albums yields every album's genres at once.
  let albumGenrePromise: Promise<Map<string, string[]>> | null = null;
  function albumGenres(): Promise<Map<string, string[]>> {
    albumGenrePromise ??= sectionItems({ type: TYPE_ALBUM }).then(
      (albums) => new Map(albums.map((a) => [a.ratingKey, (a.Genre ?? []).map((g) => g.tag)])),
    );
    albumGenrePromise.catch(() => (albumGenrePromise = null));
    return albumGenrePromise;
  }

  async function songs(list: PxItem[]): Promise<Song[]> {
    let gmap = await albumGenres();
    // An album added since the map was built: one rebuild picks it up.
    if (list.some((i) => i.parentRatingKey && !gmap.has(i.parentRatingKey))) {
      albumGenrePromise = null;
      gmap = await albumGenres();
    }
    return list.map((i) => song(i, gmap));
  }

  const song = (item: PxItem, gmap?: Map<string, string[]>): Song => {
    const media = item.Media?.[0];
    const part = media?.Part?.[0];
    const own = (item.Genre ?? []).map((g) => g.tag);
    return {
      id: item.ratingKey,
      title: item.title ?? '',
      album: item.parentTitle,
      albumId: item.parentRatingKey,
      // originalTitle is the track artist on a compilation; grandparent is the album artist.
      artist: item.originalTitle ?? item.grandparentTitle,
      artistId: item.grandparentRatingKey,
      albumArtists: item.grandparentRatingKey && item.grandparentTitle ? [{ id: item.grandparentRatingKey, name: item.grandparentTitle }] : undefined,
      track: item.index,
      discNumber: item.parentIndex,
      year: item.parentYear ?? item.year,
      genres: own.length ? own : (gmap?.get(item.parentRatingKey ?? '') ?? []),
      coverArt: item.parentRatingKey ?? item.ratingKey,
      size: part?.size,
      suffix: media?.container,
      duration: item.duration ? Math.round(item.duration / 1000) : undefined,
      bitRate: media?.bitrate,
      path: part?.file,
      playCount: item.viewCount,
      created: isoFromUnix(item.addedAt),
    };
  };

  const album = (item: PxItem): Album => {
    const a: Album = {
      id: item.ratingKey,
      name: item.title ?? '',
      artist: item.parentTitle,
      artistId: item.parentRatingKey,
      coverArt: item.ratingKey,
      songCount: item.leafCount,
      duration: item.duration ? Math.round(item.duration / 1000) : undefined,
      playCount: item.viewCount,
      created: isoFromUnix(item.addedAt),
      year: item.year,
      genres: (item.Genre ?? []).map((g) => g.tag),
    };
    if (item.originallyAvailableAt) {
      const d = new Date(item.originallyAvailableAt);
      if (!Number.isNaN(d.getTime())) {
        const parts = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
        a.releaseDate = parts;
        if (item.year && parts.year < item.year) a.originalReleaseDate = parts;
      }
    }
    if (isVariousArtists(item.parentTitle)) a.isCompilation = true;
    return a;
  };

  const artist = (item: PxItem): Artist => ({ id: item.ratingKey, name: item.title ?? '', coverArt: item.ratingKey, albumCount: item.childCount });

  async function playlistTracks(id: string): Promise<PxItem[]> {
    return ((await px(`/playlists/${id}/items`)).Metadata ?? []).filter((i) => i.type === 'track');
  }

  async function playlistMeta(id: string): Promise<PxItem | undefined> {
    const item = (await px(`/playlists/${encodeURIComponent(id)}`).catch(() => undefined))?.Metadata?.[0];
    return item?.type === 'playlist' ? item : undefined;
  }

  async function playlistFrom(item: PxItem): Promise<Playlist> {
    return {
      id: item.ratingKey,
      name: item.title ?? '',
      comment: item.summary,
      public: false,
      owner: 'plex',
      created: isoFromUnix(item.addedAt),
      changed: isoFromUnix(item.updatedAt ?? item.addedAt),
      songs: await songs(await playlistTracks(item.ratingKey)),
    };
  }

  const metadataUri = async (ids: string[]) =>
    `server://${await machineId()}/com.plexapp.plugins.library/library/metadata/${ids.join(',')}`;

  const rate = (id: string, rating: number) => px('/:/rate', { key: id, identifier: 'com.plexapp.plugins.library', rating }, { method: 'PUT' });

  const tracksByArtist = (artistKey: string, params: Params) => sectionItems({ type: TYPE_TRACK, 'artist.id': artistKey, ...params });

  return {
    capabilities: { sonicSimilarity: ctx.config.sonicSimilarity !== false },

    async song(id) {
      const item = await metadata(id);
      return item?.type === 'track' ? (await songs([item]))[0] : undefined;
    },

    async album(id) {
      const item = await metadata(id);
      if (item?.type !== 'album') return undefined;
      const tracks = ((await px(`/library/metadata/${id}/children`)).Metadata ?? []).filter((i) => i.type === 'track');
      return { album: album(item), songs: await songs(tracks) };
    },

    async artist(id) {
      const item = await metadata(id);
      if (item?.type !== 'artist') return undefined;
      const albums = ((await px(`/library/metadata/${id}/children`)).Metadata ?? []).filter((i) => i.type === 'album');
      return { artist: artist(item), albums: albums.map(album) };
    },

    async artists() {
      return (await sectionItems({ type: TYPE_ARTIST })).map(artist);
    },

    async artistInfo(id, count) {
      const item = await metadata(id);
      if (item?.type !== 'artist') return undefined;
      const tags = (item.Genre ?? []).map((g) => g.tag);
      let similar: Artist[] = [];
      const gid = tags[0] ? (await genreMap(TYPE_ARTIST)).get(norm(tags[0]))?.key : undefined;
      if (gid) {
        const peers = await sectionItems({ type: TYPE_ARTIST, genre: gid, 'X-Plex-Container-Size': count + 1 });
        similar = peers.filter((p) => p.ratingKey !== id).slice(0, count).map(artist);
      }
      return { biography: item.summary, lastFmUrl: `https://last.fm/music/${encodeURIComponent(item.title ?? '')}`, similarArtists: similar, tags };
    },

    async genres() {
      // The track genre index is always empty; the album index is the list.
      return [...(await genreMap(TYPE_ALBUM)).values()].map(({ title }) => ({ name: title }));
    },

    async albumList(type, size, offset) {
      const sort: Record<string, string> = { alphabeticalByName: 'titleSort:asc', newest: 'addedAt:desc', frequent: 'viewCount:desc', random: 'random' };
      return (await sectionItems({ type: TYPE_ALBUM, sort: sort[type], 'X-Plex-Container-Start': offset, 'X-Plex-Container-Size': size })).map(album);
    },

    async songsByGenre(genre, count, offset) {
      const gid = (await genreMap(TYPE_ALBUM)).get(norm(genre))?.key;
      if (!gid) return [];
      return songs(await sectionItems({ type: TYPE_TRACK, 'album.genre': gid, 'X-Plex-Container-Start': offset, 'X-Plex-Container-Size': count }));
    },

    async randomSongs(size, filter) {
      const years = filter.fromYear !== undefined || filter.toYear !== undefined;
      let gid: string | undefined;
      if (filter.genre) {
        gid = (await genreMap(TYPE_ALBUM)).get(norm(filter.genre))?.key;
        if (!gid) return [];
      }
      let pool = await songs(await sectionItems({ type: TYPE_TRACK, sort: 'random', 'album.genre': gid, 'X-Plex-Container-Size': years ? Math.min(500, size * 5) : size }));
      if (filter.fromYear !== undefined) pool = pool.filter((s) => (s.year ?? 0) >= filter.fromYear!);
      if (filter.toYear !== undefined) pool = pool.filter((s) => (s.year ?? 0) <= filter.toYear!);
      return pool.slice(0, size);
    },

    async search(query, limits) {
      const term = query.trim() || undefined;
      const bucket = (type: number, limit: number) => sectionItems({ type, title: term, 'X-Plex-Container-Size': Math.max(1, limit) });
      const [a, b, c] = await Promise.all([bucket(TYPE_ARTIST, limits.artistCount), bucket(TYPE_ALBUM, limits.albumCount), bucket(TYPE_TRACK, limits.songCount)]);
      return { artists: a.map(artist), albums: b.map(album), songs: await songs(c) };
    },

    async similarSongs(id, count) {
      const item = await metadata(id);
      if (!item) return [];
      if (item.type === 'artist') return songs(await tracksByArtist(id, { sort: 'random', 'X-Plex-Container-Size': count }));
      if (item.type !== 'track') return [];
      const nearest = await px(`/library/metadata/${id}/nearest`, { limit: count }).catch(() => ({}) as PxMC);
      const sonic = (nearest.Metadata ?? []).filter((i) => i.type === 'track' && i.ratingKey !== id);
      if (sonic.length) return songs(sonic.slice(0, count));
      if (!item.grandparentRatingKey) return [];
      const fallback = await tracksByArtist(item.grandparentRatingKey, { sort: 'random', 'X-Plex-Container-Size': count + 1 });
      return songs(fallback.filter((t) => t.ratingKey !== id).slice(0, count));
    },

    async topSongs(artistName, count) {
      const target = norm(artistName);
      const hit = (await sectionItems({ type: TYPE_ARTIST, title: artistName })).find((a) => norm(a.title) === target);
      if (!hit) return [];
      return songs(await tracksByArtist(hit.ratingKey, { sort: 'viewCount:desc', 'X-Plex-Container-Size': count }));
    },

    // starred == rated 10 (what star() sets); lastRatedAt is the real starred-at.
    async starred() {
      const list = await sectionItems({ type: TYPE_TRACK, userRating: 10 });
      return new Map(list.map((i) => [i.ratingKey, isoFromUnix(i.lastRatedAt ?? i.addedAt) ?? new Date(0).toISOString()]));
    },

    async starredSongs() {
      return songs(await sectionItems({ type: TYPE_TRACK, userRating: 10 }));
    },

    async star(ids) {
      for (const id of ids) await rate(id, 10);
    },

    async unstar(ids) {
      for (const id of ids) await rate(id, -1);
    },

    async playlists() {
      return Promise.all(((await px('/playlists', { playlistType: 'audio' })).Metadata ?? []).map(playlistFrom));
    },

    async playlist(id) {
      const item = await playlistMeta(id);
      return item && playlistFrom(item);
    },

    async createPlaylist(name, songIds) {
      const mc = await px('/playlists', { type: 'audio', title: name, smart: 0, uri: await metadataUri(songIds) }, { method: 'POST' });
      const item = mc.Metadata?.[0];
      if (!item) throw new Error('Plex created a playlist it will not return');
      return playlistFrom(item);
    },

    async overwritePlaylist(id, name, songIds) {
      if (!(await playlistMeta(id))) return undefined;
      for (const t of await playlistTracks(id)) {
        if (t.playlistItemID !== undefined) await px(`/playlists/${id}/items/${t.playlistItemID}`, {}, { method: 'DELETE' });
      }
      if (songIds.length) await px(`/playlists/${id}/items`, { uri: await metadataUri(songIds) }, { method: 'PUT' });
      if (name) await px(`/playlists/${id}`, { title: name }, { method: 'PUT' });
      const fresh = await playlistMeta(id);
      return fresh && playlistFrom(fresh);
    },

    async updatePlaylist(id, patch) {
      if (!(await playlistMeta(id))) return undefined;
      if (patch.name !== undefined || patch.comment !== undefined) {
        await px(`/playlists/${id}`, { title: patch.name, summary: patch.comment }, { method: 'PUT' });
      }
      if (patch.addIds?.length) await px(`/playlists/${id}/items`, { uri: await metadataUri(patch.addIds) }, { method: 'PUT' });
      if (patch.removeIndexes?.length) {
        const tracks = await playlistTracks(id);
        for (const i of patch.removeIndexes) {
          const entry = tracks[i]?.playlistItemID;
          if (entry !== undefined) await px(`/playlists/${id}/items/${entry}`, {}, { method: 'DELETE' });
        }
      }
      const fresh = await playlistMeta(id);
      return fresh && playlistFrom(fresh);
    },

    async deletePlaylist(id) {
      if (!(await playlistMeta(id))) return false;
      await px(`/playlists/${id}`, {}, { method: 'DELETE' });
      return true;
    },

    async stream(id) {
      const item = await metadata(id);
      const partKey = item?.type === 'track' ? item.Media?.[0]?.Part?.[0]?.key : undefined;
      return partKey ? { url: url(partKey), headers: { 'X-Plex-Token': token } } : undefined;
    },

    async coverArt(id, size) {
      return {
        url: url('/photo/:/transcode', { width: size, height: size, minSize: 1, upscale: 1, url: `/library/metadata/${id}/thumb` }),
        headers: { 'X-Plex-Token': token },
      };
    },

    async scrobble(id, opts) {
      if (!opts.submission) return;
      await px('/:/scrobble', { key: id, identifier: 'com.plexapp.plugins.library' });
    },

    async scanStatus() {
      const section = await sectionId();
      const dir = ((await px('/library/sections')).Directory ?? []).find((d) => d.key === section);
      return { scanning: dir?.refreshing === true };
    },

    async stats() {
      const count = async (type: number) => (await px(`/library/sections/${await sectionId()}/all`, paged({ type, 'X-Plex-Container-Size': 0 }))).totalSize ?? 0;
      const [artists, albums, tracks, gmap] = await Promise.all([count(TYPE_ARTIST), count(TYPE_ALBUM), count(TYPE_TRACK), genreMap(TYPE_ALBUM)]);
      return { artists, albums, songs: tracks, genres: gmap.size };
    },
  };
});
