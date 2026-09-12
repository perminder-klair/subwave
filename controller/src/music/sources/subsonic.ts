// The Subsonic/Navidrome MusicSource — a THIN adapter over the unchanged
// `music/subsonic.ts` client. The client keeps its file and its name so upstream
// changes to it merge cleanly; only this object knows the interface.
//
// Every method is the client's function by reference (no wrapping, no
// re-typing), which is what makes the default source byte-identical to the
// pre-seam behaviour: same call, same arguments, same result.

import * as client from '../subsonic.js';
import type { MusicSource, CoverArt, AnalyzableRef } from './types.js';

async function getCoverArt(id: string, size = 512): Promise<CoverArt | null> {
  return { url: client.getCoverArtUrl(id, size) };
}

// The analyzer fetches the raw stream itself (URL path); a local library path
// is deliberately NOT offered here — `getLocalPath` is a Liquidsoap-side
// convenience keyed on MUSIC_LIBRARY_PATH being visible to the mixer, and the
// analyzer's own shared-volume prefetch (downloadCapped) already covers the
// controller ↔ analyzer hop.
async function getAnalyzableRef(songId: string): Promise<AnalyzableRef | null> {
  return { url: client.getRawStreamUrl(songId) };
}

export const subsonicSource: MusicSource = {
  id: 'subsonic',
  // core
  ping: client.ping,
  search: client.search,
  getSong: client.getSong,
  getAlbum: client.getAlbum,
  getArtist: client.getArtist,
  searchArtists: client.searchArtists,
  getGenres: client.getGenres,
  getRandomSongs: client.getRandomSongs,
  getSongsByGenre: client.getSongsByGenre,
  getSongsByGenreSampled: client.getSongsByGenreSampled,
  getAlbumList: client.getAlbumList,
  iterateAllSongs: client.iterateAllSongs,
  getCoverArt,
  getAnalyzableRef,
  resolveGenreName: client.resolveGenreName,
  resolveArtist: client.resolveArtist,
  getRecentSongsByArtist: client.getRecentSongsByArtist,
  // playback (request-URI source)
  getPlayableUri: client.getPlayableUri,
  getLocalPath: client.getLocalPath,
  getAnnotatedUri: client.getAnnotatedUri,
  getClipUri: client.getClipUri,
  // discovery / feedback (capabilities table: all on for subsonic)
  getSimilarSongs: client.getSimilarSongs,
  supportsSonicSimilarity: client.supportsSonicSimilarity,
  getSonicSimilarTracks: client.getSonicSimilarTracks,
  getStarred: client.getStarred,
  star: client.star,
  unstar: client.unstar,
  scrobble: client.scrobble,
  getTopSongs: client.getTopSongs,
  getArtistInfo: client.getArtistInfo,
  getArtistLastfmTags: client.getArtistLastfmTags,
  getLyrics: client.getLyrics,
  getStructuredLyrics: client.getStructuredLyrics,
  getPlaylists: client.getPlaylists,
  getPlaylist: client.getPlaylist,
  createPlaylist: client.createPlaylist,
  addToPlaylist: client.addToPlaylist,
  removeFromPlaylist: client.removeFromPlaylist,
  updatePlaylistMeta: client.updatePlaylistMeta,
  deletePlaylist: client.deletePlaylist,
  getRecentlyAddedAlbums: client.getRecentlyAddedAlbums,
  getFrequentAlbums: client.getFrequentAlbums,
};
