// Music source kit — the types and helpers shared by every provider.
//
// Split out from source.ts (the accessor/registry) so provider modules can
// import the interface, the no-op defaults, the id helpers and the annotate
// builder WITHOUT importing source.ts itself — source.ts imports the providers
// to register them, and that back-edge would be a runtime cycle. The kit imports
// only settings + config (leaf modules), so it sits cleanly underneath both.
//
// Design notes live with the types below; see also docs/music-sources.md.

import * as settings from '../settings.js';
import { config } from '../config.js';

// A track as it flows through the picker/queue. Deliberately permissive (index
// signature) because the existing code treats songs as `any` and tacks on extra
// fields freely; this type documents the load-bearing ones without forcing a
// retype of every call site. Provider-supplied fields come first; analysis fields
// are added by the tagger/library; transient fields are stamped by the
// queue/picker AFTER the provider returns (so a provider need not carry them, but
// must return a plain mutable object).
export interface Song {
  id: string;
  title?: string;
  artist?: string;
  album?: string;
  albumId?: string;
  year?: number;
  genre?: string;
  path?: string;        // for isStationArchive() pattern check + local playback
  coverArt?: string;
  duration?: number;
  // analysis (music/library.*, music/analyzer.ts)
  bpm?: number;
  musicalKey?: string;
  introMs?: number;
  loudnessLufs?: number;
  // transient (broadcast/queue.ts, music/picker.ts)
  crossSec?: number;    // DJ-mode per-transition crossfade length
  gainDb?: number;      // loudness-normalisation offset
  _source?: string;     // picker source label
  _similarity?: number; // KNN similarity score
  [k: string]: any;
}

// Per-provider feature flags. The picker (buildCandidates) and agent
// (buildPickerTools) read these to decide which discovery surfaces to use; a
// `false` flag means "calling the matching method is pointless here" — the method
// still exists and returns empty, so a stray call is safe.
export interface SourceCapabilities {
  pool: boolean;            // can fill a candidate pool (false for resolver-only sources)
  similar: boolean;
  genre: boolean;
  playlists: boolean;
  starred: boolean;
  recentlyAdded: boolean;
  frequent: boolean;
  artistGraph: boolean;    // Last.fm-style top-songs / similar-artist
  sonicSimilarity: boolean;
  lyrics: boolean;
  libraryWalk: boolean;    // iterateAllSongs() — taggable finite catalogue
}

export interface MusicSource {
  key: string;
  capabilities: SourceCapabilities;

  // --- required core (every provider) ---
  search(query: string, opts?: { songCount?: number; songOffset?: number }): Promise<Song[]>;
  getRandomSongs(opts?: { size?: number; genre?: string; fromYear?: number; toYear?: number }): Promise<Song[]>;
  getAnnotatedUri(song: Song): string;
  getCoverArtUrl(id: string, size?: number): string | null;
  isStationArchive(song: any): boolean;

  // --- discovery surface (capability-gated; unsupported → empty/null/false) ---
  getSongsByGenre(genre: string, opts?: { count?: number }): Promise<Song[]>;
  getGenres(): Promise<any[]>;
  resolveGenreName(name: string): Promise<string | null>;
  resolveArtist(name: string, opts?: { artistCount?: number }): Promise<any | null>;
  getSimilarSongs(id: string, opts?: { count?: number }): Promise<Song[]>;
  supportsSonicSimilarity(): Promise<boolean>;
  getSonicSimilarTracks(id: string, opts?: { count?: number }): Promise<Song[]>;
  getStarred(): Promise<Song[]>;
  getAlbumList(offset?: number, size?: number): Promise<any[]>;
  getRecentlyAddedAlbums(opts?: { size?: number }): Promise<any[]>;
  getFrequentAlbums(opts?: { size?: number }): Promise<any[]>;
  getArtistInfo(id: string, opts?: { count?: number }): Promise<any | null>;
  getTopSongs(artistName: string, opts?: { count?: number }): Promise<Song[]>;
  getRecentSongsByArtist(artistName: string, opts?: { albums?: number; count?: number }): Promise<Song[]>;
  getAlbum(id: string): Promise<Song[]>;
  getSong(id: string): Promise<Song | null>;
  getArtist(id: string): Promise<any | null>;
  searchArtists(query: string, opts?: { artistCount?: number }): Promise<any[]>;
  getArtistLastfmTags(id: string, opts?: { count?: number }): Promise<string[]>;
  getLyrics(songId: string): Promise<string>;
  iterateAllSongs(): AsyncGenerator<Song>;
  getPlaylists(): Promise<any[]>;
  getPlaylist(id: string): Promise<Song[]>;
  getRawStreamUrl(songId: string): string;
}

