// Now-playing dig — a concrete, verifiable detail about the EXACT track on air
// (producer, sample, B-side, chart, backstory), grounded in a real web search.
// `ready` gates on a search provider; returns available:false when nothing
// solid comes back so the DJ never invents trivia.
export const description = 'Search the web for a specific, verifiable detail about the exact track currently on air (producer, sample, B-side, chart, backstory).';

export const ready = (services) => services.searchReady();

export default async function digCurrentTrack(ctx, state, services) {
  const cur = services.nowPlaying();
  const artist = cur?.artist;
  const title = cur?.title;
  if (!artist || !title || /^unknown/i.test(artist) || /^unknown/i.test(title)) return { available: false };
  const trackKey = `${artist} — ${title}`;
  const alreadyDug = trackKey === state.lastDugTrack;
  const data = await services.searchWeb(`${artist} "${title}" song producer sample b-side chart story`);
  state.lastDugTrack = trackKey;
  const answer = (data.answer || '').trim();
  const sources = (data.results || [])
    .slice(0, 3)
    .map(r => `${r.title}: ${(r.content || '').replace(/\s+/g, ' ').trim().slice(0, 240)}`);
  if (!answer && sources.length === 0) return { available: false };
  return { artist, title, alreadyDug, answer, sources };
}
