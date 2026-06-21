// Local-folder provider.
//
// The thinnest source: a directory of audio files the controller can read
// directly (MUSIC_LOCAL_DIR, mounted into BOTH the controller and the broadcast
// container at the same path so Liquidsoap can play the file path next.txt
// carries). No remote API — metadata comes from the files' own tags
// (music-metadata), playback is the bare file path (no subhttp:).
//
// It has no "similar" of its own — that comes from the controller's embedding
// library (built by the tagger over iterateAllSongs) plus the Phase-1.5 Last.fm
// backfill in the picker. No starred/playlists; lyrics via the LRCLIB enricher.

import { readdir, stat } from 'node:fs/promises';
import { join, relative, extname, basename } from 'node:path';
import crypto from 'node:crypto';
import { parseFile } from 'music-metadata';
import type { MusicSource, Song } from '../source-kit.js';
import { emptyDiscovery, namespaceId, parseId, buildAnnotateUri, sourceConfig } from '../source-kit.js';

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.flac', '.ogg', '.opus', '.wav', '.aac', '.wma', '.aiff', '.aif']);
const MAX_FILES = 100_000;        // runaway guard on the walk
const INDEX_TTL_MS = 10 * 60 * 1000; // re-scan at most this often (new files appear)
const PARSE_CONCURRENCY = 8;

interface Entry {
  id: string;          // raw (un-namespaced) — stable hash of the relative path
  path: string;        // absolute file path (what Liquidsoap plays)
  title: string;
  artist: string;
  album: string;
  year?: number;
  genre?: string;
  duration?: number;
  mtimeMs: number;
}

interface Index {
  builtAt: number;
  dir: string;
  byId: Map<string, Entry>;
  list: Entry[];
}

function shortHash(s: string): string {
  return crypto.createHash('md5').update(s).digest('hex').slice(0, 16);
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(full);
    } else if (e.isFile() && AUDIO_EXT.has(extname(e.name).toLowerCase())) {
      yield full;
    }
  }
}

let cached: Index | null = null;
let building: Promise<Index> | null = null;

async function buildIndex(dir: string): Promise<Index> {
  const files: string[] = [];
  for await (const f of walk(dir)) {
    files.push(f);
    if (files.length >= MAX_FILES) break;
  }
  const byId = new Map<string, Entry>();
  let i = 0;
  async function worker() {
    while (i < files.length) {
      const full = files[i++];
      if (isArchivePath(full)) continue; // keep station mixdowns out of selection (#273)
      const id = shortHash(relative(dir, full));
      let title = basename(full, extname(full));
      let artist = '';
      let album = '';
      let year: number | undefined;
      let genre: string | undefined;
      let duration: number | undefined;
      try {
        const m = await parseFile(full);
        const c = m.common;
        if (c.title) title = c.title;
        if (c.artist) artist = c.artist;
        if (c.album) album = c.album;
        if (c.year) year = c.year;
        if (Array.isArray(c.genre) && c.genre[0]) genre = c.genre[0];
        if (m.format?.duration) duration = Math.round(m.format.duration);
      } catch { /* unreadable tags → filename title, empty rest */ }
      let mtimeMs = 0;
      try { mtimeMs = (await stat(full)).mtimeMs; } catch { /* ignore */ }
      byId.set(id, { id, path: full, title, artist, album, year, genre, duration, mtimeMs });
    }
  }
  await Promise.all(Array.from({ length: PARSE_CONCURRENCY }, () => worker()));
  return { builtAt: Date.now(), dir, byId, list: [...byId.values()] };
}

// Cached index, rebuilt when stale or when the configured dir changes. Concurrent
// callers share one in-flight build.
async function getIndex(): Promise<Index> {
  const dir = sourceConfig().local.dir;
  if (!dir) return { builtAt: Date.now(), dir: '', byId: new Map(), list: [] };
  const fresh = cached && cached.dir === dir && Date.now() - cached.builtAt < INDEX_TTL_MS;
  if (fresh) return cached!;
  if (!building) {
    building = buildIndex(dir).then((idx) => { cached = idx; building = null; return idx; })
      .catch((e) => { building = null; throw e; });
  }
  return building;
}

function isArchivePath(p: string): boolean {
  return /(^|\/)archive\/\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}\.mp3$/i.test(String(p || ''));
}

function toSong(e: Entry): Song {
  return {
    id: namespaceId('local', e.id),
    title: e.title,
    artist: e.artist,
    album: e.album,
    albumId: e.album ? namespaceId('local', `album:${shortHash(e.album.toLowerCase())}`) : undefined,
    year: e.year,
    genre: e.genre,
    duration: e.duration,
    path: e.path,
  };
}

const norm = (s: any) => String(s || '').toLowerCase().trim();
function shuffle<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; }
  return r;
}

