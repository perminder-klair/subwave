// Plugin output → Subsonic-shaped objects with published ids.
//
// This is the boundary that lets the SDK stay loose: a plugin returns whatever
// subset of fields its backend knows, and every field the controller reads is
// filled here with a neutral default. Only an item with no usable id is
// dropped — logged, never thrown, because one malformed row must not take a
// whole album list (or the station's next pick) down with it.
//
// Defaults are chosen to read as "unknown", not as a measurement: year 0 is
// what Subsonic servers send for an untagged year, a missing replayGain stays
// absent (0 dB would claim "measured, needs no change"), and a missing
// isCompilation stays absent rather than false.

import type { IdCodec } from './ids.js';
import type {
  SubAlbum,
  SubArtist,
  SubArtistInfo,
  SubArtistRef,
  SubDate,
  SubGenre,
  SubLyrics,
  SubPlaylist,
  SubSong,
} from './types.js';

export type Warn = (message: string) => void;

const EPOCH = new Date(0).toISOString();

const CONTENT_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  wma: 'audio/x-ms-wma',
  webm: 'audio/webm',
};

function suffixFor(contentType: string): string | undefined {
  const lower = contentType.toLowerCase();
  for (const [suffix, type] of Object.entries(CONTENT_TYPES)) if (type === lower) return suffix;
  return undefined;
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

function idStr(v: unknown): string {
  return typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) ? String(v) : '';
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function int(v: unknown, fallback = 0): number {
  return Math.round(num(v, fallback));
}

function iso(v: unknown): string {
  if (typeof v !== 'string' && !(v instanceof Date) && typeof v !== 'number') return EPOCH;
  const d = new Date(v as string | number | Date);
  return Number.isNaN(d.getTime()) ? EPOCH : d.toISOString();
}

function genreNames(v: unknown): string[] {
  if (!Array.isArray(v)) return typeof v === 'string' && v.trim() ? [v.trim()] : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const g of v) {
    const name = (typeof g === 'string' ? g : str(rec(g)?.name)).trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

function dateParts(v: unknown): SubDate | undefined {
  const r = rec(v);
  const year = int(r?.year, 0);
  if (!r || year <= 0) return undefined;
  const month = int(r.month, 1);
  const day = int(r.day, 1);
  return { year, month: month >= 1 && month <= 12 ? month : 1, day: day >= 1 && day <= 31 ? day : 1 };
}

function optionalId(codec: IdCodec, v: unknown): string {
  const native = idStr(v);
  return native ? (codec.encode(native) ?? '') : '';
}

function artistRefs(codec: IdCodec, v: unknown): SubArtistRef[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const refs: SubArtistRef[] = [];
  for (const raw of v) {
    const r = rec(raw);
    const name = str(r?.name);
    const id = optionalId(codec, r?.id);
    if (name) refs.push({ id, name });
  }
  return refs.length ? refs : undefined;
}

function replayGain(v: unknown): SubSong['replayGain'] {
  const r = rec(v);
  if (!r) return undefined;
  const out: NonNullable<SubSong['replayGain']> = {};
  for (const key of ['trackGain', 'trackPeak', 'albumGain', 'albumPeak'] as const) {
    if (typeof r[key] === 'number' && Number.isFinite(r[key])) out[key] = r[key] as number;
  }
  return Object.keys(out).length ? out : undefined;
}

function mbid(v: unknown): string | undefined {
  const s = str(v).trim();
  return s || undefined;
}

export function normSong(raw: unknown, codec: IdCodec, warn: Warn): SubSong | undefined {
  const r = rec(raw);
  const native = idStr(r?.id);
  const id = native ? codec.encode(native) : undefined;
  if (!r || !id) {
    warn(`dropped a song with an unusable id (${native ? `'${native.slice(0, 80)}'` : 'none'})`);
    return undefined;
  }
  const genres = genreNames(r.genres ?? r.genre);
  const albumId = optionalId(codec, r.albumId);
  const contentType = str(r.contentType) || (str(r.suffix) ? CONTENT_TYPES[str(r.suffix).toLowerCase()] : '') || 'audio/mpeg';
  const suffix = str(r.suffix) || suffixFor(contentType) || 'mp3';
  const song: SubSong = {
    id,
    parent: albumId,
    isDir: false,
    title: str(r.title) || str(r.name),
    album: str(r.album),
    albumId,
    artist: str(r.artist),
    artistId: optionalId(codec, r.artistId),
    track: int(r.track),
    discNumber: int(r.discNumber, 1) || 1,
    year: int(r.year),
    genre: genres[0] ?? '',
    genres: genres.map((name) => ({ name })),
    coverArt: optionalId(codec, r.coverArt ?? r.albumId ?? native) || id,
    size: Math.max(0, int(r.size)),
    contentType,
    suffix,
    duration: Math.max(0, int(r.duration)),
    bitRate: Math.max(0, int(r.bitRate)),
    path: str(r.path),
    playCount: Math.max(0, int(r.playCount)),
    created: iso(r.created),
    type: 'music',
  };
  const artists = artistRefs(codec, r.artists);
  if (artists) song.artists = artists;
  const albumArtists = artistRefs(codec, r.albumArtists);
  if (albumArtists) song.albumArtists = albumArtists;
  const mb = mbid(r.musicBrainzId);
  if (mb) song.musicBrainzId = mb;
  const gain = replayGain(r.replayGain);
  if (gain) song.replayGain = gain;
  return song;
}

export function normAlbum(raw: unknown, codec: IdCodec, warn: Warn): SubAlbum | undefined {
  const r = rec(raw);
  const native = idStr(r?.id);
  const id = native ? codec.encode(native) : undefined;
  if (!r || !id) {
    warn(`dropped an album with an unusable id (${native ? `'${native.slice(0, 80)}'` : 'none'})`);
    return undefined;
  }
  const genres = genreNames(r.genres ?? r.genre);
  const album: SubAlbum = {
    id,
    name: str(r.name) || str(r.title),
    artist: str(r.artist),
    artistId: optionalId(codec, r.artistId),
    coverArt: optionalId(codec, r.coverArt ?? native) || id,
    songCount: Math.max(0, int(r.songCount)),
    duration: Math.max(0, int(r.duration)),
    playCount: Math.max(0, int(r.playCount)),
    created: iso(r.created),
    year: int(r.year),
    genre: genres[0] ?? '',
    genres: genres.map((name) => ({ name })),
  };
  const artists = artistRefs(codec, r.artists);
  if (artists) album.artists = artists;
  if (r.isCompilation === true) album.isCompilation = true;
  const original = dateParts(r.originalReleaseDate);
  if (original) album.originalReleaseDate = original;
  const release = dateParts(r.releaseDate);
  if (release) album.releaseDate = release;
  const mb = mbid(r.musicBrainzId);
  if (mb) album.musicBrainzId = mb;
  return album;
}

export function normArtist(raw: unknown, codec: IdCodec, warn: Warn): SubArtist | undefined {
  const r = rec(raw);
  const native = idStr(r?.id);
  const id = native ? codec.encode(native) : undefined;
  if (!r || !id) {
    warn(`dropped an artist with an unusable id (${native ? `'${native.slice(0, 80)}'` : 'none'})`);
    return undefined;
  }
  const artist: SubArtist = {
    id,
    name: str(r.name),
    coverArt: optionalId(codec, r.coverArt ?? native) || id,
    albumCount: Math.max(0, int(r.albumCount)),
  };
  const mb = mbid(r.musicBrainzId);
  if (mb) artist.musicBrainzId = mb;
  return artist;
}

export function normGenre(raw: unknown): SubGenre | undefined {
  const r = rec(raw);
  const value = (typeof raw === 'string' ? raw : str(r?.name) || str(r?.value)).trim();
  if (!value) return undefined;
  return { value, songCount: Math.max(0, int(r?.songCount)), albumCount: Math.max(0, int(r?.albumCount)) };
}

export function normArtistInfo(raw: unknown, codec: IdCodec, warn: Warn): SubArtistInfo | undefined {
  const r = rec(raw);
  if (!r) return undefined;
  return {
    biography: str(r.biography),
    musicBrainzId: str(r.musicBrainzId),
    lastFmUrl: str(r.lastFmUrl),
    similarArtists: list(r.similarArtists, (a) => normArtist(a, codec, warn)),
    tags: genreNames(r.tags),
  };
}

export function normPlaylist(raw: unknown, codec: IdCodec, warn: Warn): SubPlaylist | undefined {
  const r = rec(raw);
  const native = idStr(r?.id);
  const id = native ? codec.encode(native) : undefined;
  if (!r || !id) {
    warn(`dropped a playlist with an unusable id (${native ? `'${native.slice(0, 80)}'` : 'none'})`);
    return undefined;
  }
  const created = iso(r.created);
  return {
    id,
    name: str(r.name),
    comment: str(r.comment),
    public: r.public === true,
    owner: str(r.owner),
    created,
    changed: r.changed ? iso(r.changed) : created,
    songs: list(r.songs, (s) => normSong(s, codec, warn)),
  };
}

export function normLyrics(raw: unknown): SubLyrics | null | undefined {
  if (raw === undefined) return undefined;
  const r = rec(raw);
  if (!r) return null;
  const lines = Array.isArray(r.lines) ? r.lines.map(str).filter(Boolean) : [];
  if (!lines.length) return null;
  return { displayArtist: str(r.displayArtist), displayTitle: str(r.displayTitle), lines };
}

/** Map a plugin's array through a normaliser, tolerating a non-array answer. */
export function list<T>(raw: unknown, fn: (item: unknown) => T | undefined): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  for (const item of raw) {
    const v = fn(item);
    if (v !== undefined) out.push(v);
  }
  return out;
}
