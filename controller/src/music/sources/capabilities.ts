// Per-source capability descriptors — the single place declaring which optional
// discovery methods each music source can actually serve. The facade
// (music/source.ts) reads these to return neutral empties for methods a source
// lacks, and picker-tools.ts reads them to omit LLM tools that can't work, so no
// call site ever branches on the source id.
//
// Pure: no settings or SDK imports (mirrors llm/internal/provider/capabilities.ts),
// so the mappings stay trivially inspectable.

export interface SourceCapabilities {
  hasSimilar: boolean;         // getSimilarSongs (Last.fm graph via the server)
  hasSonicSimilarity: boolean; // OpenSubsonic sonicSimilarity extension (class-level; runtime probe still applies)
  hasStarred: boolean;         // server-side stars
  hasTopSongs: boolean;        // popularity-ranked songs for an artist
  hasArtistInfo: boolean;      // bio / images / similar artists
  hasLastfmTags: boolean;      // crowd tags for an artist
  hasLyrics: boolean;
  hasPlaylists: boolean;       // getPlaylists + getPlaylist
  hasRecentlyAdded: boolean;   // "newest" albums
  hasFrequent: boolean;        // play-count-ranked albums
}

const CAPS: Record<string, SourceCapabilities> = {
  subsonic: {
    hasSimilar: true,
    hasSonicSimilarity: true,
    hasStarred: true,
    hasTopSongs: true,
    hasArtistInfo: true,
    hasLastfmTags: true,
    hasLyrics: true,
    hasPlaylists: true,
    hasRecentlyAdded: true,
    hasFrequent: true,
  },
  // Local folder: everything derivable from file tags is on; anything needing a
  // server or an external graph (similar/sonic/starred/playlists/lyrics/
  // artist-info/last.fm tags) is off. getTopSongs is a shuffled-sample heuristic;
  // recently-added uses file mtime; frequent is a random album sample.
  local: {
    hasSimilar: false,
    hasSonicSimilarity: false,
    hasStarred: false,
    hasTopSongs: true,
    hasArtistInfo: false,
    hasLastfmTags: false,
    hasLyrics: false,
    hasPlaylists: false,
    hasRecentlyAdded: true,
    hasFrequent: true,
  },
  // Plex Media Server: richer than the local folder (a real server with
  // playlists + play-count/rating signals) but without the Last.fm graph a
  // Subsonic/Navidrome server layers on. ON: starred (userRating≥3★), top-songs
  // (viewCount-ranked), playlists, recently-added (addedAt), frequent
  // (viewCount). OFF: Last.fm similar-songs, the OpenSubsonic sonicSimilarity
  // extension, artist-info/bio, Last.fm crowd tags, lyrics — none exposed by the
  // PMS API in the shape the picker consumes.
  plex: {
    hasSimilar: false,
    hasSonicSimilarity: false,
    hasStarred: true,
    hasTopSongs: true,
    hasArtistInfo: false,
    hasLastfmTags: false,
    hasLyrics: false,
    hasPlaylists: true,
    hasRecentlyAdded: true,
    hasFrequent: true,
  },
};

// Everything off — a source declares only what it can serve.
const DEFAULT_CAPS: SourceCapabilities = {
  hasSimilar: false,
  hasSonicSimilarity: false,
  hasStarred: false,
  hasTopSongs: false,
  hasArtistInfo: false,
  hasLastfmTags: false,
  hasLyrics: false,
  hasPlaylists: false,
  hasRecentlyAdded: false,
  hasFrequent: false,
};

export function capabilitiesFor(sourceId: string | undefined): SourceCapabilities {
  return (sourceId && CAPS[sourceId]) || DEFAULT_CAPS;
}
