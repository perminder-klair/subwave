// Example SUB/WAVE music-source plugin: a folder of audio files.
//
// Copy this folder to state/router/plugins/folder/, mount your music into the
// router container, then pick "Music folder" in Admin → Settings → Music
// source. See docs/music-source-plugins.md for the whole contract.
//
// It is deliberately small and dependency-free — one ES module using only
// Node built-ins — so it can be read top to bottom as a template:
//
//   - Ids are NATIVE: a short hash of each file's relative path. The router
//     namespaces them (fold-<hash>); the plugin never has to.
//   - Objects are LOOSE: no genres, no durations, no years. The router fills
//     neutral defaults, and the controller's analyzer measures the audio.
//   - stream() hands the router bytes and headers; the router does the HTTP.
//
// Layout it understands:  <root>/<Artist>/<Album>/<NN> <Title>.<ext>
// Anything shallower falls back to "Unknown Artist" / the folder name.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, sep } from 'node:path';

const AUDIO = { '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.wav': 'audio/wav' };
const COVERS = ['cover.jpg', 'cover.png', 'folder.jpg', 'folder.png', 'front.jpg', 'front.png'];

const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 20);

function parseName(file) {
  const stem = basename(file, extname(file));
  const m = /^(\d{1,3})[\s.\-_]+(.*)$/.exec(stem);
  return m ? { track: Number(m[1]), title: m[2].trim() || stem } : { track: 0, title: stem };
}

async function walk(root, dir, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(root, full, out);
    else if (AUDIO[extname(e.name).toLowerCase()]) out.push(relative(root, full));
  }
}

