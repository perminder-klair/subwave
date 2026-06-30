// Web search — something recent about the on-air artist (release, tour, press).
// `ready` gates the whole skill on a configured search provider, so it's never
// even offered when search is unavailable.
export const description = 'Search the web for something recent about the artist currently on air.';

export const ready = (services) => services.searchReady();

export default async function searchArtistNews(ctx, state, services) {
  const artist = services.nowPlaying()?.artist;
  if (!artist || /^unknown/i.test(artist)) return { available: false };
  const alreadySearched = artist === state.lastSearchedArtist;
  const data = await services.searchWeb(`${artist} musician latest news`, { recency: 'week' });
  state.lastSearchedArtist = artist;
  const answer = (data.answer || '').trim();
  const sources = (data.results || [])
    .slice(0, 3)
    .map(r => `${r.title}: ${(r.content || '').replace(/\s+/g, ' ').trim().slice(0, 240)}`);
  if (!answer && sources.length === 0) return { available: false };
  return { artist, alreadySearched, answer, sources };
}
