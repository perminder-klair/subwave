// Library deep-cut — find a track by the on-air artist that's in the operator's
// library but hasn't played in the last 30 days. Walks a bounded slice of the
// artist's albums via the library service; returns a count + candidates.
export const description = 'Find a track by the on-air artist that lives in the operator\'s library but has NOT been played in the last 30 days. Returns at most a handful of candidates plus a count; `available: false` if the artist has nothing cold to surface. Do NOT name a specific track unless exactly one is returned.';

export default async function findDeepCut(ctx, state, services) {
  const artistName = services.nowPlaying()?.artist;
  if (!artistName || /^unknown/i.test(artistName)) return { available: false };
  // Resolve the artist id — take the best match.
  const matches = await services.library.searchArtists(artistName, { artistCount: 3 });
  const artist = matches.find(a => a.name?.toLowerCase() === artistName.toLowerCase()) || matches[0];
  if (!artist?.id) return { available: false };
  const detail = await services.library.getArtist(artist.id);
  const albums = Array.isArray(detail?.album) ? detail.album : [];
  if (!albums.length) return { available: false };
  const { ids, keys } = services.recentPlays(30 * 24); // 30 days
  const cold = [];
  for (const album of albums.slice(0, 8)) {
    const songs = await services.library.getAlbum(album.id);
    for (const s of songs) {
      const songId = String(s?.id || '');
      const key = `${(s?.title || '').toLowerCase().trim()}|${(s?.artist || artistName).toLowerCase().trim()}`;
      if (songId && ids.has(songId)) continue;
      if (keys.has(key)) continue;
      if (!s?.title) continue;
      cold.push({ title: s.title, album: album.name || '' });
      if (cold.length >= 6) break;
    }
    if (cold.length >= 6) break;
  }
  if (!cold.length) return { available: false };
  return { available: true, artist: artistName, count: cold.length, candidates: cold };
}
