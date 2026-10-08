// Which optional source op each Subsonic endpoint leans on, and what its
// handler does when the serving source lacks it. The admin Music router page's
// service matrix reads this from /internal/status and crosses it with each
// source's capabilities.
//
// A fact about handlers.ts, so it lives beside it: scripts/coverage.test.ts
// pins one row per handler, and drives every `whenMissing` against a source
// that lacks the op. Adding an optional-op branch to a handler means adding
// its `needs` here.
//
//   degraded    — the handler still answers ok, with less (an empty list, no
//                 bio, a play that is not counted)
//   unsupported — the handler answers a Subsonic error, which the controller
//                 already treats as "this server cannot"

import type { Capabilities } from '../host/types.js';

export interface EndpointCoverage {
  endpoint: string;
  group: 'System' | 'Browsing' | 'Discovery' | 'Stars' | 'Playlists' | 'Media';
  needs: keyof Capabilities | null;
  whenMissing: 'degraded' | 'unsupported' | null;
  /** What the station loses when the op is missing; only set where something can be lost. */
  feature?: string;
}

const always = (endpoint: string, group: EndpointCoverage['group']): EndpointCoverage => ({
  endpoint,
  group,
  needs: null,
  whenMissing: null,
});

export const ENDPOINT_COVERAGE: EndpointCoverage[] = [
  always('ping', 'System'),
  always('getLicense', 'System'),
  always('getOpenSubsonicExtensions', 'System'),
  always('getMusicFolders', 'System'),
  { endpoint: 'getScanStatus', group: 'System', needs: 'scanStatus', whenMissing: 'unsupported', feature: 'library scan progress' },

  always('getSong', 'Browsing'),
  always('getAlbum', 'Browsing'),
  always('getArtist', 'Browsing'),
  { endpoint: 'getArtists', group: 'Browsing', needs: 'artists', whenMissing: 'unsupported', feature: 'the artist index' },
  { endpoint: 'getArtistInfo2', group: 'Browsing', needs: 'artistInfo', whenMissing: 'degraded', feature: 'artist bios and similar artists' },
  always('getGenres', 'Browsing'),
  always('getAlbumList2', 'Browsing'),
  always('getSongsByGenre', 'Browsing'),
  always('getRandomSongs', 'Browsing'),
  always('search3', 'Browsing'),

  { endpoint: 'getSimilarSongs2', group: 'Discovery', needs: 'similarSongs', whenMissing: 'degraded', feature: 'similar-track discovery' },
  { endpoint: 'getTopSongs', group: 'Discovery', needs: 'topSongs', whenMissing: 'degraded', feature: "an artist's top tracks" },
  { endpoint: 'getSonicSimilarTracks', group: 'Discovery', needs: 'sonicSimilarity', whenMissing: 'unsupported', feature: 'sonic-similarity picks' },

  { endpoint: 'getStarred2', group: 'Stars', needs: 'stars', whenMissing: 'degraded', feature: 'hearts read from the server' },
  { endpoint: 'star', group: 'Stars', needs: 'stars', whenMissing: 'unsupported', feature: 'hearts written to the server' },
  { endpoint: 'unstar', group: 'Stars', needs: 'stars', whenMissing: 'unsupported', feature: 'hearts written to the server' },

  { endpoint: 'getPlaylists', group: 'Playlists', needs: 'playlists', whenMissing: 'degraded', feature: 'server playlists' },
  { endpoint: 'getPlaylist', group: 'Playlists', needs: 'playlists', whenMissing: 'unsupported', feature: 'server playlists' },
  { endpoint: 'createPlaylist', group: 'Playlists', needs: 'playlists', whenMissing: 'unsupported', feature: 'saving playlists to the server' },
  { endpoint: 'updatePlaylist', group: 'Playlists', needs: 'playlists', whenMissing: 'unsupported', feature: 'saving playlists to the server' },
  { endpoint: 'deletePlaylist', group: 'Playlists', needs: 'playlists', whenMissing: 'unsupported', feature: 'saving playlists to the server' },

  always('stream', 'Media'),
  always('getCoverArt', 'Media'),
  { endpoint: 'getLyricsBySongId', group: 'Media', needs: 'lyrics', whenMissing: 'degraded', feature: 'lyrics' },
  { endpoint: 'scrobble', group: 'Media', needs: 'scrobble', whenMissing: 'degraded', feature: 'play counts on the server' },
];
