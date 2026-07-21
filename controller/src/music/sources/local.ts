// The local-folder music source: an operator drops audio files under
// <STATE_DIR>/music (or MUSIC_DIR) and SUB/WAVE plays them with no Navidrome.
// All discovery is served from the in-memory index built by scanner.ts.
//
// Every getter returns FRESH CLONES of index rows. This is load-bearing: the
// queue/DJ pipeline stamps transient fields (crossSec, gainDb, sweep, …) onto
// song objects before playback, and handing out shared references would leak one
// pick's stamps into the next. Subsonic gets this for free (per-call JSON parse);
// a Map-backed index must clone explicitly.

import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { parseFile } from 'music-metadata';
import type { MusicSource, Song, Artist, Album, Genre, CoverArt, AnalyzableRef } from './types.js';
import { getIndex, musicRoot } from './local/scanner.js';
import type { LocalTrack, LocalAlbum } from './local/model.js';

function toSong(t: LocalTrack): Song {
  // Clone — see file header. `path` stays relative (Subsonic parity);
  // getPlayableUri resolves it to an absolute path. Cast because LocalTrack uses
  // explicit null for absent year/genre/duration while Song types them optional
  // — behaviourally identical (both falsy), and Song carries an index signature.
  return { ...t } as Song;
}

function toAlbum(a: LocalAlbum): Album {
  return { id: a.id, name: a.name, artist: a.artist, artistId: a.artistId, year: a.year ?? undefined, songCount: a.songCount, coverArt: a.coverArt, created: a.created };
}

