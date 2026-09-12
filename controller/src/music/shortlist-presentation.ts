// Listener-facing factual presentation for a Track Shortlist selection.
//
// Source names are controller facts, but their registry identifiers are not a
// useful listener explanation. Keep this mapping here, beside the shortlist,
// rather than asking the DJ model to reconstruct provenance from a candidate.

const SOURCE_LABELS: Record<string, string> = {
  searchLibrary: 'library search',
  similarSongs: 'related-artist exploration',
  topSongsByArtist: 'artist favourites',
  recentByArtist: 'recent artist picks',
  songsByGenre: 'genre matching',
  tracksByMood: 'mood and energy matching',
  tracksByEnergy: 'energy matching',
  tracksLikeThis: 'similar-track exploration',
  tracksThatSoundLikeThis: 'sound-alike exploration',
  searchByLyrics: 'lyric search',
  searchBySound: 'sound search',
  deepCuts: 'deep-cut discovery',
  recentlyAdded: 'recent additions',
  starredSongs: 'station favourites',
  randomSongs: 'a library wildcard',
  showPlaylistTracks: 'the show’s music selection',
  tracksTowardJourney: 'the station’s sonic journey',
};

export function shortlistSourceHint(sources: unknown): string | null {
  if (!Array.isArray(sources)) return null;
  const labels = [...new Set(sources
    .filter((source): source is string => typeof source === 'string')
    .map((source) => SOURCE_LABELS[source])
    .filter((label): label is string => !!label))];
  if (!labels.length) return null;
  if (labels.length === 1) return `Surfaced through ${labels[0]}.`;
  if (labels.length === 2) return `Surfaced through ${labels[0]} and ${labels[1]}.`;
  return `Surfaced through ${labels[0]}, ${labels[1]}, and other routes.`;
}
