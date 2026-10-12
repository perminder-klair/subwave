// The router's internal view of a source: Subsonic-shaped objects with
// PUBLISHED ids, and every op present. A wrapped plugin (wrap.ts) and the
// merged set (composite.ts) both implement HostSource, so the Subsonic
// handlers never learn which one they are talking to.

import type { AlbumListType, PlaylistPatch, RandomSongsFilter, ReplayGain, SearchLimits, Stats } from '../sdk/types.js';

export interface SubArtistRef {
  id: string;
  name: string;
}

export interface SubDate {
  year: number;
  month: number;
  day: number;
}

export interface SubSong {
  id: string;
  parent: string;
  isDir: false;
  title: string;
  album: string;
  albumId: string;
  artist: string;
  artistId: string;
  artists?: SubArtistRef[];
  albumArtists?: SubArtistRef[];
  track: number;
  discNumber: number;
  year: number;
  genre: string;
  genres: { name: string }[];
  coverArt: string;
  size: number;
  contentType: string;
  suffix: string;
  duration: number;
  bitRate: number;
  path: string;
  playCount: number;
  created: string;
  type: 'music';
  musicBrainzId?: string;
  replayGain?: ReplayGain;
}

export interface SubAlbum {
  id: string;
  name: string;
  artist: string;
  artistId: string;
  artists?: SubArtistRef[];
  coverArt: string;
  songCount: number;
  duration: number;
  playCount: number;
  created: string;
  year: number;
  genre: string;
  genres: { name: string }[];
  isCompilation?: boolean;
  originalReleaseDate?: SubDate;
  releaseDate?: SubDate;
  musicBrainzId?: string;
}

export interface SubArtist {
  id: string;
  name: string;
  coverArt: string;
  albumCount: number;
  musicBrainzId?: string;
}

export interface SubGenre {
  value: string;
  songCount: number;
  albumCount: number;
}

export interface SubArtistInfo {
  biography: string;
  musicBrainzId: string;
  lastFmUrl: string;
  similarArtists: SubArtist[];
  tags: string[];
}

export interface SubPlaylist {
  id: string;
  name: string;
  comment: string;
  public: boolean;
  owner: string;
  created: string;
  changed: string;
  songs: SubSong[];
}

export interface SubLyrics {
  displayArtist: string;
  displayTitle: string;
  lines: string[];
}

/** A stream, resolved to bytes the HTTP layer can pipe. */
export interface ResolvedStream {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array> | null;
}

export interface ResolvedArt {
  contentType: string;
  data: Uint8Array;
}

export interface Capabilities {
  sonicSimilarity: boolean;
  artists: boolean;
  artistInfo: boolean;
  similarSongs: boolean;
  topSongs: boolean;
  lyrics: boolean;
  stars: boolean;
  playlists: boolean;
  scrobble: boolean;
  scanStatus: boolean;
  stats: boolean;
}

/** An op the source does not implement; handlers turn it into Subsonic error 0. */
export class UnsupportedError extends Error {
  constructor(
    readonly source: string,
    readonly op: string,
  ) {
    super(`${op} is not supported by the ${source} music source`);
    this.name = 'UnsupportedError';
  }
}

export interface HostSource {
  /** Plugin name, or `a+b` for a merged set. */
  name: string;
  label: string;
  capabilities: Capabilities;
  /** Publishes native ids unprefixed (ids.ts rawCodec); owns whatever no prefixed source claims. */
  rawIds: boolean;
  owns(id: string): boolean;

  song(id: string): Promise<SubSong | undefined>;
  album(id: string): Promise<{ album: SubAlbum; songs: SubSong[] } | undefined>;
  artist(id: string): Promise<{ artist: SubArtist; albums: SubAlbum[] } | undefined>;
  artists(): Promise<SubArtist[]>;
  artistInfo(id: string, count: number): Promise<SubArtistInfo | undefined>;
  genres(): Promise<SubGenre[]>;
  albumList(type: AlbumListType, size: number, offset: number): Promise<SubAlbum[]>;
  songsByGenre(genre: string, count: number, offset: number): Promise<SubSong[]>;
  randomSongs(size: number, filter: RandomSongsFilter): Promise<SubSong[]>;
  search(query: string, limits: SearchLimits): Promise<{ artists: SubArtist[]; albums: SubAlbum[]; songs: SubSong[] }>;
  similarSongs(id: string, count: number): Promise<SubSong[]>;
  /** Audio-based neighbours (getSonicSimilarTracks); empty when the source has none. */
  sonicSimilar(id: string, count: number): Promise<SubSong[]>;
  topSongs(artistName: string, count: number): Promise<SubSong[]>;

  starred(): Promise<Map<string, string>>;
  starredSongs(): Promise<SubSong[]>;
  star(ids: string[]): Promise<void>;
  unstar(ids: string[]): Promise<void>;

  playlists(): Promise<SubPlaylist[]>;
  playlist(id: string): Promise<SubPlaylist | undefined>;
  createPlaylist(name: string, songIds: string[]): Promise<SubPlaylist>;
  overwritePlaylist(id: string, name: string | undefined, songIds: string[]): Promise<SubPlaylist | undefined>;
  updatePlaylist(id: string, patch: PlaylistPatch): Promise<SubPlaylist | undefined>;
  deletePlaylist(id: string): Promise<boolean>;

  stream(id: string, range: string | undefined): Promise<ResolvedStream | undefined>;
  coverArt(id: string, size: number): Promise<ResolvedArt | undefined>;
  lyrics(id: string): Promise<SubLyrics | null | undefined>;

  scrobble(id: string, opts: { submission: boolean; time?: number }): Promise<void>;
  /** null = the source cannot say. */
  scanStatus(): Promise<{ scanning: boolean; count: number } | null>;
  stats(): Promise<Stats>;

  close(): Promise<void>;
}
