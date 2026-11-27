// Deterministic in-memory music library, built from a fixed PRNG seed so
// every id, title and timestamp is identical across restarts — the controller
// caches song ids (library.db, likes, stems) and a mock that reshuffled ids on
// boot would corrupt those caches.
//
// THE DETERMINISM INVARIANT: any change that alters the SEQUENCE of rand()
// calls (reordering artists, an extra rand(), different album or song counts)
// silently re-rolls every downstream id. Append after the existing generation
// or accept — and say — that every id changes. Durations consume exactly one
// rand() whatever the configured range, which is why the range is a setting
// and the ids still do not move when it changes.

import { fnv1a, md5, mulberry32, norm } from '../../util.js';
import type { Album, Artist, GenreCount, ReplayGain, SearchResult, Song } from '../../sdk/types.js';

const ARTIST_DEFS: { name: string; genres: string[] }[] = [
  { name: 'Neon Harbor', genres: ['Synthwave', 'Electronic'] },
  { name: 'The Midnight Cartographers', genres: ['Indie Rock'] },
  { name: 'Velvet Antenna', genres: ['Dream Pop', 'Shoegaze'] },
  { name: 'Moss & Mercury', genres: ['Ambient', 'Downtempo'] },
  { name: 'Static Bloom', genres: ['Punk Rock'] },
  { name: 'Cassette Waves', genres: ['Lo-Fi', 'Chillhop'] },
  { name: 'Dune Choir', genres: ['World', 'Ambient'] },
  { name: 'Paper Satellites', genres: ['Indie Pop'] },
  { name: 'Low Tide Collective', genres: ['Jazz', 'Soul'] },
  { name: 'Glass Motor', genres: ['Techno', 'Electronic'] },
  { name: 'Iron Lullaby', genres: ['Post-Rock'] },
  { name: 'The Analog Garden', genres: ['Folk', 'Acoustic'] },
  { name: "Ferryman's Echo", genres: ['Trip-Hop', 'Downtempo'] },
  { name: 'Bright Nowhere', genres: ['Pop Punk'] },
  { name: 'Ivory Statik', genres: ['Hip-Hop'] },
  { name: 'Cobalt Rain', genres: ['Blues Rock'] },
];

const TITLE_A = [
  'Silver', 'Broken', 'Electric', 'Quiet', 'Neon', 'Golden', 'Fading', 'Restless',
  'Hollow', 'Velvet', 'Midnight', 'Paper', 'Northern', 'Slow', 'Wired', 'Glass',
];
const TITLE_B = [
  'Horizon', 'Signal', 'Tide', 'Motorway', 'Satellite', 'Garden', 'Static', 'Harbour',
  'Echo', 'Lantern', 'Circuit', 'Monsoon', 'Postcard', 'Arcade', 'Meridian', 'Frequency',
];
const ALBUM_NAMES = [
  'Night Frequencies', 'Departure Tapes', 'Weather for Strangers', 'Terminal Bloom',
  'The Long Exposure', 'Coastal Circuitry', 'Sleep Patterns', 'Analog Rituals',
  'Field Notes', 'Afterglow Editions', 'Lost Transmissions', 'Slow Light',
  'Half-Remembered Cities', 'Static Postcards', 'Botanical Static', 'Harbour Lights',
  'Winter Broadcasting', 'The Quiet Machines', 'Copper Skies', 'Departures & Arrivals',
  'Everything in Transit', 'Ghost Stations', 'Low Orbit', 'Museum of Rain',
  'Parallel Summers', 'Second Sleep', 'Small Hours', 'Tape Loops for Airports',
  'The Cartography of Us', 'Vacant Frequencies', 'Wired Gardens', 'Yesterday Machines',
];

const BASE_CREATED = Date.UTC(2023, 0, 1);
const isoDaysAfterBase = (days: number) => new Date(BASE_CREATED + Math.floor(days) * 86_400_000).toISOString();

export interface Library {
  artists: Artist[];
  albums: Album[];
  songs: Song[];
  songById: Map<string, Song>;
  albumById: Map<string, Album>;
  artistById: Map<string, Artist>;
  albumSongs: Map<string, Song[]>;
  artistAlbums: Map<string, Album[]>;
  artistGenres: Map<string, string[]>;
  genres: GenreCount[];
}

// ReplayGain derived from fnv1a of the ids, NOT rand(): an extra rand() here
// would shift the PRNG sequence and re-roll every id generated after it.
function mockReplayGain(songId: string, albumId: string): ReplayGain {
  const pick = (salt: string, span: number) => fnv1a(`${salt}:${songId}`) % span;
  return {
    trackGain: Math.round((-12 + pick('gain', 1401) / 100) * 100) / 100,
    trackPeak: Math.round((0.7 + pick('peak', 300) / 1000) * 1000) / 1000,
    albumGain: Math.round((-10 + (fnv1a(`again:${albumId}`) % 1101) / 100) * 100) / 100,
    albumPeak: Math.round((0.8 + (fnv1a(`apeak:${albumId}`) % 200) / 1000) * 1000) / 1000,
  };
}

