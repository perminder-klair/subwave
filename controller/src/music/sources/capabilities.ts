// Per-source capability descriptors — the single place declaring which optional
// methods each music source can actually serve. The facade (music/source.ts)
// reads these to return neutral empties for methods a source lacks, and the
// picker tools read them (PickerContext.sourceCaps) to gate off LLM tools that
// can't work, so no call site ever branches on the source id.
//
// Pure: no settings or SDK imports (mirrors llm/internal/provider/capabilities.ts
// and upstream PR #843's table), so the mappings stay trivially inspectable.

export interface SourceCapabilities {
  hasSimilar: boolean;         // getSimilarSongs (Last.fm graph via the server)
  hasSonicSimilarity: boolean; // OpenSubsonic sonicSimilarity extension (class-level; runtime probe still applies)
  hasStarred: boolean;         // server-side stars (read)
  hasStar: boolean;            // server-side stars (write) — likes mirroring
  hasScrobble: boolean;        // play reporting back to the source
  hasTopSongs: boolean;        // popularity-ranked songs for an artist
  hasArtistInfo: boolean;      // bio / images / similar artists
  hasLastfmTags: boolean;      // crowd tags for an artist
  hasLyrics: boolean;
  hasPlaylists: boolean;       // getPlaylists + getPlaylist
  hasPlaylistWrite: boolean;   // create/add/remove/update/delete playlists
  hasRecentlyAdded: boolean;   // "newest" albums
  // The source can answer "newest TRACKS" directly. Without it a caller has to
  // ask for the newest ALBUMS and then fetch each album's tracks, which on a
  // per-request-metered source is one request per album for one admin panel.
  hasRecentSongs: boolean;     // getRecentSongs
  hasFrequent: boolean;        // play-count-ranked albums
  // Fetchable audio bytes (URL or shared-mount path) for the analyzer, the
  // loudness measurement, silence trim and stem rendering. False means every
  // analyzer-derived column stays NULL and those features degrade to "as if
  // never analysed" — the documented null semantics, not an error.
  hasAudio: boolean;
  // The source plays through a live mixer input (a player process feeding
  // Liquidsoap) rather than a per-track request URI. The queue hands tracks
  // to a PlaybackTransport instead of writing next.txt.
  hasLiveTransport: boolean;
}

const CAPS: Record<string, SourceCapabilities> = {
  subsonic: {
    hasSimilar: true,
    hasSonicSimilarity: true,
    hasStarred: true,
    hasStar: true,
    hasScrobble: true,
    hasTopSongs: true,
    hasArtistInfo: true,
    hasLastfmTags: true,
    hasLyrics: true,
    hasPlaylists: true,
    hasPlaylistWrite: true,
    hasRecentlyAdded: true,
    hasRecentSongs: false,
    hasFrequent: true,
    hasAudio: true,
    hasLiveTransport: false,
  },
  // Spotify (Web API catalog + librespot playback). ON: saved tracks as stars,
  // artist top-tracks, the account's playlists, saved albums as recently-added.
  // OFF: the Last.fm similar-songs graph and the OpenSubsonic sonic extension
  // (Spotify's recommendations endpoints are deprecated for new apps), bios,
  // crowd tags, lyrics, play-count albums, writes back to the account, and —
  // structurally — audio bytes (a DRM stream, nothing to analyse). Playback is
  // a LIVE transport: the queue hands picks to the Spotify controller instead
  // of writing next.txt.
  //
  // hasRecentSongs is ON because the pool already stamps each track's `added_at`
  // as `created` (sources/spotify/map.ts), so "newest tracks" is a sort over
  // memory. Answering it from albums instead cost one request per album.
  //
  // hasTopSongs went off in the February 2026 API restrictions: Spotify removed
  // GET /artists/{id}/top-tracks with no replacement and dropped `popularity`
  // from track objects, so there is nothing left to rank an artist's songs by.
  spotify: {
    hasSimilar: false,
    hasSonicSimilarity: false,
    hasStarred: true,
    hasStar: false,
    hasScrobble: false,
    hasTopSongs: false,
    hasArtistInfo: false,
    hasLastfmTags: false,
    hasLyrics: false,
    hasPlaylists: true,
    hasPlaylistWrite: false,
    hasRecentlyAdded: true,
    hasRecentSongs: true,
    hasFrequent: false,
    hasAudio: false,
    hasLiveTransport: true,
  },
};

// Everything off — a source declares only what it can serve.
export const DEFAULT_CAPS: SourceCapabilities = {
  hasSimilar: false,
  hasSonicSimilarity: false,
  hasStarred: false,
  hasStar: false,
  hasScrobble: false,
  hasTopSongs: false,
  hasArtistInfo: false,
  hasLastfmTags: false,
  hasLyrics: false,
  hasPlaylists: false,
  hasPlaylistWrite: false,
  hasRecentlyAdded: false,
  hasRecentSongs: false,
  hasFrequent: false,
  hasAudio: false,
  hasLiveTransport: false,
};

export function capabilitiesFor(sourceId: string | undefined): SourceCapabilities {
  return (sourceId && CAPS[sourceId]) || DEFAULT_CAPS;
}
