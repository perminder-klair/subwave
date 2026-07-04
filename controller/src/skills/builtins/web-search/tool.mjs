// Web search — something recent about the on-air artist (release, tour, press),
// or whatever the segment director asks for via the optional `query` input.
// `ready` gates the whole skill on a configured search provider, so it's never
// even offered when search is unavailable.
export const description = 'Search the web. Pass a query to dig into something specific (the track, an event, a topic worth a line), or pass null to default to recent news about the artist currently on air.';

export const inputs = {
  query: 'what to search for — a specific question or topic; null to default to recent news about the on-air artist',
};

export const ready = (services) => services.searchReady();

export default async function searchArtistNews(ctx, state, services, config, input) {
  const custom = String(input?.query || '').trim();
  const artist = services.nowPlaying()?.artist;
  if (!custom && (!artist || /^unknown/i.test(artist))) return { available: false };
  const query = custom || `${artist} musician latest news`;
  const alreadySearched = !custom && artist === state.lastSearchedArtist;
  const data = await services.searchWeb(query, { recency: 'week' });
  if (!custom) state.lastSearchedArtist = artist;
  const answer = (data.answer || '').trim();
  const sources = (data.results || [])
    .slice(0, 3)
    .map(r => `${r.title}: ${(r.content || '').replace(/\s+/g, ' ').trim().slice(0, 240)}`);
  if (!answer && sources.length === 0) return { available: false };
  return { query, artist, alreadySearched, answer, sources };
}
