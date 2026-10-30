// Jellyfin as a router source, over its REST API. Maps Jellyfin's item model
// onto the canonical one: RunTimeTicks ÷ 10⁷ → seconds, favourites → stars,
// Jellyfin playlists → playlists, played-items → scrobbles.
//
// Known gaps, reported honestly rather than invented: getGenres counts are
// zeros (no cheap per-genre count), starred-at is the item's creation date
// (Jellyfin does not record when an item was favourited), a playlist's
// `public` flag is accepted and ignored, and there is no ReplayGain.

import { defineSource, isVariousArtists, type Album, type Artist, type ArtistRef, type Playlist, type Song } from '../../sdk/index.js';

const TICKS_PER_SEC = 10_000_000;
const ticksToSec = (ticks: number | undefined) => (ticks ? Math.round(ticks / TICKS_PER_SEC) : 0);

const AUDIO_CONTAINERS = ['mp3', 'flac', 'ogg', 'opus', 'm4a', 'aac', 'wav', 'wma', 'webm', 'aiff'];

interface JfRef {
  Id: string;
  Name: string;
}

interface JfItem {
  Id: string;
  Name?: string;
  Type?: string;
  Overview?: string;
  RunTimeTicks?: number;
  Album?: string;
  AlbumId?: string;
  AlbumArtist?: string;
  AlbumArtists?: JfRef[];
  ArtistItems?: JfRef[];
  IndexNumber?: number;
  ParentIndexNumber?: number;
  ProductionYear?: number;
  PremiereDate?: string;
  Genres?: string[];
  Path?: string;
  DateCreated?: string;
  ChildCount?: number;
  UserData?: { PlayCount?: number; IsFavorite?: boolean };
  MediaSources?: { Size?: number; Bitrate?: number; Container?: string }[];
  ProviderIds?: Record<string, string>;
  PlaylistItemId?: string;
}

interface JfItemsResult {
  Items: JfItem[];
  TotalRecordCount: number;
}

const ITEM_FIELDS = 'Genres,DateCreated,Path,MediaSources,Overview,ChildCount,PremiereDate,ProviderIds';

const refs = (v: JfRef[] | undefined): ArtistRef[] | undefined => {
  const out = (v ?? []).filter((r) => r.Id && r.Name).map((r) => ({ id: r.Id, name: r.Name }));
  return out.length ? out : undefined;
};

