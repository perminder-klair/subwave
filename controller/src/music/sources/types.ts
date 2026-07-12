// The pluggable music-source contract. One active source at a time (selected by
// `settings.music.source`); the facade in `music/source.ts` delegates the names
// call sites use today to whichever source the registry resolves.
//
// The song/album/artist shapes are deliberately loose (`[key: string]: any`):
// they mirror the raw Subsonic "Child" objects consumers already depend on, and
// the queue/DJ pipeline STAMPS transient fields (crossSec, gainDb, sweep,
// dissolve, washout, washoutDelay, blend) onto song objects before
// getAnnotatedUri reads them — a source must hand back plain, mutable objects.

export interface Song {
  id: string;
  title?: string;
  artist?: string;
  album?: string;
  albumId?: string;
  year?: number;
  genre?: string;
  path?: string;
  duration?: number;
  coverArt?: string;
  [key: string]: any;
}

export interface Artist {
  id: string;
  name: string;
  [key: string]: any;
}

export interface Album {
  id: string;
  name?: string;
  year?: number;
  [key: string]: any;
}

export interface Genre {
  value: string;
  songCount?: number;
  albumCount?: number;
}

export interface Playlist {
  id: string;
  name?: string;
  [key: string]: any;
}

// Cover art is served two ways: a source that already exposes an authenticated
// URL (Subsonic) returns `{ url }` and the /cover/:id route proxies it; a source
// that reads bytes off disk (local folder) returns them directly.
export type CoverArt = { url: string } | { buf: Buffer; contentType: string };

// Audio for the acoustic-analysis worker: an HTTP URL to fetch, or a local file
// path on the shared /var/sub-wave mount (the sidecar sees the same path).
export type AnalyzableRef = { url: string } | { path: string };

export interface MusicSource {
  // Matches a `MUSIC_SOURCES` entry in settings.ts.
  readonly id: string;

  // ── CORE — a source is unusable without these ───────────────────────────
  ping(): Promise<{ ok: boolean; reason?: string }>;
  // `includeBlocked` is honoured only by sources that enforce the never-play
  // blocklist at the source level (Subsonic); others ignore it. Used by the
  // admin search surface so the operator can still find blocked tracks.
  search(query: string, opts?: { songCount?: number; songOffset?: number; includeBlocked?: boolean }): Promise<Song[]>;
  getSong(id: string): Promise<Song | null>;
  getAlbum(id: string): Promise<Song[]>;
  getArtist(id: string): Promise<Artist | null>;
  searchArtists(query: string, opts?: { artistCount?: number }): Promise<Artist[]>;
  getGenres(): Promise<Genre[]>;
  getRandomSongs(opts?: { size?: number; genre?: string; fromYear?: number; toYear?: number }): Promise<Song[]>;
  getSongsByGenre(genre: string, opts?: { count?: number }): Promise<Song[]>;
  getAlbumList(offset?: number, size?: number): Promise<Album[]>;
  iterateAllSongs(): AsyncGenerator<Song>;
  getPlayableUri(song: Song): string;
  getCoverArt(id: string, size?: number): Promise<CoverArt | null>;
  getAnalyzableRef(songId: string): Promise<AnalyzableRef | null>;

  // ── DISCOVERY — optional; the facade returns neutral empties when a source
  //    lacks one (declared by the capabilities table, not probed per call) ──
  getSimilarSongs?(id: string, opts?: { count?: number }): Promise<Song[]>;
  supportsSonicSimilarity?(): Promise<boolean>;
  getSonicSimilarTracks?(id: string, opts?: { count?: number }): Promise<Song[]>;
  getStarred?(): Promise<Song[]>;
  getTopSongs?(artistName: string, opts?: { count?: number }): Promise<Song[]>;
  getArtistInfo?(id: string, opts?: { count?: number }): Promise<any | null>;
  getArtistLastfmTags?(id: string, opts?: { count?: number }): Promise<string[]>;
  getLyrics?(songId: string): Promise<string>;
  getPlaylists?(): Promise<Playlist[]>;
  getPlaylist?(id: string): Promise<Song[]>;
  getRecentlyAddedAlbums?(opts?: { size?: number }): Promise<Album[]>;
  getFrequentAlbums?(opts?: { size?: number }): Promise<Album[]>;
}
