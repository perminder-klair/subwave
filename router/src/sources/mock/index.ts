// The deterministic demo library: generated tones, gradient covers and fake
// lyrics, with no server and no music files. For development, tests and
// trying SUB/WAVE before connecting a real library — not for broadcasting.
//
// It is also the reference implementation of the plugin contract: it covers
// every optional op, so the conformance kit exercises the whole surface on it.

import { defineSource, type Playlist } from '../../sdk/index.js';
import { md5 } from '../../util.js';
import { library, searchLib, similarArtistsFor, similarSongsFor, songHasGenre, topSongsForArtistName, type Library } from './library.js';
import { coverPng, lyricsFor, songWav, wavLength } from './media.js';
import { createStore, type PlaylistRec, type Store } from './store.js';

// One store per library, created on first use and kept for the process, so
// switching away from the mock and back keeps its playlists and stars.
const stores = new WeakMap<Library, Store>();

export default defineSource((ctx) => {
  const min = Math.max(5, Number(ctx.config.songMinSec ?? 20));
  const max = Math.max(min, Number(ctx.config.songMaxSec ?? 45));
  const lib = library(min, max);
  let store = stores.get(lib);
  if (!store) {
    store = createStore(lib);
    stores.set(lib, store);
  }
  const s = store;

  const resolvePlaylist = (rec: PlaylistRec): Playlist => ({
    id: rec.id,
    name: rec.name,
    comment: rec.comment,
    public: rec.public,
    owner: 'subwave',
    created: rec.created,
    changed: rec.changed,
    songs: rec.songIds.map((id) => lib.songById.get(id)).filter((x) => x !== undefined),
  });

  const shuffle = <T>(xs: T[]) => [...xs].sort(() => Math.random() - 0.5);

  return {
    capabilities: { sonicSimilarity: ctx.config.sonicSimilarity !== false },

    async song(id) {
      return lib.songById.get(id);
    },

    async album(id) {
      const album = lib.albumById.get(id);
      return album && { album, songs: lib.albumSongs.get(id) ?? [] };
    },

    async artist(id) {
      const artist = lib.artistById.get(id);
      return artist && { artist, albums: lib.artistAlbums.get(id) ?? [] };
    },

    async artists() {
      return lib.artists;
    },

    async artistInfo(id, count) {
      const artist = lib.artistById.get(id);
      if (!artist) return undefined;
      const genres = lib.artistGenres.get(id) ?? [];
      return {
        biography: `${artist.name} is a fictional act from the SUB/WAVE demo library. They mostly play ${genres.join(' and ') || 'music'}.`,
        musicBrainzId: md5(`mbid:${artist.id}`),
        lastFmUrl: `https://last.fm/music/${encodeURIComponent(artist.name)}`,
        similarArtists: similarArtistsFor(lib, id, count),
        tags: genres,
      };
    },

    async genres() {
      return lib.genres;
    },

    async albumList(type, size, offset) {
      const list = [...lib.albums];
      if (type === 'newest') list.sort((a, b) => String(b.created).localeCompare(String(a.created)));
      else if (type === 'frequent') list.sort((a, b) => (b.playCount ?? 0) - (a.playCount ?? 0));
      else if (type === 'random') return shuffle(list).slice(0, size);
      else list.sort((a, b) => a.name.localeCompare(b.name));
      return list.slice(offset, offset + size);
    },

    async songsByGenre(genre, count, offset) {
      return lib.songs.filter((x) => songHasGenre(x, genre)).slice(offset, offset + count);
    },

    async randomSongs(size, filter) {
      const pool = lib.songs.filter((x) => {
        if (filter.genre && !songHasGenre(x, filter.genre)) return false;
        if (filter.fromYear !== undefined && (x.year ?? 0) < filter.fromYear) return false;
        if (filter.toYear !== undefined && (x.year ?? 0) > filter.toYear) return false;
        return true;
      });
      return shuffle(pool).slice(0, size);
    },

    async search(query, limits) {
      const hit = searchLib(lib, query);
      return {
        artists: hit.artists.slice(0, limits.artistCount),
        albums: hit.albums.slice(0, limits.albumCount),
        songs: hit.songs.slice(0, limits.songCount),
      };
    },

    async similarSongs(id, count) {
      return similarSongsFor(lib, id, count);
    },

    async topSongs(artistName, count) {
      return topSongsForArtistName(lib, artistName, count);
    },

    async starred() {
      return new Map(s.starred);
    },

    async starredSongs() {
      return s.starredSongs();
    },

    async star(ids) {
      for (const id of ids) s.star(id);
    },

    async unstar(ids) {
      for (const id of ids) s.unstar(id);
    },

    async playlists() {
      return [...s.playlists.values()].map(resolvePlaylist);
    },

    async playlist(id) {
      const rec = s.playlists.get(id);
      return rec && resolvePlaylist(rec);
    },

    async createPlaylist(name, songIds) {
      return resolvePlaylist(s.create(name, songIds));
    },

    async overwritePlaylist(id, name, songIds) {
      const rec = s.overwrite(id, name, songIds);
      return rec && resolvePlaylist(rec);
    },

    async updatePlaylist(id, patch) {
      const rec = s.update(id, patch);
      return rec && resolvePlaylist(rec);
    },

    async deletePlaylist(id) {
      return s.remove(id);
    },

    async stream(id) {
      const song = lib.songById.get(id);
      if (!song) return undefined;
      return {
        body: songWav(song),
        headers: { 'content-type': 'audio/wav', 'content-length': String(wavLength(song)), 'accept-ranges': 'none' },
      };
    },

    async coverArt(id, size) {
      if (!lib.songById.has(id) && !lib.albumById.has(id) && !lib.artistById.has(id)) return undefined;
      return { contentType: 'image/png', data: coverPng(id, size) };
    },

    async lyrics(id) {
      const song = lib.songById.get(id);
      if (!song) return undefined;
      const lines = lyricsFor(song);
      return lines ? { displayArtist: song.artist, displayTitle: song.title, lines } : null;
    },

    async scrobble(id, opts) {
      const song = lib.songById.get(id);
      if (song && opts.submission) song.playCount = (song.playCount ?? 0) + 1;
    },

    async scanStatus() {
      return { scanning: false, count: lib.songs.length };
    },

    async stats() {
      return { artists: lib.artists.length, albums: lib.albums.length, songs: lib.songs.length, genres: lib.genres.length };
    },
  };
});
