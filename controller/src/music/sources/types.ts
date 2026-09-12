// The pluggable music-source contract. One active source at a time (selected by
// `settings.music.source`); the facade in `music/source.ts` delegates the names
// call sites use today to whichever source the registry resolves.
//
// Shapes and names mirror upstream PR #843 (perminder-klair/subwave,
// `worktree-pluggable-music-sources`) on purpose, so a later upstream merge of
// that branch lands here as near-duplicate hunks rather than a rewrite.
//
// Method signatures are the Subsonic client's own (`typeof client.x`, a TYPE-only
// import — no runtime edge). That is deliberate rather than lazy: the client is
// the reference contract every caller was written against, its parameters are
// loosely typed on purpose (the queue stamps transient fields onto song objects
// before getAnnotatedUri reads them), and re-declaring them tighter here turned
// forty call sites red for no behavioural gain. A new source implements exactly
// what callers already pass.
//
// The song/album/artist shapes below are the raw Subsonic "Child" objects
// consumers depend on; a source must hand back plain, mutable objects.

import type * as client from '../subsonic.js';

export interface Song {
  id: string;
  title?: string;
  artist?: string;
  album?: string;
  albumId?: string;
  artistId?: string;
  year?: number;
  genre?: string;
  genres?: any;
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
// that holds the bytes itself returns them directly.
export type CoverArt = { url: string } | { buf: Buffer; contentType: string };

// Audio for the acoustic-analysis worker: an HTTP URL to fetch, or a local file
// path on the shared /var/sub-wave mount (the sidecar sees the same path). A
// source with no fetchable audio (a streaming service) returns null and the
// analysis pass skips the track cleanly.
export type AnalyzableRef = { url: string } | { path: string };

export type AnnotateOpts = NonNullable<Parameters<typeof client.getAnnotatedUri>[1]>;

// Whether a full catalogue walk can be trusted as the complete live set.
// `reason` is operator-facing and appears verbatim in the skipped-prune line, so
// it names what was missing, not an error class.
export type CatalogHealth = { complete: boolean; reason?: string };

export interface MusicSource {
  // Matches a `MUSIC_SOURCES` entry in schemas/settings.ts.
  readonly id: string;

  // ── CORE — a source is unusable without these ───────────────────────────
  ping: typeof client.ping;
  // `includeBlocked` is honoured only by sources that enforce the never-play
  // blocklist at the source level (Subsonic); others ignore it. Used by the
  // admin search surface so the operator can still find blocked tracks.
  search: typeof client.search;
  getSong: typeof client.getSong;
  getAlbum: typeof client.getAlbum;
  getArtist: typeof client.getArtist;
  searchArtists: typeof client.searchArtists;
  getGenres: typeof client.getGenres;
  getRandomSongs: typeof client.getRandomSongs;
  getSongsByGenre: typeof client.getSongsByGenre;
  getSongsByGenreSampled: typeof client.getSongsByGenreSampled;
  getAlbumList: typeof client.getAlbumList;
  iterateAllSongs: typeof client.iterateAllSongs;
  getCoverArt(id: string, size?: number): Promise<CoverArt | null>;
  getAnalyzableRef(songId: string): Promise<AnalyzableRef | null>;
  // Fuzzy resolvers over the source's own tags/artists (library-relative).
  resolveGenreName: typeof client.resolveGenreName;
  resolveArtist: typeof client.resolveArtist;
  getRecentSongsByArtist: typeof client.getRecentSongsByArtist;

  // Was the last `iterateAllSongs()` walk AUTHORITATIVE — i.e. is "not in this
  // walk" safe to read as "gone from the library"? Only the destructive
  // reconcile asks (music/prune-policy.ts): the tagger and analyzer delete a
  // track's tags, vectors and analysis for every id the walk did not yield.
  //
  // OPTIONAL, and its absence means `complete: true` — a source that says
  // nothing prunes exactly as it always has. That default points the OPPOSITE
  // way from the guard itself on purpose: Subsonic's walk is all-or-nothing
  // (the API answers or it doesn't, which `walked > 0` already catches), so
  // making silence mean "unsafe" would switch off reconcile for every existing
  // station. Only a source that can degrade PARTIALLY implements this and says
  // so — Spotify's pool can come back short from a 403, a rate-limit window or
  // a maxTracks truncation, all of which look exactly like deletion.
  catalogHealth?(): Promise<CatalogHealth>;

  // ── PLAYBACK — file/URL sources only. A source that hands Liquidsoap a
  //    request URI implements these; a live-transport source (capabilities
  //    hasLiveTransport) leaves them absent and the queue never calls them. ──
  getPlayableUri?: typeof client.getPlayableUri;
  getLocalPath?: typeof client.getLocalPath;
  getAnnotatedUri?: typeof client.getAnnotatedUri;
  getClipUri?: typeof client.getClipUri;

  // ── DISCOVERY / FEEDBACK — optional; the facade returns neutral empties when
  //    a source lacks one (declared by the capabilities table, not probed) ──
  getSimilarSongs?: typeof client.getSimilarSongs;
  supportsSonicSimilarity?: typeof client.supportsSonicSimilarity;
  getSonicSimilarTracks?: typeof client.getSonicSimilarTracks;
  getStarred?: typeof client.getStarred;
  star?: typeof client.star;
  unstar?: typeof client.unstar;
  scrobble?: typeof client.scrobble;
  getTopSongs?: typeof client.getTopSongs;
  getArtistInfo?: typeof client.getArtistInfo;
  getArtistLastfmTags?: typeof client.getArtistLastfmTags;
  getLyrics?: typeof client.getLyrics;
  getStructuredLyrics?: typeof client.getStructuredLyrics;
  getPlaylists?: typeof client.getPlaylists;
  getPlaylist?: typeof client.getPlaylist;
  createPlaylist?: typeof client.createPlaylist;
  addToPlaylist?: typeof client.addToPlaylist;
  removeFromPlaylist?: typeof client.removeFromPlaylist;
  updatePlaylistMeta?: typeof client.updatePlaylistMeta;
  deletePlaylist?: typeof client.deletePlaylist;
  getRecentlyAddedAlbums?: typeof client.getRecentlyAddedAlbums;
  getFrequentAlbums?: typeof client.getFrequentAlbums;

  // The newest TRACKS, newest first — a direct answer to the question
  // `GET /dj/recent` actually asks. This has no Subsonic client counterpart on
  // purpose: there the answer is composed cheaply from newest-albums plus an
  // album fetch each, and that composition stays in the route. A source whose
  // per-request cost makes that fan-out unaffordable (Spotify meters every
  // call, and the pool already holds each track's `added_at` as `created`)
  // implements this instead and the route asks here first.
  //
  // An empty array means "I cannot answer right now" — not "there are none" —
  // so the caller falls back to the fan-out rather than rendering a blank list.
  getRecentSongs?(opts?: { size?: number }): Promise<Song[]>;
}
