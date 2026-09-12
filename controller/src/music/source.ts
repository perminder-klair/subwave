// The music-source facade. Every name call sites used to import from
// music/subsonic.js lives here, delegating to whichever source the registry
// resolves from settings.music.source. Call sites import ONLY this module — no
// `source ===` branches anywhere else. (Call sites keep their historical
// `subsonic` namespace alias on purpose: a one-line import flip per file is the
// smallest possible diff against upstream, and the alias now means "the active
// music source".)
//
// Every delegator is typed `typeof client.<fn>` — see sources/types.ts for why —
// so a caller sees exactly the signature it always had.
//
// Three layers:
//   1. CORE delegators — pass straight through to the active source.
//   2. OPTIONAL delegators — capability-gated; a source that can't serve one
//      returns a neutral empty ([]/null/''/false/no-op) so discovery paths (the
//      pool picker, request matching, likes, scrobble) degrade with zero
//      call-site changes.
//   3. PLAYBACK delegators — request-URI builders. Only a file/URL source has
//      them; a live-transport source never reaches these (the queue hands the
//      item to a PlaybackTransport instead), so a missing method THROWS rather
//      than returning a URI that would play nothing.
//
// Nothing under sources/ imports this file at runtime — the dependency edge is
// one-way (facade → registry → source impls), so there is no cycle.

import type * as client from './subsonic.js';
import { activeSource, activeSourceId } from './sources/registry.js';
import { capabilitiesFor } from './sources/capabilities.js';
import type { Song, CoverArt, AnalyzableRef, CatalogHealth } from './sources/types.js';

// Pure helpers that never touch a server — shared by every source and by the
// Liquidsoap annotation builders. Re-exported from the client verbatim.
export { songGenres, escAnnotate, isStationArchive } from './subsonic.js';
export { activeSourceId } from './sources/registry.js';
export type { Song, Artist, Album, Genre, Playlist, CoverArt, AnalyzableRef, CatalogHealth, MusicSource } from './sources/types.js';
export const activeCapabilities = () => capabilitiesFor(activeSourceId());

// ── CORE delegators ────────────────────────────────────────────────────────

export const ping: typeof client.ping = () => activeSource().ping();
export const search: typeof client.search = (...a) => activeSource().search(...a);
export const getSong: typeof client.getSong = (...a) => activeSource().getSong(...a);
export const getAlbum: typeof client.getAlbum = (...a) => activeSource().getAlbum(...a);
export const getArtist: typeof client.getArtist = (...a) => activeSource().getArtist(...a);
export const searchArtists: typeof client.searchArtists = (...a) => activeSource().searchArtists(...a);
export const getGenres: typeof client.getGenres = () => activeSource().getGenres();
export const getRandomSongs: typeof client.getRandomSongs = (...a) => activeSource().getRandomSongs(...a);
export const getSongsByGenre: typeof client.getSongsByGenre = (...a) => activeSource().getSongsByGenre(...a);
export const getSongsByGenreSampled: typeof client.getSongsByGenreSampled = (...a) => activeSource().getSongsByGenreSampled(...a);
export const getAlbumList: typeof client.getAlbumList = (...a) => activeSource().getAlbumList(...a);
export const iterateAllSongs: typeof client.iterateAllSongs = () => activeSource().iterateAllSongs();
export function getCoverArt(id: string, size?: number): Promise<CoverArt | null> {
  return activeSource().getCoverArt(id, size);
}
export function getAnalyzableRef(songId: string): Promise<AnalyzableRef | null> {
  return activeSource().getAnalyzableRef(songId);
}
export const resolveGenreName: typeof client.resolveGenreName = (...a) => activeSource().resolveGenreName(...a);
export const resolveArtist: typeof client.resolveArtist = (...a) => activeSource().resolveArtist(...a);
export const getRecentSongsByArtist: typeof client.getRecentSongsByArtist = (...a) => activeSource().getRecentSongsByArtist(...a);

// Whether the last full walk was authoritative enough to delete against — asked
// ONLY by music/prune-policy.ts. A source that does not implement it answers
// `complete: true`, which keeps Subsonic's reconcile byte-identical; see the
// note on MusicSource.catalogHealth for why silence means "safe" here while the
// gate it feeds fails closed. A source whose probe THROWS is treated as
// degraded: the question is "may I delete", and an unanswerable question is not
// a yes.
export async function catalogHealth(): Promise<CatalogHealth> {
  const src = activeSource();
  if (!src.catalogHealth) return { complete: true };
  try {
    return await src.catalogHealth();
  } catch (err: any) {
    return { complete: false, reason: `${src.id} could not report catalogue health: ${err?.message ?? err}` };
  }
}

// ── PLAYBACK delegators — request-URI sources only ──────────────────────────

function requirePlayback<K extends 'getPlayableUri' | 'getAnnotatedUri' | 'getClipUri'>(name: K) {
  const src = activeSource();
  const fn = src[name];
  if (!fn) throw new Error(`music source "${src.id}" has no ${name} — it plays through a live transport, not a request URI`);
  return fn as NonNullable<typeof fn>;
}
export const getPlayableUri: typeof client.getPlayableUri = (...a) => requirePlayback('getPlayableUri')(...a);
export const getAnnotatedUri: typeof client.getAnnotatedUri = (...a) => requirePlayback('getAnnotatedUri')(...a);
export const getClipUri: typeof client.getClipUri = (...a) => requirePlayback('getClipUri')(...a);
// A source without local files simply has none — that is an answer, not a
// failure (the queue asks this to decide whether a resolve probe applies).
export const getLocalPath: typeof client.getLocalPath = (song) => activeSource().getLocalPath?.(song) ?? null;