// Default no-op implementations for the capability-gated methods. Thin providers
// spread this so they only write the methods they actually support; everything
// else returns the safe empty value. The required-core methods are intentionally
// absent here — every provider MUST implement those.
export const emptyDiscovery = {
  async getSongsByGenre(): Promise<Song[]> { return []; },
  async getGenres(): Promise<any[]> { return []; },
  async resolveGenreName(): Promise<string | null> { return null; },
  async resolveArtist(): Promise<any | null> { return null; },
  async getSimilarSongs(): Promise<Song[]> { return []; },
  async supportsSonicSimilarity(): Promise<boolean> { return false; },
  async getSonicSimilarTracks(): Promise<Song[]> { return []; },
  async getStarred(): Promise<Song[]> { return []; },
  async getAlbumList(): Promise<any[]> { return []; },
  async getRecentlyAddedAlbums(): Promise<any[]> { return []; },
  async getFrequentAlbums(): Promise<any[]> { return []; },
  async getArtistInfo(): Promise<any | null> { return null; },
  async getTopSongs(): Promise<Song[]> { return []; },
  async getRecentSongsByArtist(): Promise<Song[]> { return []; },
  async getAlbum(): Promise<Song[]> { return []; },
  async getSong(): Promise<Song | null> { return null; },
  async getArtist(): Promise<any | null> { return null; },
  async searchArtists(): Promise<any[]> { return []; },
  async getArtistLastfmTags(): Promise<string[]> { return []; },
  async getLyrics(): Promise<string> { return ''; },
  async *iterateAllSongs(): AsyncGenerator<Song> { /* nothing to walk */ },
  async getPlaylists(): Promise<any[]> { return []; },
  async getPlaylist(): Promise<Song[]> { return []; },
  getRawStreamUrl(): string { return ''; },
};

// ---------------------------------------------------------------------------
// Id namespacing
// ---------------------------------------------------------------------------
// Single-active-source today, but ids are prefixed at the boundary so /cover/:id
// (and a future multi-source picker) can route by provider. Navidrome keeps
// emitting native ids for back-compat; parseId tolerates BOTH a prefixed id and a
// bare native id (→ provider:null → caller uses the active source).
export const PROVIDER_PREFIX: Record<string, string> = {
  navidrome: 'nd',
  jellyfin: 'jf',
  jamendo: 'jam',
  local: 'local',
};
const PREFIX_TO_PROVIDER: Record<string, string> = Object.fromEntries(
  Object.entries(PROVIDER_PREFIX).map(([k, v]) => [v, k]),
);

export function namespaceId(provider: string, id: string | number): string {
  const p = PROVIDER_PREFIX[provider];
  return p ? `${p}:${id}` : String(id);
}

export function parseId(id: string): { provider: string | null; raw: string } {
  const s = String(id ?? '');
  const m = /^([a-z]+):(.+)$/.exec(s);
  if (m && PREFIX_TO_PROVIDER[m[1]]) {
    return { provider: PREFIX_TO_PROVIDER[m[1]], raw: m[2] };
  }
  return { provider: null, raw: s };
}

// ---------------------------------------------------------------------------
// Annotate URI builder
// ---------------------------------------------------------------------------
// The single thing written to next.txt: a Liquidsoap `annotate:` URI with
// metadata embedded up front so on_metadata reports real artist/title/album
// immediately (not waiting on stream-level ID3) and can recover the (namespaced)
// id for /cover/:id. subsonic.ts has its own copy keyed to its local-path logic;
// this shared one is for providers whose playable URI is a plain/wrapped URL.
function escAnnotate(s: any): string {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function buildAnnotateUri(song: Song, playableUri: string): string {
  const fields = [
    `title="${escAnnotate(song.title)}"`,
    `artist="${escAnnotate(song.artist)}"`,
    `album="${escAnnotate(song.album)}"`,
    `subsonic_id="${escAnnotate(song.id)}"`,
  ];
  if (song.year) fields.push(`year="${escAnnotate(song.year)}"`);
  if (song.genre) fields.push(`genre="${escAnnotate(song.genre)}"`);
  // DJ-mode adaptive blend + loudness gain — stamped by the queue. Same keys
  // radio.liq's dj_transition / amplify(override=...) read. Absent → defaults.
  if (song.crossSec != null) fields.push(`liq_cross_duration="${escAnnotate(song.crossSec)}"`);
  if (song.gainDb != null) fields.push(`liq_amplify="${escAnnotate(song.gainDb)} dB"`);
  return `annotate:${fields.join(',')}:${playableUri}`;
}

// ---------------------------------------------------------------------------
// Resolved connection config for the non-Subsonic providers
// ---------------------------------------------------------------------------
// Env (config.music, read once at import) wins over the live settings.source
// block, which wins over the defaults — the "env always wins, wizard fills gaps"
// rule. Read at call time so an admin settings change takes effect without a
// restart (the source objects are stateless adapters). Navidrome creds are NOT
// here — they resolve via config.navidrome.
export function sourceConfig() {
  const s: any = settings.get()?.source || {};
  return {
    provider: config.music.source || s.provider || 'navidrome',
    jellyfin: {
      url: config.music.jellyfin.url || s.jellyfin?.url || '',
      apiKey: config.music.jellyfin.apiKey || s.jellyfin?.apiKey || '',
      userId: config.music.jellyfin.userId || s.jellyfin?.userId || '',
    },
    jamendo: {
      clientId: config.music.jamendo.clientId || s.jamendo?.clientId || '',
      apiBase: config.music.jamendo.apiBase,
    },
    local: {
      dir: config.music.local.dir || s.local?.dir || '',
    },
  };
}