export default (ctx) => {
  const root = String(ctx.config.path);
  const rescanMs = Math.max(1, Number(ctx.config.rescanMinutes ?? 30)) * 60_000;
  let library = null;
  let scannedAt = 0;

  // The whole index is rebuilt from disk, so ids survive a router restart
  // without the plugin storing anything.
  async function index() {
    if (library && Date.now() - scannedAt < rescanMs) return library;
    const files = [];
    await walk(root, root, files);
    files.sort();
    const songs = new Map();
    const albums = new Map();
    const artists = new Map();
    for (const rel of files) {
      const parts = rel.split(sep);
      const artistName = parts.length >= 3 ? parts[parts.length - 3] : 'Unknown Artist';
      const albumName = parts.length >= 2 ? parts[parts.length - 2] : basename(root);
      const artistId = hash(`artist:${artistName}`);
      const albumId = hash(`album:${artistName}/${albumName}`);
      const { track, title } = parseName(rel);
      const st = await stat(join(root, rel));
      const ext = extname(rel).toLowerCase();
      const song = {
        id: hash(`song:${rel}`),
        title,
        album: albumName,
        albumId,
        artist: artistName,
        artistId,
        track,
        suffix: ext.slice(1),
        contentType: AUDIO[ext],
        size: st.size,
        path: rel,
        created: st.mtime.toISOString(),
      };
      songs.set(song.id, song);
      if (!albums.has(albumId)) albums.set(albumId, { album: { id: albumId, name: albumName, artist: artistName, artistId, created: song.created, dir: dirname(rel) }, songs: [] });
      albums.get(albumId).songs.push(song);
      if (!artists.has(artistId)) artists.set(artistId, { artist: { id: artistId, name: artistName }, albums: [] });
      if (!artists.get(artistId).albums.includes(albums.get(albumId).album)) artists.get(artistId).albums.push(albums.get(albumId).album);
    }
    for (const a of albums.values()) a.songs.sort((x, y) => x.track - y.track || x.title.localeCompare(y.title));
    library = { songs, albums, artists };
    scannedAt = Date.now();
    ctx.log.info(`indexed ${songs.size} files under ${root}`);
    return library;
  }

  const albumOut = ({ dir, ...album }, songs) => ({ ...album, songCount: songs.length });
  const shuffle = (xs) => [...xs].sort(() => Math.random() - 0.5);
  const lower = (s) => String(s ?? '').toLowerCase();

  return {
    async song(id) {
      return (await index()).songs.get(id);
    },

    async album(id) {
      const hit = (await index()).albums.get(id);
      return hit && { album: albumOut(hit.album, hit.songs), songs: hit.songs };
    },

    async artist(id) {
      const lib = await index();
      const hit = lib.artists.get(id);
      return hit && { artist: { ...hit.artist, albumCount: hit.albums.length }, albums: hit.albums.map((a) => albumOut(a, lib.albums.get(a.id).songs)) };
    },

    async artists() {
      return [...(await index()).artists.values()].map((a) => ({ ...a.artist, albumCount: a.albums.length }));
    },

    // No tags are read, so there are no genres: genre shows fall back to random picks.
    async genres() {
      return [];
    },

    async songsByGenre() {
      return [];
    },

    async albumList(type, size, offset) {
      const all = [...(await index()).albums.values()];
      let list;
      if (type === 'random') list = shuffle(all);
      else if (type === 'newest') list = all.sort((a, b) => b.album.created.localeCompare(a.album.created));
      else list = all.sort((a, b) => a.album.name.localeCompare(b.album.name));
      return list.slice(type === 'random' ? 0 : offset, (type === 'random' ? 0 : offset) + size).map((a) => albumOut(a.album, a.songs));
    },

    async randomSongs(size) {
      return shuffle([...(await index()).songs.values()]).slice(0, size);
    },

    async search(query, limits) {
      const lib = await index();
      const q = lower(query).trim();
      const has = (...fields) => !q || fields.some((f) => lower(f).includes(q));
      return {
        artists: [...lib.artists.values()].filter((a) => has(a.artist.name)).slice(0, limits.artistCount).map((a) => a.artist),
        albums: [...lib.albums.values()].filter((a) => has(a.album.name, a.album.artist)).slice(0, limits.albumCount).map((a) => albumOut(a.album, a.songs)),
        songs: [...lib.songs.values()].filter((s) => has(s.title, s.artist, s.album)).slice(0, limits.songCount),
      };
    },

    // Bytes and headers; the router handles the HTTP and the media guard.
    // Range is honoured so a seeking client gets a 206.
    async stream(id, { range }) {
      const song = (await index()).songs.get(id);
      if (!song) return undefined;
      const file = join(root, song.path);
      const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m && (m[1] || m[2])) {
        const start = m[1] ? Number(m[1]) : Math.max(0, song.size - Number(m[2]));
        const end = m[1] && m[2] ? Math.min(Number(m[2]), song.size - 1) : song.size - 1;
        return {
          status: 206,
          body: createReadStream(file, { start, end }),
          headers: {
            'content-type': song.contentType,
            'content-length': String(end - start + 1),
            'content-range': `bytes ${start}-${end}/${song.size}`,
            'accept-ranges': 'bytes',
          },
        };
      }
      return {
        body: createReadStream(file),
        headers: { 'content-type': song.contentType, 'content-length': String(song.size), 'accept-ranges': 'bytes' },
      };
    },

    // A cover.jpg (or similar) beside the album's files, asked for by album OR song id.
    async coverArt(id) {
      const lib = await index();
      const albumId = lib.songs.get(id)?.albumId ?? id;
      const hit = lib.albums.get(albumId);
      if (!hit) return undefined;
      for (const name of COVERS) {
        try {
          const data = await readFile(join(root, hit.album.dir, name));
          return { contentType: name.endsWith('.png') ? 'image/png' : 'image/jpeg', data };
        } catch {
          /* try the next name */
        }
      }
      return undefined;
    },

    async scanStatus() {
      return { scanning: false, count: (await index()).songs.size };
    },

    async stats() {
      const lib = await index();
      return { artists: lib.artists.size, albums: lib.albums.size, songs: lib.songs.size, genres: 0 };
    },
  };
};