// ── OPTIONAL delegators — capability-gated neutral empties ───────────────────
// The capability flag is the single source of truth; the `?.` on the method is
// belt-and-braces so a table/impl mismatch degrades instead of crashing.

export const getSimilarSongs: typeof client.getSimilarSongs = async (...a) => {
  const src = activeSource();
  if (!capabilitiesFor(src.id).hasSimilar) return [];
  return (await src.getSimilarSongs?.(...a)) ?? [];
};
export const supportsSonicSimilarity: typeof client.supportsSonicSimilarity = async () => {
  const src = activeSource();
  if (!capabilitiesFor(src.id).hasSonicSimilarity) return false;
  return (await src.supportsSonicSimilarity?.()) ?? false;
};
export const getSonicSimilarTracks: typeof client.getSonicSimilarTracks = async (...a) => {
  const src = activeSource();
  if (!capabilitiesFor(src.id).hasSonicSimilarity) return [];
  return (await src.getSonicSimilarTracks?.(...a)) ?? [];
};
export const getStarred: typeof client.getStarred = async () => {
  const src = activeSource();
  if (!capabilitiesFor(src.id).hasStarred) return [];
  return (await src.getStarred?.()) ?? [];
};
export const star: typeof client.star = async (...a) => {
  const src = activeSource();
  if (!capabilitiesFor(src.id).hasStar) return undefined as any;
  return src.star?.(...a);
};
export const unstar: typeof client.unstar = async (...a) => {
  const src = activeSource();
  if (!capabilitiesFor(src.id).hasStar) return undefined as any;
  return src.unstar?.(...a);
};
export const scrobble: typeof client.scrobble = async (...a) => {
  const src = activeSource();
  if (!capabilitiesFor(src.id).hasScrobble) return undefined as any;
  return src.scrobble?.(...a);
};
export const getTopSongs: typeof client.getTopSongs = async (...a) => {
  const src = activeSource();
  if (!capabilitiesFor(src.id).hasTopSongs) return [];
  return (await src.getTopSongs?.(...a)) ?? [];
};
export const getArtistInfo: typeof client.getArtistInfo = async (...a) => {
  const src = activeSource();
  if (!capabilitiesFor(src.id).hasArtistInfo) return null;
  return (await src.getArtistInfo?.(...a)) ?? null;
};
export const getArtistLastfmTags: typeof client.getArtistLastfmTags = async (...a) => {
  const src = activeSource();
  if (!capabilitiesFor(src.id).hasLastfmTags) return [];
  return (await src.getArtistLastfmTags?.(...a)) ?? [];
};
export const getLyrics: typeof client.getLyrics = async (...a) => {
  const src = activeSource();
  if (!capabilitiesFor(src.id).hasLyrics) return '';
  return (await src.getLyrics?.(...a)) ?? '';
};
export const getStructuredLyrics: typeof client.getStructuredLyrics = async (...a) => {
  const src = activeSource();
  if (!capabilitiesFor(src.id).hasLyrics) return null;
  return (await src.getStructuredLyrics?.(...a)) ?? null;
};
export const getPlaylists: typeof client.getPlaylists = async () => {
  const src = activeSource();
  if (!capabilitiesFor(src.id).hasPlaylists) return [];
  return (await src.getPlaylists?.()) ?? [];
};
export const getPlaylist: typeof client.getPlaylist = async (...a) => {
  const src = activeSource();
  if (!capabilitiesFor(src.id).hasPlaylists) return [];
  return (await src.getPlaylist?.(...a)) ?? [];
};
function requirePlaylistWrite<K extends 'createPlaylist' | 'addToPlaylist' | 'removeFromPlaylist' | 'updatePlaylistMeta' | 'deletePlaylist'>(name: K) {
  const src = activeSource();
  const fn = capabilitiesFor(src.id).hasPlaylistWrite ? src[name] : undefined;
  // Writes are operator actions with a visible result, so a source that cannot
  // do them answers with an error the route can show — not a silent no-op.
  if (!fn) throw new Error(`music source "${src.id}" does not support editing playlists`);
  return fn as NonNullable<typeof fn>;
}
export const createPlaylist: typeof client.createPlaylist = (...a) => requirePlaylistWrite('createPlaylist')(...a);
export const addToPlaylist: typeof client.addToPlaylist = (...a) => requirePlaylistWrite('addToPlaylist')(...a);
export const removeFromPlaylist: typeof client.removeFromPlaylist = (...a) => requirePlaylistWrite('removeFromPlaylist')(...a);
export const updatePlaylistMeta: typeof client.updatePlaylistMeta = (...a) => requirePlaylistWrite('updatePlaylistMeta')(...a);
export const deletePlaylist: typeof client.deletePlaylist = (...a) => requirePlaylistWrite('deletePlaylist')(...a);
export const getRecentlyAddedAlbums: typeof client.getRecentlyAddedAlbums = async (...a) => {
  const src = activeSource();
  if (!capabilitiesFor(src.id).hasRecentlyAdded) return [];
  return (await src.getRecentlyAddedAlbums?.(...a)) ?? [];
};
export const getFrequentAlbums: typeof client.getFrequentAlbums = async (...a) => {
  const src = activeSource();
  if (!capabilitiesFor(src.id).hasFrequent) return [];
  return (await src.getFrequentAlbums?.(...a)) ?? [];
};
// The newest TRACKS, straight from the source. Neutral empty when the source
// cannot serve them, which the caller reads as "compose it yourself from newest
// albums" — the shape /dj/recent has always used and Subsonic still uses.
export async function getRecentSongs(opts?: { size?: number }): Promise<Song[]> {
  const src = activeSource();
  if (!capabilitiesFor(src.id).hasRecentSongs) return [];
  return (await src.getRecentSongs?.(opts)) ?? [];
}
