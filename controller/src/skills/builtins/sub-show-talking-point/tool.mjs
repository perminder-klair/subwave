export const description = 'Read the current show’s explicit talking point and the exact track on air. Return no data unless track genre metadata supplies a direct connection. Never select another track or research examples.';
export const requiresData = true;

const words = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/synthesi[sz](?:er|ers|ed|ing)?/g, 'synth').replace(/synthesis/g, 'synth')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const generic = new Set(['music', 'musical', 'rock', 'pop', 'alternative', 'contemporary', 'modern', 'traditional', 'experimental']);
const genresOf = track => [...new Set([
  ...(Array.isArray(track?.genres) ? track.genres.map(g => typeof g === 'string' ? g : g?.name) : []),
  track?.genre,
].filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
const silent = reason => ({ available: false, reason });

export default async function talkingPoint(ctx, state, services) {
  const show = ctx?.activeShow;
  const match = /^\s*Talking point \(optional thread\):\s*([^\r\n]+)\s*$/im.exec(String(show?.topic || ''));
  if (!match) return silent('No explicit talking point in the current show brief');
  const talkingPoint = match[1].trim();
  const current = services.nowPlaying();
  if (!current?.id || !current.artist || !current.title || /^unknown\b/i.test(current.artist) || /^unknown\b/i.test(current.title)) {
    return silent('No identified track currently on air');
  }
  // Prefer track tags. An album lookup is only for the EXACT track ID, never
  // album-level genres (which need not describe every recording on an album).
  let genres = genresOf(current);
  if (!genres.length && current.albumId && services.library?.getAlbum) {
    try {
      const album = await services.library.getAlbum(current.albumId);
      const songs = Array.isArray(album) ? album : [];
      const exact = songs.find(song => song.id === current.id);
      if (exact) genres = genresOf(exact);
    } catch { return silent('Current-track metadata unavailable'); }
  }
  if (!genres.length) return silent('No genre evidence for the current track');
  const topic = ` ${words(talkingPoint)} `;
  // This is evidence of relevance, not proof of instrumentation or artist
  // history. Generic words and artist/title coincidences are never evidence.
  const matchingGenres = genres.filter(genre => {
    const tag = words(genre);
    const anchors = tag.split(' ').filter(word => word.length >= 4 && !generic.has(word));
    return (!generic.has(tag) && topic.includes(` ${tag} `))
      || (anchors.length > 0 && topic.includes(` ${anchors.join(' ')} `));
  });
  if (!matchingGenres.length) return silent('Current track genres do not explicitly connect to the talking point');
  if (services.nowPlaying()?.id !== current.id) return silent('The track changed while gathering context');
  return {
    available: true,
    show: { id: show.id, name: show.name },
    talkingPoint,
    currentTrack: { id: current.id, artist: current.artist, title: current.title, genres },
    relevance: { matchingGenres, basis: 'An explicit talking-point term matches current-track genre metadata. This does not verify audible details, lyrics, credits or history.' },
    boundaries: 'Only currentTrack identifies a real recording. No other songs, artists, albums, prior plays or upcoming tracks are supplied. If the question requires unsupported claims about this recording, stand down.',
  };
}
