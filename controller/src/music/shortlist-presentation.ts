// Listener-facing labels for factual Track Shortlist provenance. The editorial
// reason remains model-written; source labels are controller facts.

const SOURCE_LABELS: Record<string, string> = {
  searchLibrary: 'library search',
  similarSongs: 'related-artist exploration',
  topSongsByArtist: 'artist favourites',
  recentByArtist: 'recent artist picks',
  songsByGenre: 'genre matching',
  songsByEra: 'era matching',
  tracksByMood: 'mood and energy matching',
  tracksByEnergy: 'energy matching',
  tracksLikeThis: 'similar-track exploration',
  tracksThatSoundLikeThis: 'sound-alike exploration',
  searchByLyrics: 'lyric search',
  searchBySound: 'sound search',
  deepCuts: 'deep-cut discovery',
  recentlyAdded: 'recent additions',
  starredSongs: 'station favourites',
  listenerFavourites: 'listener favourites',
  randomSongs: 'a library wildcard',
  showPlaylistTracks: 'the show’s music selection',
  tracksTowardJourney: 'the station’s sonic journey',
  sonicSimilarTracks: 'server sound-alike exploration',
  frequentAlbums: 'frequently played albums',
  moodPlaylistTracks: 'a mood-matched playlist',
  similarArtistTracks: 'related-artist tracks',
  moodWildcard: 'a contrasting mood',
  episodeArtistTracks: 'the episode’s featured artist',
};

// A candidate records only the source that FIRST surfaced it (see
// executeShortlistPlan), so the hint names one route, never a list.
export function shortlistSourceHint(sources: unknown): string | null {
  if (!Array.isArray(sources)) return null;
  const label = sources
    .filter((source): source is string => typeof source === 'string')
    .map((source) => SOURCE_LABELS[source])
    .find((candidate): candidate is string => !!candidate);
  return label ? `Surfaced through ${label}.` : null;
}
