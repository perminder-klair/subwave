// Album anniversary — is the album on air hitting a round-number (5/10/20/25y…)
// anniversary this year? Computed from the track's real ID3 year, so the year
// is never guessed.
export const description = 'Check whether the album currently on air is hitting a round-number anniversary (5/10/20/25y) this year. Returns the album, the artist, and the year count when one applies; `available: false` otherwise.';

export default async function checkAlbumAnniversary(ctx, state, services) {
  const track = services.nowPlaying();
  const albumName = track?.album;
  const albumYear = Number(track?.year);
  const artistName = track?.artist;
  if (!albumName || !artistName) return { available: false };
  if (!Number.isFinite(albumYear) || albumYear < 1900) return { available: false };
  const years = new Date().getFullYear() - albumYear;
  if (years < 5) return { available: false };
  if (years % 5 !== 0) return { available: false };
  return { available: true, album: albumName, artist: artistName, years, releasedYear: albumYear };
}