function build(songMin: number, songMax: number): Library {
  const rand = mulberry32(0x53554257); // 'SUBW'
  const lib: Library = {
    artists: [],
    albums: [],
    songs: [],
    songById: new Map(),
    albumById: new Map(),
    artistById: new Map(),
    albumSongs: new Map(),
    artistAlbums: new Map(),
    artistGenres: new Map(),
    genres: [],
  };

  let albumNameCursor = 0;
  const nextAlbumName = () => {
    const name = ALBUM_NAMES[albumNameCursor % ALBUM_NAMES.length]!;
    const round = Math.floor(albumNameCursor / ALBUM_NAMES.length);
    albumNameCursor++;
    return round === 0 ? name : `${name} ${'I'.repeat(round + 1)}`;
  };
  const makeTitle = (seq: number) => {
    const a = TITLE_A[Math.floor(rand() * TITLE_A.length)];
    const b = TITLE_B[Math.floor(rand() * TITLE_B.length)];
    return seq % 5 === 0 ? `${a} ${b} (${['Reprise', 'Live', 'Edit', 'Demo'][seq % 4]})` : `${a} ${b}`;
  };

  function addSong(o: { album: Album; artistName: string; artistId: string; track: number; year: number; genres: string[]; titleSeq: number }): Song {
    const title = makeTitle(o.titleSeq);
    const duration = Math.round(songMin + rand() * Math.max(1, songMax - songMin));
    const id = md5(`song:${o.album.id}:${o.track}:${title}`);
    const song: Song = {
      id,
      title,
      album: o.album.name,
      albumId: o.album.id,
      artist: o.artistName,
      artistId: o.artistId,
      artists: [{ id: o.artistId, name: o.artistName }],
      albumArtists: [{ id: o.album.artistId!, name: o.album.artist! }],
      track: o.track,
      discNumber: 1,
      year: o.year,
      genres: o.genres,
      coverArt: o.album.id,
      // The stream is generated 16-bit mono WAV, so describe it truthfully.
      size: 44 + Math.max(5, duration) * 44_100 * 2,
      contentType: 'audio/wav',
      suffix: 'wav',
      duration,
      bitRate: 706,
      path: `${o.artistName}/${o.album.name}/${String(o.track).padStart(2, '0')} - ${title}.wav`,
      playCount: Math.floor(rand() * 250),
      created: o.album.created,
      replayGain: mockReplayGain(id, o.album.id),
    };
    lib.songs.push(song);
    lib.songById.set(id, song);
    lib.albumSongs.get(o.album.id)!.push(song);
    return song;
  }

  function addAlbum(artist: Artist, genres: string[], o: { name?: string; year?: number; isCompilation?: boolean } = {}): Album {
    const name = o.name ?? nextAlbumName();
    const year = o.year ?? 1978 + Math.floor(rand() * 47);
    const id = md5(`album:${artist.name}:${name}`);
    const album: Album = {
      id,
      name,
      artist: artist.name,
      artistId: artist.id,
      coverArt: id,
      songCount: 0,
      duration: 0,
      playCount: 0,
      created: isoDaysAfterBase(rand() * 900),
      year,
      genres,
    };
    if (o.isCompilation) album.isCompilation = true;
    // ~30% are "reissues": originalReleaseDate earlier than the scalar year —
    // exercises the controller's era resolution (#842).
    if (!o.isCompilation && rand() < 0.3) {
      album.originalReleaseDate = {
        year: Math.max(1960, year - (1 + Math.floor(rand() * 10))),
        month: 1 + Math.floor(rand() * 12),
        day: 1 + Math.floor(rand() * 28),
      };
    }
    lib.albums.push(album);
    lib.albumById.set(id, album);
    lib.albumSongs.set(id, []);
    lib.artistAlbums.get(artist.id)!.push(album);
    return album;
  }

  function finalize(album: Album): void {
    const list = lib.albumSongs.get(album.id)!;
    album.songCount = list.length;
    album.duration = list.reduce((a, s) => a + (s.duration ?? 0), 0);
    album.playCount = list.reduce((a, s) => a + (s.playCount ?? 0), 0);
  }

  let titleSeq = 0;
  for (const def of ARTIST_DEFS) {
    const artist: Artist = { id: md5(`artist:${def.name}`), name: def.name, albumCount: 0 };
    artist.coverArt = artist.id;
    lib.artists.push(artist);
    lib.artistById.set(artist.id, artist);
    lib.artistAlbums.set(artist.id, []);
    lib.artistGenres.set(artist.id, def.genres);
    const albumCount = 1 + Math.floor(rand() * 3);
    for (let a = 0; a < albumCount; a++) {
      const album = addAlbum(artist, def.genres);
      const songCount = 6 + Math.floor(rand() * 7);
      for (let t = 1; t <= songCount; t++) {
        addSong({ album, artistName: artist.name, artistId: artist.id, track: t, year: album.year!, genres: def.genres, titleSeq: titleSeq++ });
      }
      finalize(album);
    }
    artist.albumCount = albumCount;
  }

  // One Various Artists compilation: isCompilation, songs credited to real
  // artists, song years that differ from the album year (#1418).
  {
    const va: Artist = { id: md5('artist:Various Artists'), name: 'Various Artists', albumCount: 1 };
    va.coverArt = va.id;
    lib.artists.push(va);
    lib.artistById.set(va.id, va);
    lib.artistAlbums.set(va.id, []);
    lib.artistGenres.set(va.id, []);
    const comp = addAlbum(va, ['Compilation'], { name: 'Transmission Signals Vol. 1', year: 2021, isCompilation: true });
    for (let t = 1; t <= 8; t++) {
      const src = ARTIST_DEFS[Math.floor(rand() * ARTIST_DEFS.length)]!;
      const srcArtist = lib.artists.find((a) => a.name === src.name)!;
      addSong({ album: comp, artistName: srcArtist.name, artistId: srcArtist.id, track: t, year: 1980 + Math.floor(rand() * 40), genres: src.genres, titleSeq: titleSeq++ });
    }
    finalize(comp);
  }

  const bySongs = new Map<string, number>();
  const byAlbums = new Map<string, number>();
  for (const s of lib.songs) for (const g of s.genres ?? []) bySongs.set(g, (bySongs.get(g) || 0) + 1);
  for (const a of lib.albums) for (const g of a.genres ?? []) byAlbums.set(g, (byAlbums.get(g) || 0) + 1);
  lib.genres = [...bySongs.entries()]
    .map(([name, songCount]) => ({ name, songCount, albumCount: byAlbums.get(name) || 0 }))
    .sort((x, y) => x.name.localeCompare(y.name));
  return lib;
}

