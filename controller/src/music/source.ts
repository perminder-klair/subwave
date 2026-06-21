// Music source abstraction.
//
// SUB/WAVE's model is: the server holds decodable audio, the controller writes a
// track URI to next.txt, Liquidsoap plays/crossfades/ducks it. Historically the
// only source was a Subsonic server (Navidrome), imported directly at ~80 call
// sites. This module is the seam that lets other catalogues — Jellyfin, Jamendo,
// a local folder — back the same picker/request/queue pipeline without those
// call sites naming a provider.
//
// Design (see docs/music-sources.md):
//   - ONE interface, capability-gated. Every provider implements the full method
//     surface; a provider that lacks a capability returns an empty/no-op result
//     and advertises it via `capabilities` so the picker/agent can skip the call
//     rather than waste a round-trip. Methods are therefore NON-optional — call
//     sites stay clean (no `?.`), and the flags carry the "should I bother" signal.
//   - SINGLE active source for now: `getSource()` resolves the one provider named
//     in settings. Ids are namespaced at the boundary (nd:/jf:/jam:/local:) so a
//     future multi-source picker can route per-id without re-plumbing.

import * as settings from '../settings.js';
import { navidromeSource } from './sources/navidrome.js';

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

export function namespaceId(provider: string, id: string): string {
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
// Active-source accessor
// ---------------------------------------------------------------------------
// Resolves the one provider named in settings.source.provider (default
// 'navidrome'), caches it, and re-resolves when the setting changes. Providers
// are registered here; later phases add jamendo/jellyfin/local.

type SourceBuilder = () => MusicSource;

const REGISTRY: Record<string, SourceBuilder> = {
  navidrome: () => navidromeSource,
  subsonic: () => navidromeSource, // alias — same Subsonic client, any compatible server
};

let cached: { key: string; source: MusicSource } | null = null;

export function getSource(): MusicSource {
  const key = settings.get()?.source?.provider || 'navidrome';
  if (cached && cached.key === key) return cached.source;
  const build = REGISTRY[key] || REGISTRY.navidrome;
  const source = build();
  cached = { key, source };
  return source;
}

// Look up a specific provider by key (for prefix-routed /cover/:id). Falls back
// to the active source when the key is unknown/unconfigured — single-source means
// foreign-prefixed ids shouldn't occur, but be forgiving rather than 500.
export function getSourceByKey(key: string | null | undefined): MusicSource {
  if (key && REGISTRY[key]) return REGISTRY[key]();
  return getSource();
}

// Register an additional provider builder (later phases). Idempotent.
export function registerSource(key: string, build: SourceBuilder): void {
  REGISTRY[key] = build;
}

// Drop the cache so the next getSource() re-reads settings — called after a
// settings.update() that may have changed the active provider.
export function invalidateSource(): void {
  cached = null;
}
