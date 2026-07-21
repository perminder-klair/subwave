// In-memory index model + stable synthetic ids for the local-folder source.
//
// Ids are derived from the file's state-relative path (not its tags), so they
// survive re-tagging and restarts but change when a file is MOVED or RENAMED —
// at which point its analysis/mood rows in library.db re-accrue under the new
// id (the old row is pruned on the next reconcile). Album/artist ids come from
// normalised artist/album strings so two files in the same album share one
// album id regardless of folder layout. All ids are prefixed and hex-only, so
// they satisfy the /cover/:id guard (/^[\w-]{1,64}$/).

import crypto from 'node:crypto';

export interface LocalTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  albumId: string;
  artistId: string;
  year: number | null;
  genre: string | null;
  path: string;        // RELATIVE to the music root (Subsonic Child.path parity)
  duration: number | null;
  suffix: string;      // 'mp3' | 'flac' | … (extension without the dot)
  created: string;     // ISO from file mtime — drives "recently added"
  coverArt: string;    // its own id (parity with Child.coverArt)
}

export interface LocalAlbum {
  id: string;
  name: string;
  artist: string;
  artistId: string;
  year: number | null;
  genre: string | null;
  songCount: number;
  duration: number;
  created: string;     // newest track mtime in the album
  coverArt: string;    // a representative track id
  songIds: string[];
}

export interface LocalArtist {
  id: string;
  name: string;
  albumCount: number;
  albumIds: string[];
}

export interface LibraryIndex {
  tracks: Map<string, LocalTrack>;
  byRelPath: Map<string, string>;                 // relPath → track id
  albums: Map<string, LocalAlbum>;
  albumsAlpha: LocalAlbum[];                       // pre-sorted by name (getAlbumList)
  albumsByCreated: LocalAlbum[];                   // pre-sorted newest-first (recently-added)
  artists: Map<string, LocalArtist>;
  genres: Map<string, { value: string; songCount: number; albumCount: number }>;
  searchBlob: Map<string, string>;                 // track id → normalised "title artist album"
  builtAt: number;
}

// Parsed tag record for one file (persisted in the scan cache, keyed by relPath).
export interface CachedFileRecord {
  mtimeMs: number;
  size: number;
  title: string | null;
  artist: string | null;
  album: string | null;
  year: number | null;
  genre: string | null;
  durationSec: number | null;
}

const shortHash = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

export function trackIdFor(relPath: string): string {
  return `local-${shortHash(relPath)}`;
}

// NFD → strip diacritics → lowercase → non-alnum to single space → trim.
// Same recipe as the fuzzy artist matcher, so "Beyoncé" and "beyonce" collapse.
function normKey(s: string): string {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function albumIdFor(artist: string, album: string): string {
  return `local-al-${shortHash(`${normKey(artist)}|${normKey(album)}`)}`;
}

export function artistIdFor(artist: string): string {
  return `local-ar-${shortHash(normKey(artist))}`;
}

function searchNorm(s: string): string {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Build the whole in-memory index from the parsed-file map. Pure + O(n): no fs,
// no async — the scanner calls this and swaps the result in atomically.
export function buildIndex(files: Map<string, CachedFileRecord>): LibraryIndex {
  const tracks = new Map<string, LocalTrack>();
  const byRelPath = new Map<string, string>();
  const albums = new Map<string, LocalAlbum>();
  const artists = new Map<string, LocalArtist>();
  const genres = new Map<string, { value: string; songCount: number; albumCount: number }>();
  const searchBlob = new Map<string, string>();

  for (const [relPath, rec] of files) {
    const base = relPath.split('/').pop() || relPath;
    const dot = base.lastIndexOf('.');
    const suffix = dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
    const title = (rec.title && rec.title.trim()) || (dot > 0 ? base.slice(0, dot) : base);
    const artist = (rec.artist && rec.artist.trim()) || 'Unknown Artist';
    const album = (rec.album && rec.album.trim()) || 'Unknown Album';
    const albumId = albumIdFor(artist, album);
    const artistId = artistIdFor(artist);
    const id = trackIdFor(relPath);
    const created = new Date(rec.mtimeMs).toISOString();

    const track: LocalTrack = {
      id, title, artist, album, albumId, artistId,
      year: rec.year ?? null,
      genre: rec.genre ?? null,
      path: relPath,
      duration: rec.durationSec ?? null,
      suffix,
      created,
      coverArt: id,
    };
    tracks.set(id, track);
    byRelPath.set(relPath, id);
    searchBlob.set(id, searchNorm(`${title} ${artist} ${album}`));

    let al = albums.get(albumId);
    if (!al) {
      al = {
        id: albumId, name: album, artist, artistId,
        year: track.year, genre: track.genre,
        songCount: 0, duration: 0, created, coverArt: id, songIds: [],
      };
      albums.set(albumId, al);
    }
    al.songCount++;
    al.duration += track.duration ?? 0;
    al.songIds.push(id);
    if (created > al.created) al.created = created; // newest mtime in the album
    if (al.year == null && track.year != null) al.year = track.year;
    if (al.genre == null && track.genre != null) al.genre = track.genre;

    let ar = artists.get(artistId);
    if (!ar) {
      ar = { id: artistId, name: artist, albumCount: 0, albumIds: [] };
      artists.set(artistId, ar);
    }
    if (!ar.albumIds.includes(albumId)) {
      ar.albumIds.push(albumId);
      ar.albumCount = ar.albumIds.length;
    }

    if (track.genre) {
      const key = track.genre.toLowerCase();
      let g = genres.get(key);
      if (!g) { g = { value: track.genre, songCount: 0, albumCount: 0 }; genres.set(key, g); }
      g.songCount++;
    }
  }

  // Genre albumCounts: count distinct albums per genre (a second pass — cheap).
  const genreAlbums = new Map<string, Set<string>>();
  for (const al of albums.values()) {
    if (!al.genre) continue;
    const key = al.genre.toLowerCase();
    if (!genreAlbums.has(key)) genreAlbums.set(key, new Set());
    genreAlbums.get(key)!.add(al.id);
  }
  for (const [key, set] of genreAlbums) {
    const g = genres.get(key);
    if (g) g.albumCount = set.size;
  }

  const albumsAlpha = [...albums.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const albumsByCreated = [...albums.values()].sort((a, b) => b.created.localeCompare(a.created));

  return {
    tracks, byRelPath, albums, albumsAlpha, albumsByCreated,
    artists, genres, searchBlob, builtAt: Date.now(),
  };
}

export const EMPTY_INDEX: LibraryIndex = buildIndex(new Map());
