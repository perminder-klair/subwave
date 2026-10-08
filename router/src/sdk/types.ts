// The music-source plugin contract. Everything a plugin author touches is in
// this file and index.ts; nothing here imports from the rest of the router, so
// the directory can be published as its own package (@subwave/source-sdk).
//
// Two rules shape the whole contract:
//
//   1. Plugins speak NATIVE ids — whatever their backend uses. The router
//      namespaces every id on the way out and strips it on the way in
//      (src/host/ids.ts), so a plugin cannot collide with another source or
//      publish an id the station cannot carry.
//   2. Plugins return LOOSE objects. Only `id` and the name field are
//      required; the router validates and fills every other field with a
//      neutral default before the controller sees it (src/host/normalize.ts).

/** The plugin API major version this router implements. */
export const SOURCE_API_VERSION = 1;

// --- manifest ------------------------------------------------------------------

export type ConfigFieldType = 'url' | 'string' | 'secret' | 'number' | 'boolean' | 'select';

export interface ConfigField {
  /** Key the value arrives under in `ctx.config`. */
  key: string;
  label: string;
  type: ConfigFieldType;
  required?: boolean;
  default?: string | number | boolean;
  /** For `select`. */
  options?: { value: string; label: string }[];
  help?: string;
  placeholder?: string;
  /** Environment variable that overrides the stored value (and locks the field in the UI). */
  env?: string;
  /**
   * Whether changing this value changes the ids the source publishes — a
   * server address or a library section does, a display toggle does not. The
   * station re-links its library (tags, likes, the blocklist) only when such a
   * value changes. Mark at least one field either way to opt in; a plugin that
   * marks none is treated as if every non-secret field changes ids.
   */
  affectsIds?: boolean;
}

/** Contents of `subwave-source.json`. */
export interface SourceManifest {
  /** `^[a-z][a-z0-9-]{1,31}$`; unique across installed plugins. */
  name: string;
  label: string;
  description?: string;
  version: string;
  /** Plugin API major version the plugin was written against. */
  apiVersion: number;
  /** `^[a-z][a-z0-9]{1,5}$`; the router publishes ids as `<idPrefix>-<native>`. */
  idPrefix: string;
  /** Entry module, relative to the manifest. Defaults to `index.mjs`. */
  entry?: string;
  homepage?: string;
  config?: ConfigField[];
}

// --- canonical model (native ids, loose) -----------------------------------------

export interface ReplayGain {
  /** dB */
  trackGain?: number;
  /** linear, 1.0 = full scale */
  trackPeak?: number;
  albumGain?: number;
  albumPeak?: number;
}

export interface ArtistRef {
  id: string;
  name: string;
}

export interface DateParts {
  year: number;
  month?: number;
  day?: number;
}

export interface Song {
  id: string;
  title: string;
  album?: string;
  albumId?: string;
  artist?: string;
  artistId?: string;
  /** Every credited artist, when the backend knows them. */
  artists?: ArtistRef[];
  albumArtists?: ArtistRef[];
  track?: number;
  discNumber?: number;
  year?: number;
  genres?: string[];
  /** Id to request art with; usually the album id. Defaults to `albumId`, then `id`. */
  coverArt?: string;
  size?: number;
  contentType?: string;
  suffix?: string;
  /** Seconds. */
  duration?: number;
  /** kbps. */
  bitRate?: number;
  path?: string;
  playCount?: number;
  /** ISO timestamp. */
  created?: string;
  musicBrainzId?: string;
  /** Only when measured — never invent 0 dB, which reads as "measured, no change needed". */
  replayGain?: ReplayGain;
}

export interface Album {
  id: string;
  name: string;
  artist?: string;
  artistId?: string;
  artists?: ArtistRef[];
  coverArt?: string;
  songCount?: number;
  duration?: number;
  playCount?: number;
  created?: string;
  year?: number;
  genres?: string[];
  isCompilation?: boolean;
  /** The first release, when this edition is a reissue. */
  originalReleaseDate?: DateParts;
  /** This edition's release date. */
  releaseDate?: DateParts;
  musicBrainzId?: string;
}

export interface Artist {
  id: string;
  name: string;
  coverArt?: string;
  albumCount?: number;
  musicBrainzId?: string;
}

export interface GenreCount {
  name: string;
  songCount?: number;
  albumCount?: number;
}

export interface ArtistInfo {
  biography?: string;
  musicBrainzId?: string;
  lastFmUrl?: string;
  similarArtists?: Artist[];
  tags?: string[];
}

export interface Playlist {
  id: string;
  name: string;
  comment?: string;
  public?: boolean;
  owner?: string;
  created?: string;
  changed?: string;
  songs: Song[];
}

export interface PlaylistPatch {
  name?: string;
  comment?: string;
  public?: boolean;
  addIds?: string[];
  removeIndexes?: number[];
}

export type AlbumListType = 'alphabeticalByName' | 'newest' | 'frequent' | 'random';