// Jellyfin reports a container list for some formats ("mov,mp4,m4a,3gp,…");
// prefer the entry that names an audio format.
function containerOf(raw: string | undefined): string {
  const parts = (raw ?? '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  return parts.find((p) => AUDIO_CONTAINERS.includes(p)) ?? parts[0] ?? 'mp3';
}

function dateParts(iso: string | undefined) {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export default defineSource((ctx) => {
  const base = String(ctx.config.url ?? '').replace(/\/+$/, '');
  const apiKey = String(ctx.config.apiKey ?? '');
  const wantedUser = ctx.config.user ? String(ctx.config.user) : undefined;
  const headers = { 'X-Emby-Token': apiKey };

  function url(path: string, params: Record<string, string | number | undefined> = {}): string {
    const u = new URL(base + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  async function jf<T>(path: string, params: Record<string, string | number | undefined> = {}, init: RequestInit = {}): Promise<T> {
    const resp = await ctx.fetch(url(path, params), { ...init, headers: { ...headers, 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) } });
    if (!resp.ok) throw new Error(`Jellyfin ${init.method || 'GET'} ${path} → HTTP ${resp.status} ${await resp.text().catch(() => '')}`.trim());
    if (resp.status === 204) return undefined as T;
    const text = await resp.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  // Resolved once: favourites and playlists are scoped to this user.
  let userPromise: Promise<{ id: string; name: string }> | null = null;
  function user(): Promise<{ id: string; name: string }> {
    userPromise ??= (async () => {
      const users = await jf<JfRef[]>('/Users');
      if (!users.length) throw new Error('Jellyfin reports no users');
      const picked = wantedUser ? users.find((u) => u.Name.toLowerCase() === wantedUser.toLowerCase()) : users[0];
      if (!picked) throw new Error(`Jellyfin user '${wantedUser}' not found`);
      return { id: picked.Id, name: picked.Name };
    })();
    userPromise.catch(() => (userPromise = null));
    return userPromise;
  }

  async function itemById(id: string): Promise<JfItem | undefined> {
    const { id: userId } = await user();
    const resp = await ctx.fetch(url(`/Users/${userId}/Items/${encodeURIComponent(id)}`, { Fields: ITEM_FIELDS }), { headers });
    if (resp.status === 404 || resp.status === 400) return undefined;
    if (!resp.ok) throw new Error(`Jellyfin GET /Items/${id} → HTTP ${resp.status}`);
    return (await resp.json()) as JfItem;
  }

  async function items(params: Record<string, string | number | undefined>): Promise<JfItemsResult> {
    const { id: userId } = await user();
    return jf<JfItemsResult>('/Items', { userId, Recursive: 'true', Fields: ITEM_FIELDS, ...params });
  }

  const song = (item: JfItem): Song => {
    const media = item.MediaSources?.[0];
    const container = containerOf(media?.Container);
    const artist = item.ArtistItems?.[0];
    return {
      id: item.Id,
      title: item.Name ?? '',
      album: item.Album,
      albumId: item.AlbumId,
      artist: artist?.Name ?? item.AlbumArtist,
      artistId: artist?.Id,
      artists: refs(item.ArtistItems),
      albumArtists: refs(item.AlbumArtists),
      track: item.IndexNumber,
      discNumber: item.ParentIndexNumber,
      year: item.ProductionYear,
      genres: item.Genres,
      coverArt: item.AlbumId ?? item.Id,
      size: media?.Size,
      suffix: container,
      duration: ticksToSec(item.RunTimeTicks),
      bitRate: media?.Bitrate ? Math.round(media.Bitrate / 1000) : undefined,
      path: item.Path,
      playCount: item.UserData?.PlayCount,
      created: item.DateCreated,
      musicBrainzId: item.ProviderIds?.MusicBrainzTrack,
    };
  };

  const album = (item: JfItem): Album => {
    const artist = item.AlbumArtists?.[0] ?? item.ArtistItems?.[0];
    const a: Album = {
      id: item.Id,
      name: item.Name ?? '',
      artist: artist?.Name ?? item.AlbumArtist,
      artistId: artist?.Id,
      artists: refs(item.AlbumArtists),
      coverArt: item.Id,
      songCount: item.ChildCount,
      duration: ticksToSec(item.RunTimeTicks),
      playCount: item.UserData?.PlayCount,
      created: item.DateCreated,
      year: item.ProductionYear,
      genres: item.Genres,
      releaseDate: dateParts(item.PremiereDate),
      musicBrainzId: item.ProviderIds?.MusicBrainzAlbum,
    };
    // A PremiereDate before the scalar year is Jellyfin's reissue signal.
    const premiere = dateParts(item.PremiereDate);
    if (premiere && item.ProductionYear && premiere.year < item.ProductionYear) a.originalReleaseDate = premiere;
    // No compilation flag in the Jellyfin item: the albumartist convention.
    if (isVariousArtists(a.artist)) a.isCompilation = true;
    return a;
  };

  const artist = (item: JfItem): Artist => ({
    id: item.Id,
    name: item.Name ?? '',
    coverArt: item.Id,
    albumCount: item.ChildCount,
    musicBrainzId: item.ProviderIds?.MusicBrainzArtist,
  });

  async function playlistSongs(id: string): Promise<{ songs: Song[]; entryIds: (string | undefined)[] }> {
    const { id: userId } = await user();
    const result = await jf<JfItemsResult>(`/Playlists/${id}/Items`, { userId, Fields: ITEM_FIELDS });
    return { songs: result.Items.map(song), entryIds: result.Items.map((i) => i.PlaylistItemId) };
  }

  async function playlistFrom(item: JfItem): Promise<Playlist> {
    const [{ name: owner }, { songs }] = await Promise.all([user(), playlistSongs(item.Id)]);
    return { id: item.Id, name: item.Name ?? '', comment: item.Overview, public: false, owner, created: item.DateCreated, changed: item.DateCreated, songs };
  }

  async function playlistItem(id: string): Promise<JfItem | undefined> {
    const item = await itemById(id);
    return item?.Type === 'Playlist' ? item : undefined;
  }

  // Jellyfin's item update replaces the item, so patch the fetched DTO.
  async function updateItem(id: string, patch: Partial<JfItem>): Promise<void> {
    const { id: userId } = await user();
    const item = await jf<JfItem>(`/Users/${userId}/Items/${id}`);
    await jf<void>(`/Items/${id}`, {}, { method: 'POST', body: JSON.stringify({ ...item, ...patch }) });
  }

  return {
    async song(id) {
      const item = await itemById(id);
      return item?.Type === 'Audio' ? song(item) : undefined;
    },

    async album(id) {
      const item = await itemById(id);
      if (item?.Type !== 'MusicAlbum') return undefined;
      const children = await items({ ParentId: item.Id, IncludeItemTypes: 'Audio', SortBy: 'ParentIndexNumber,IndexNumber' });
      return { album: album(item), songs: children.Items.map(song) };
    },

    async artist(id) {
      const item = await itemById(id);
      if (item?.Type !== 'MusicArtist') return undefined;
      const albums = await items({ AlbumArtistIds: item.Id, IncludeItemTypes: 'MusicAlbum', SortBy: 'ProductionYear,SortName' });
      return { artist: artist(item), albums: albums.Items.map(album) };
    },

    async artists() {
      const { id: userId } = await user();
      const result = await jf<JfItemsResult>('/Artists/AlbumArtists', { userId, Recursive: 'true', Fields: 'ProviderIds,ChildCount' });
      return result.Items.map(artist);
    },

    async artistInfo(id, count) {
      const item = await itemById(id);
      if (item?.Type !== 'MusicArtist') return undefined;
      const { id: userId } = await user();
      const similar = await jf<JfItemsResult>(`/Items/${id}/Similar`, { userId, limit: count });
      return {
        biography: item.Overview,
        musicBrainzId: item.ProviderIds?.MusicBrainzArtist,
        lastFmUrl: `https://last.fm/music/${encodeURIComponent(item.Name ?? '')}`,
        similarArtists: similar.Items.filter((i) => i.Type === 'MusicArtist').map(artist),
        tags: item.Genres ?? [],
      };
    },

    async genres() {
      const { id: userId } = await user();
      const result = await jf<JfItemsResult>('/MusicGenres', { userId, Recursive: 'true' });
      return result.Items.map((g) => ({ name: g.Name ?? '' }));
    },

    async albumList(type, size, offset) {
      const sort: Record<string, { SortBy: string; SortOrder?: string }> = {
        alphabeticalByName: { SortBy: 'SortName' },
        newest: { SortBy: 'DateCreated', SortOrder: 'Descending' },
        frequent: { SortBy: 'PlayCount', SortOrder: 'Descending' },
        random: { SortBy: 'Random' },
      };
      const result = await items({ IncludeItemTypes: 'MusicAlbum', StartIndex: offset, Limit: size, ...sort[type] });
      return result.Items.map(album);
    },

    async songsByGenre(genre, count, offset) {
      const result = await items({ IncludeItemTypes: 'Audio', Genres: genre, StartIndex: offset, Limit: count });
      return result.Items.map(song);
    },

    async randomSongs(size, filter) {
      // Year bounds have no Jellyfin query param: over-fetch and filter.
      const years = filter.fromYear !== undefined || filter.toYear !== undefined;
      const result = await items({ IncludeItemTypes: 'Audio', SortBy: 'Random', Limit: years ? Math.min(500, size * 5) : size, Genres: filter.genre });
      let pool = result.Items.map(song);
      if (filter.fromYear !== undefined) pool = pool.filter((s) => (s.year ?? 0) >= filter.fromYear!);
      if (filter.toYear !== undefined) pool = pool.filter((s) => (s.year ?? 0) <= filter.toYear!);
      return pool.slice(0, size);
    },

    async search(query, limits) {
      const term = query.trim() || undefined;
      const bucket = (types: string, limit: number) => items({ IncludeItemTypes: types, SearchTerm: term, Limit: Math.max(1, limit) });
      const [artists, albums, songs] = await Promise.all([
        bucket('MusicArtist', limits.artistCount),
        bucket('MusicAlbum', limits.albumCount),
        bucket('Audio', limits.songCount),
      ]);
      return { artists: artists.Items.map(artist), albums: albums.Items.map(album), songs: songs.Items.map(song) };
    },

    async similarSongs(id, count) {
      const { id: userId } = await user();
      const similar = await jf<JfItemsResult>(`/Items/${id}/Similar`, { userId, limit: count, Fields: ITEM_FIELDS });
      return similar.Items.filter((i) => i.Type === 'Audio').map(song);
    },

    async topSongs(artistName, count) {
      const found = await items({ IncludeItemTypes: 'MusicArtist', SearchTerm: artistName, Limit: 1 });
      const hit = found.Items[0];
      if (!hit) return [];
      const top = await items({ ArtistIds: hit.Id, IncludeItemTypes: 'Audio', SortBy: 'PlayCount', SortOrder: 'Descending', Limit: count });
      return top.Items.map(song);
    },

    async starred() {
      const result = await items({ IncludeItemTypes: 'Audio', Filters: 'IsFavorite' });
      return new Map(result.Items.map((i) => [i.Id, i.DateCreated ?? new Date(0).toISOString()]));
    },

    async starredSongs() {
      return (await items({ IncludeItemTypes: 'Audio', Filters: 'IsFavorite' })).Items.map(song);
    },

    async star(ids) {
      const { id: userId } = await user();
      for (const id of ids) await jf(`/Users/${userId}/FavoriteItems/${id}`, {}, { method: 'POST' });
    },

    async unstar(ids) {
      const { id: userId } = await user();
      for (const id of ids) await jf(`/Users/${userId}/FavoriteItems/${id}`, {}, { method: 'DELETE' });
    },

    async playlists() {
      const result = await items({ IncludeItemTypes: 'Playlist' });
      return Promise.all(result.Items.map(playlistFrom));
    },

    async playlist(id) {
      const item = await playlistItem(id);
      return item && playlistFrom(item);
    },

    async createPlaylist(name, songIds) {
      const { id: userId } = await user();
      const created = await jf<{ Id: string }>('/Playlists', {}, { method: 'POST', body: JSON.stringify({ Name: name, Ids: songIds, UserId: userId, MediaType: 'Audio' }) });
      const item = await playlistItem(created.Id);
      if (!item) throw new Error('Jellyfin created a playlist it will not return');
      return playlistFrom(item);
    },

    async overwritePlaylist(id, name, songIds) {
      if (!(await playlistItem(id))) return undefined;
      const { id: userId } = await user();
      const existing = (await playlistSongs(id)).entryIds.filter((e): e is string => Boolean(e));
      if (existing.length) await jf(`/Playlists/${id}/Items`, { EntryIds: existing.join(',') }, { method: 'DELETE' });
      if (songIds.length) await jf(`/Playlists/${id}/Items`, { ids: songIds.join(','), userId }, { method: 'POST' });
      if (name) await updateItem(id, { Name: name });
      const fresh = await playlistItem(id);
      return fresh && playlistFrom(fresh);
    },

    async updatePlaylist(id, patch) {
      if (!(await playlistItem(id))) return undefined;
      const { id: userId } = await user();
      if (patch.name !== undefined || patch.comment !== undefined) {
        await updateItem(id, { ...(patch.name !== undefined ? { Name: patch.name } : {}), ...(patch.comment !== undefined ? { Overview: patch.comment } : {}) });
      }
      if (patch.addIds?.length) await jf(`/Playlists/${id}/Items`, { ids: patch.addIds.join(','), userId }, { method: 'POST' });
      if (patch.removeIndexes?.length) {
        const { entryIds } = await playlistSongs(id);
        const remove = patch.removeIndexes.map((i) => entryIds[i]).filter((e): e is string => Boolean(e));
        if (remove.length) await jf(`/Playlists/${id}/Items`, { EntryIds: remove.join(',') }, { method: 'DELETE' });
      }
      const fresh = await playlistItem(id);
      return fresh && playlistFrom(fresh);
    },

    async deletePlaylist(id) {
      if (!(await playlistItem(id))) return false;
      await jf(`/Items/${id}`, {}, { method: 'DELETE' });
      return true;
    },

    // static=true serves the original file bytes, so they agree with the
    // container reported at browse time.
    async stream(id) {
      return { url: url(`/Audio/${encodeURIComponent(id)}/stream`, { static: 'true' }), headers };
    },

    async coverArt(id, size) {
      return { url: url(`/Items/${encodeURIComponent(id)}/Images/Primary`, { maxWidth: size, maxHeight: size, quality: 90 }), headers };
    },

    async lyrics(id) {
      const item = await itemById(id);
      if (item?.Type !== 'Audio') return undefined;
      const resp = await ctx.fetch(url(`/Audio/${id}/Lyrics`), { headers });
      if (!resp.ok) return null; // 404 = no lyrics for this track
      const body = (await resp.json()) as { Lyrics?: { Text?: string }[] };
      const lines = (body.Lyrics ?? []).map((l) => l.Text ?? '').filter(Boolean);
      return lines.length ? { displayArtist: song(item).artist, displayTitle: item.Name, lines } : null;
    },

    // Only a completed play is recorded; Jellyfin's "now playing" belongs to a
    // client session the router does not have.
    async scrobble(id, opts) {
      if (!opts.submission) return;
      const { id: userId } = await user();
      const when = opts.time ? new Date(opts.time).toISOString() : undefined;
      await jf(`/Users/${userId}/PlayedItems/${id}`, { datePlayed: when }, { method: 'POST' });
    },

    async scanStatus() {
      const tasks = await jf<{ Key?: string; State?: string }[]>('/ScheduledTasks', { isHidden: 'false' });
      const scan = tasks.find((t) => t.Key === 'RefreshLibrary');
      return { scanning: scan?.State === 'Running' };
    },

    async stats() {
      const { id: userId } = await user();
      const [counts, artists, genres] = await Promise.all([
        jf<{ SongCount?: number; AlbumCount?: number }>('/Items/Counts', { userId }),
        // /Items/Counts reports ArtistCount 0 for music libraries, so the
        // artist total comes from /Artists with Limit 0 (count only).
        jf<JfItemsResult>('/Artists', { userId, Recursive: 'true', Limit: 0 }),
        jf<JfItemsResult>('/MusicGenres', { userId, Limit: 0 }),
      ]);
      return { artists: artists.TotalRecordCount, albums: counts.AlbumCount ?? 0, songs: counts.SongCount ?? 0, genres: genres.TotalRecordCount };
    },
  };
});