function normKey(s: string): string {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function ping(): Promise<{ ok: boolean; reason?: string }> {
  const root = musicRoot();
  try {
    await readdir(root);
  } catch (err: any) {
    return { ok: false, reason: `music folder ${root} not readable: ${err?.message || err}` };
  }
  const n = getIndex().tracks.size;
  if (n === 0) return { ok: true, reason: `0 tracks — drop audio files in ${root}` };
  return { ok: true, reason: `${n} tracks` };
}

async function search(query: string, { songCount = 20, songOffset = 0 }: { songCount?: number; songOffset?: number } = {}): Promise<Song[]> {
  const idx = getIndex();
  const tokens = String(query || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const out: Song[] = [];
  for (const [id, blob] of idx.searchBlob) {
    if (tokens.every(t => blob.includes(t))) {
      const t = idx.tracks.get(id);
      if (t) out.push(toSong(t));
    }
  }
  return out.slice(songOffset, songOffset + songCount);
}

async function getSong(id: string): Promise<Song | null> {
  const t = getIndex().tracks.get(id);
  return t ? toSong(t) : null;
}

async function getAlbum(id: string): Promise<Song[]> {
  const idx = getIndex();
  const al = idx.albums.get(id);
  if (!al) return [];
  return al.songIds.map(sid => idx.tracks.get(sid)).filter(Boolean).map(t => toSong(t as LocalTrack));
}

async function getAlbumList(offset = 0, size = 500): Promise<Album[]> {
  return getIndex().albumsAlpha.slice(offset, offset + size).map(toAlbum);
}

async function getRecentlyAddedAlbums({ size = 20 }: { size?: number } = {}): Promise<Album[]> {
  return getIndex().albumsByCreated.slice(0, size).map(toAlbum);
}

async function getFrequentAlbums({ size = 20 }: { size?: number } = {}): Promise<Album[]> {
  // No play counts locally — a random album sample instead, so it's a genuine
  // "deep cuts" leg rather than a duplicate of recently-added. The pool picker
  // dedupes by track id, so overlap with other legs is harmless.
  return shuffle(getIndex().albumsAlpha).slice(0, size).map(toAlbum);
}

async function getArtist(id: string): Promise<Artist | null> {
  const idx = getIndex();
  const ar = idx.artists.get(id);
  if (!ar) return null;
  const album = ar.albumIds.map(aid => idx.albums.get(aid)).filter(Boolean).map(a => toAlbum(a as LocalAlbum));
  return { id: ar.id, name: ar.name, albumCount: ar.albumCount, album };
}

async function searchArtists(query: string, { artistCount = 5 }: { artistCount?: number } = {}): Promise<Artist[]> {
  const idx = getIndex();
  const q = normKey(query);
  if (!q) return [];
  const out: Artist[] = [];
  for (const ar of idx.artists.values()) {
    const name = normKey(ar.name);
    if (name.includes(q) || q.includes(name)) out.push({ id: ar.id, name: ar.name, albumCount: ar.albumCount });
    if (out.length >= artistCount) break;
  }
  return out;
}

async function getGenres(): Promise<Genre[]> {
  return [...getIndex().genres.values()].map(g => ({ value: g.value, songCount: g.songCount, albumCount: g.albumCount }));
}

async function getSongsByGenre(genre: string, { count = 20 }: { count?: number } = {}): Promise<Song[]> {
  const idx = getIndex();
  const g = normKey(genre);
  const out: Song[] = [];
  for (const t of idx.tracks.values()) {
    if (t.genre && normKey(t.genre) === g) out.push(toSong(t));
    if (out.length >= count) break;
  }
  return out;
}

async function getRandomSongs({ size = 20, genre, fromYear, toYear }: { size?: number; genre?: string; fromYear?: number; toYear?: number } = {}): Promise<Song[]> {
  const idx = getIndex();
  const g = genre ? normKey(genre) : null;
  let pool = [...idx.tracks.values()];
  if (g) pool = pool.filter(t => t.genre && normKey(t.genre) === g);
  if (fromYear != null) pool = pool.filter(t => t.year != null && t.year >= fromYear);
  if (toYear != null) pool = pool.filter(t => t.year != null && t.year <= toYear);
  return shuffle(pool).slice(0, size).map(toSong);
}

async function getTopSongs(artistName: string, { count = 10 }: { count?: number } = {}): Promise<Song[]> {
  // No popularity data — return a shuffled sample of the artist's tracks. Match
  // the artist by normalised name against the index.
  const idx = getIndex();
  const q = normKey(artistName);
  if (!q) return [];
  const songs = [...idx.tracks.values()].filter(t => normKey(t.artist) === q);
  return shuffle(songs).slice(0, count).map(toSong);
}

async function* iterateAllSongs(): AsyncGenerator<Song> {
  for (const t of getIndex().tracks.values()) yield toSong(t);
}

function getPlayableUri(song: Song): string {
  // Absolute path under the music root. Liquidsoap plays a bare local path
  // inside the annotate: wrapper (the proven getLocalPath codepath); the path is
  // identical in the broadcast container because the state dir mounts at the
  // same place. `song.path` is the relative path stored in the index.
  return path.join(musicRoot(), String(song.path || ''));
}

async function getAnalyzableRef(songId: string): Promise<AnalyzableRef | null> {
  const t = getIndex().tracks.get(songId);
  if (!t) return null;
  return { path: path.join(musicRoot(), t.path) };
}

const ART_NAMES = ['cover', 'folder', 'front'];
const ART_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

async function getCoverArt(id: string): Promise<CoverArt | null> {
  const t = getIndex().tracks.get(id);
  if (!t) return null;
  const abs = path.join(musicRoot(), t.path);
  // 1. Embedded picture.
  try {
    const mm = await parseFile(abs, { duration: false });
    const pic = mm.common?.picture?.[0];
    if (pic?.data) {
      return { buf: Buffer.from(pic.data), contentType: pic.format || 'image/jpeg' };
    }
  } catch {
    // fall through to sidecar art
  }
  // 2. Sidecar art in the track's directory (cover/folder/front.{jpg,png,…}).
  const dir = path.dirname(abs);
  try {
    const entries = await readdir(dir);
    const lower = new Map(entries.map(e => [e.toLowerCase(), e]));
    for (const name of ART_NAMES) {
      for (const ext of ART_EXTS) {
        const hit = lower.get(name + ext);
        if (hit) {
          const buf = await readFile(path.join(dir, hit));
          const contentType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
          return { buf, contentType };
        }
      }
    }
  } catch {
    // no readable dir / art
  }
  return null;
}

export const localSource: MusicSource = {
  id: 'local',
  ping,
  search,
  getSong,
  getAlbum,
  getArtist,
  searchArtists,
  getGenres,
  getRandomSongs,
  getSongsByGenre,
  getAlbumList,
  iterateAllSongs,
  getPlayableUri,
  getCoverArt,
  getAnalyzableRef,
  // Heuristic discovery the index can serve:
  getTopSongs,
  getRecentlyAddedAlbums,
  getFrequentAlbums,
  // Intentionally absent (capabilities OFF): getSimilarSongs, supportsSonicSimilarity,
  // getSonicSimilarTracks, getStarred, getArtistInfo, getArtistLastfmTags,
  // getLyrics, getPlaylists, getPlaylist.
};