export interface RandomSongsFilter {
  genre?: string;
  fromYear?: number;
  toYear?: number;
}

export interface SearchLimits {
  artistCount: number;
  albumCount: number;
  songCount: number;
}

export interface SearchResult {
  artists: Artist[];
  albums: Album[];
  songs: Song[];
}

export interface Lyrics {
  displayArtist?: string;
  displayTitle?: string;
  lines: string[];
}

export interface Stats {
  artists: number;
  albums: number;
  songs: number;
  genres: number;
}

// --- media -----------------------------------------------------------------------

export type ByteBody = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | Uint8Array;

/**
 * What `stream()` hands back. The router does the HTTP work — Range
 * passthrough, header filtering and the guard that refuses a text/JSON body
 * dressed up as audio — so a plugin only says where the bytes are.
 */
export type StreamResult =
  /** The router fetches this URL itself, forwarding the client's Range header. */
  | { url: string; headers?: Record<string, string> }
  /** A response the plugin already fetched. */
  | { response: Response }
  /** Bytes the plugin produced. */
  | { body: ByteBody; status?: number; headers?: Record<string, string> };

export type CoverArt =
  | { contentType: string; data: Uint8Array }
  | { url: string; headers?: Record<string, string> };

// --- the plugin ----------------------------------------------------------------------

export interface SourceLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface SourceContext {
  /** Config values from the operator's form, environment overrides applied, defaults filled. */
  config: Readonly<Record<string, string | number | boolean | undefined>>;
  /** `fetch` with a default timeout; pass your own `signal` to override it. */
  fetch: typeof fetch;
  log: SourceLogger;
  /** A writable directory private to this plugin (state/router/data/<name>). */
  dataDir: string;
}

/**
 * A music source. Required ops answer the controller's everyday reads; every
 * optional op is a capability the router introspects — leave it out and the
 * station degrades (empty lists, unadvertised extensions) instead of failing.
 *
 * Lookups return `undefined` for an unknown id. Throw for real failures
 * (backend down, bad credentials): the router reports those as unhealthy.
 */
export interface SourcePlugin {
  capabilities?: {
    /** Advertise the OpenSubsonic sonicSimilarity extension (served by similarSongs). */
    sonicSimilarity?: boolean;
  };

  // browsing — required
  song(id: string): Promise<Song | undefined>;
  album(id: string): Promise<{ album: Album; songs: Song[] } | undefined>;
  artist(id: string): Promise<{ artist: Artist; albums: Album[] } | undefined>;
  genres(): Promise<GenreCount[]>;
  albumList(type: AlbumListType, size: number, offset: number): Promise<Album[]>;
  songsByGenre(genre: string, count: number, offset: number): Promise<Song[]>;
  randomSongs(size: number, filter: RandomSongsFilter): Promise<Song[]>;
  search(query: string, limits: SearchLimits): Promise<SearchResult>;

  // media — required
  stream(id: string, opts: { range?: string }): Promise<StreamResult | undefined>;
  coverArt(id: string, size: number): Promise<CoverArt | undefined>;

  // browsing — optional
  /** Every artist in the library. */
  artists?(): Promise<Artist[]>;
  artistInfo?(id: string, count: number): Promise<ArtistInfo | undefined>;
  /** `id` may be a song or an artist id. */
  similarSongs?(id: string, count: number): Promise<Song[]>;
  topSongs?(artistName: string, count: number): Promise<Song[]>;
  /** `undefined` = unknown id; `null` = the song exists but has no lyrics. */
  lyrics?(id: string): Promise<Lyrics | null | undefined>;

  // stars — optional as a group
  starred?(): Promise<Map<string, string> | Record<string, string>>;
  starredSongs?(): Promise<Song[]>;
  star?(ids: string[]): Promise<void>;
  unstar?(ids: string[]): Promise<void>;

  // playlists — optional as a group
  playlists?(): Promise<Playlist[]>;
  playlist?(id: string): Promise<Playlist | undefined>;
  createPlaylist?(name: string, songIds: string[]): Promise<Playlist>;
  /** Replace the playlist's songs wholesale. */
  overwritePlaylist?(id: string, name: string | undefined, songIds: string[]): Promise<Playlist | undefined>;
  updatePlaylist?(id: string, patch: PlaylistPatch): Promise<Playlist | undefined>;
  deletePlaylist?(id: string): Promise<boolean>;

  // station signals — optional
  /** A play reached the station's listeners (`submission`) or started (`!submission`). */
  scrobble?(id: string, opts: { submission: boolean; time?: number }): Promise<void>;
  /** Whether the backend is rescanning its library; the controller holds pruning meanwhile. */
  scanStatus?(): Promise<{ scanning: boolean; count?: number }>;
  /** Library counts; also the router's health probe. */
  stats?(): Promise<Stats>;

  /** Called when the router swaps this instance out. Clear timers here. */
  close?(): void | Promise<void>;
}

export type SourceFactory = (ctx: SourceContext) => SourcePlugin | Promise<SourcePlugin>;
