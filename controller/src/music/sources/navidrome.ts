// Navidrome / Subsonic provider.
//
// A thin adapter exposing the existing music/subsonic.ts client as a MusicSource.
// subsonic.ts stays the implementation (proper salt+token auth, the subhttp:
// stream wrapper, the station-archive guard, the OpenSubsonic sonicSimilarity
// probe); this file just maps it onto the interface. `key: 'navidrome'` also
// serves the `subsonic` alias in the registry — the same client speaks the
// Subsonic API, so any compatible server (Airsonic, Gonic, Ampache, LMS) works
// with URL/cred changes. Capabilities are all true: Navidrome is the richest
// source and the one every other provider is measured against.

import type { MusicSource } from '../source-kit.js';
import * as subsonic from '../subsonic.js';

export const navidromeSource: MusicSource = {
  key: 'navidrome',
  capabilities: {
    pool: true,
    similar: true,
    genre: true,
    playlists: true,
    starred: true,
    recentlyAdded: true,
    frequent: true,
    artistGraph: true,
    sonicSimilarity: true, // probed per-server at call time via supportsSonicSimilarity()
    lyrics: true,
    libraryWalk: true,
  },

  // core
  search: subsonic.search,
  getRandomSongs: subsonic.getRandomSongs,
  getAnnotatedUri: subsonic.getAnnotatedUri,
  getCoverArtUrl: subsonic.getCoverArtUrl,
  isStationArchive: subsonic.isStationArchive,

  // discovery
  getSongsByGenre: subsonic.getSongsByGenre,
  getGenres: subsonic.getGenres,
  resolveGenreName: subsonic.resolveGenreName,
  resolveArtist: subsonic.resolveArtist,
  getSimilarSongs: subsonic.getSimilarSongs,
  supportsSonicSimilarity: subsonic.supportsSonicSimilarity,
  getSonicSimilarTracks: subsonic.getSonicSimilarTracks,
  getStarred: subsonic.getStarred,
  getAlbumList: subsonic.getAlbumList,
  getRecentlyAddedAlbums: subsonic.getRecentlyAddedAlbums,
  getFrequentAlbums: subsonic.getFrequentAlbums,
  getArtistInfo: subsonic.getArtistInfo,
  getTopSongs: subsonic.getTopSongs,
  getRecentSongsByArtist: subsonic.getRecentSongsByArtist,
  getAlbum: subsonic.getAlbum,
  getSong: subsonic.getSong,
  getArtist: subsonic.getArtist,
  searchArtists: subsonic.searchArtists,
  getArtistLastfmTags: subsonic.getArtistLastfmTags,
  getLyrics: subsonic.getLyrics,
  iterateAllSongs: subsonic.iterateAllSongs,
  getPlaylists: subsonic.getPlaylists,
  getPlaylist: subsonic.getPlaylist,
  getRawStreamUrl: subsonic.getRawStreamUrl,
};