const built = new Map<string, Library>();

/** One library per duration range, so reconfiguring and back keeps state. */
export function library(songMin: number, songMax: number): Library {
  const key = `${songMin}:${songMax}`;
  let lib = built.get(key);
  if (!lib) {
    lib = build(songMin, songMax);
    built.set(key, lib);
  }
  return lib;
}

export function songHasGenre(song: Song, genre: string): boolean {
  const target = norm(genre);
  return (song.genres ?? []).some((g) => norm(g) === target);
}

export function searchLib(lib: Library, query: string): SearchResult {
  const q = norm(query);
  if (!q) return { artists: [...lib.artists], albums: [...lib.albums], songs: [...lib.songs] };
  return {
    artists: lib.artists.filter((a) => norm(a.name).includes(q)),
    albums: lib.albums.filter((a) => norm(a.name).includes(q) || norm(a.artist).includes(q)),
    songs: lib.songs.filter((s) => norm(s.title).includes(q) || norm(s.artist).includes(q) || norm(s.album).includes(q)),
  };
}

// Same-genre pool ordered by a hash of (candidate, seed): stable per seed,
// different between seeds. Accepts a song id OR an artist id.
export function similarSongsFor(lib: Library, id: string, count: number): Song[] {
  const seed = lib.songById.get(id);
  const targets = (seed ? (seed.genres ?? []) : (lib.artistGenres.get(id) ?? [])).map(norm);
  let pool = lib.songs.filter((s) => s.id !== id && (s.genres ?? []).some((g) => targets.includes(norm(g))));
  if (!pool.length) pool = lib.songs.filter((s) => s.id !== id);
  return [...pool].sort((a, b) => fnv1a(a.id + id) - fnv1a(b.id + id)).slice(0, count);
}

export function similarArtistsFor(lib: Library, artistId: string, count: number): Artist[] {
  const mine = (lib.artistGenres.get(artistId) ?? []).map(norm);
  const out = lib.artists.filter((a) => a.id !== artistId && (lib.artistGenres.get(a.id) ?? []).some((g) => mine.includes(norm(g))));
  for (const a of lib.artists) {
    if (out.length >= count) break;
    if (a.id !== artistId && !out.includes(a)) out.push(a);
  }
  return out.slice(0, count);
}

export function topSongsForArtistName(lib: Library, name: string, count: number): Song[] {
  const target = norm(name);
  const artist = lib.artists.find((a) => norm(a.name) === target);
  if (!artist) return [];
  return lib.songs
    .filter((s) => s.artistId === artist.id)
    .sort((a, b) => (b.playCount ?? 0) - (a.playCount ?? 0))
    .slice(0, count);
}