export const localSource: MusicSource = {
  ...emptyDiscovery,
  key: 'local',
  capabilities: {
    pool: true,
    similar: false,       // no native graph — embedding-similar + Last.fm backfill cover it
    genre: true,
    playlists: false,
    starred: false,
    recentlyAdded: true,  // by file mtime
    frequent: false,
    artistGraph: true,    // top/recent songs by artist (no play counts)
    sonicSimilarity: false,
    lyrics: false,        // LRCLIB enricher
    libraryWalk: true,    // finite folder — taggable
  },

  isStationArchive: (song: any) => isArchivePath(song?.path),

  async search(query, { songCount = 20 } = {}) {
    const q = norm(query);
    if (!q) return [];
    const idx = await getIndex();
    const terms = q.split(/\s+/).filter(Boolean);
    const hits = idx.list.filter((e) => {
      const hay = `${e.title} ${e.artist} ${e.album} ${basename(e.path)}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    return hits.slice(0, songCount).map(toSong);
  },

  async getRandomSongs({ size = 20, genre } = {}) {
    const idx = await getIndex();
    let pool = idx.list;
    if (genre) { const g = norm(genre); pool = pool.filter((e) => norm(e.genre).includes(g)); }
    return shuffle(pool).slice(0, size).map(toSong);
  },

  async getSongsByGenre(genre, { count = 20 } = {}) {
    const g = norm(genre);
    if (!g) return [];
    const idx = await getIndex();
    const hits = idx.list.filter((e) => norm(e.genre).includes(g) || g.includes(norm(e.genre)));
    return shuffle(hits).slice(0, count).map(toSong);
  },

  async getGenres() {
    const idx = await getIndex();
    const counts = new Map<string, number>();
    for (const e of idx.list) if (e.genre) counts.set(e.genre, (counts.get(e.genre) || 0) + 1);
    return [...counts.entries()].map(([value, songCount]) => ({ value, songCount }));
  },

  async resolveGenreName(name) {
    const target = norm(name).replace(/[^a-z0-9]/g, '');
    if (!target) return null;
    const genres = await localSource.getGenres();
    const n = (s: any) => norm(s).replace(/[^a-z0-9]/g, '');
    let hit = genres.find((g: any) => n(g.value) === target);
    if (!hit) hit = genres.find((g: any) => { const gv = n(g.value); return gv && (gv.includes(target) || target.includes(gv)); });
    return hit?.value || null;
  },

  async getRecentlyAddedAlbums({ size = 20 } = {}) {
    const idx = await getIndex();
    const albums = new Map<string, { id: string; name: string; artist: string; mtimeMs: number; year?: number }>();
    for (const e of idx.list) {
      if (!e.album) continue;
      const key = e.album.toLowerCase();
      const cur = albums.get(key);
      if (!cur) albums.set(key, { id: `album:${shortHash(key)}`, name: e.album, artist: e.artist, mtimeMs: e.mtimeMs, year: e.year });
      else if (e.mtimeMs > cur.mtimeMs) cur.mtimeMs = e.mtimeMs;
    }
    return [...albums.values()].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, size)
      .map((a) => ({ id: a.id, name: a.name, artist: a.artist, year: a.year }));
  },

  async getAlbum(id) {
    // Album ids are `album:<hash(albumName)>` (raw) — match entries whose album
    // hashes to the same value.
    const raw = parseId(id).raw;
    const target = raw.startsWith('album:') ? raw.slice('album:'.length) : raw;
    const idx = await getIndex();
    const hits = idx.list.filter((e) => e.album && shortHash(e.album.toLowerCase()) === target);
    return hits.map(toSong);
  },

  async getSong(id) {
    const idx = await getIndex();
    const e = idx.byId.get(parseId(id).raw);
    return e ? toSong(e) : null;
  },

  async searchArtists(query, { artistCount = 5 } = {}) {
    const q = norm(query);
    if (!q) return [];
    const idx = await getIndex();
    const names = new Set<string>();
    for (const e of idx.list) if (e.artist && norm(e.artist).includes(q)) names.add(e.artist);
    return [...names].slice(0, artistCount).map((name) => ({ id: shortHash(name.toLowerCase()), name }));
  },

  async resolveArtist(name) {
    const idx = await getIndex();
    const target = norm(name);
    if (!target) return null;
    const names = new Set<string>();
    for (const e of idx.list) if (e.artist) names.add(e.artist);
    let hit = [...names].find((n) => norm(n) === target);
    if (!hit) hit = [...names].find((n) => norm(n).includes(target) || target.includes(norm(n)));
    return hit ? { id: shortHash(hit.toLowerCase()), name: hit } : null;
  },

  async getArtist(id) {
    const raw = parseId(id).raw;
    const idx = await getIndex();
    const tracks = idx.list.filter((e) => e.artist && shortHash(e.artist.toLowerCase()) === raw);
    if (!tracks.length) return null;
    const albums = new Map<string, { id: string; name: string; year?: number }>();
    for (const e of tracks) if (e.album) {
      const k = e.album.toLowerCase();
      if (!albums.has(k)) albums.set(k, { id: `album:${shortHash(k)}`, name: e.album, year: e.year });
    }
    return { id: raw, name: tracks[0].artist, album: [...albums.values()] };
  },

  async getTopSongs(artistName, { count = 10 } = {}) {
    const idx = await getIndex();
    const t = norm(artistName);
    const hits = idx.list.filter((e) => norm(e.artist) === t);
    return shuffle(hits).slice(0, count).map(toSong);
  },

  async getRecentSongsByArtist(artistName, { count = 20 } = {}) {
    const idx = await getIndex();
    const t = norm(artistName);
    const hits = idx.list.filter((e) => norm(e.artist) === t).sort((a, b) => b.mtimeMs - a.mtimeMs);
    return hits.slice(0, count).map(toSong);
  },

  async *iterateAllSongs() {
    const idx = await getIndex();
    for (const e of idx.list) {
      if (isArchivePath(e.path)) continue;
      yield toSong(e);
    }
  },

  // Embedded cover-art serving isn't wired in v1 — local tracks show the UI
  // placeholder. (Lyrics/tags/similar all still work via the enrichers.)
  getCoverArtUrl() {
    return null;
  },

  // getRawStreamUrl stays the emptyDiscovery no-op ('') — a bare file path isn't
  // an http-fetchable URL, so the analyzer skips local cleanly; Liquidsoap plays
  // the path directly via getAnnotatedUri below. Text embeddings still build.
  getAnnotatedUri(song) {
    if (!song.path) return '';
    return buildAnnotateUri(song, song.path);
  },
};
