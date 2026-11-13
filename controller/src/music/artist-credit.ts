// Which tracks are an artist's own, for a prepared artist episode (#2333).
//
// One rule, whichever path builds the catalogue (music/episode-source.ts): the
// albums path judges each song getAlbum returns, the library mirror judges each
// row it stored, and both ask creditsArtist. A track is the artist's when its
// track artist id, its first listed track artist or its first album artist is
// the artist: a group-credited record ("Bill Evans Trio", album artist = Bill
// Evans) counts, and so does a first credit on someone else's record. A second
// album artist (a shared duet record) does not, and a name never matches.
//
// The mirror stores the track artist id (`artist_id`) and the first album
// artist id (`album_artist_id`, firstAlbumArtistId at walk time). It has no
// separate first-artist id: Navidrome's Child.artistId is the first track
// artist wherever it lists `artists` (OpenSubsonic, 0.55+), and older servers
// list none, so on the mirror the track artist id answers both.

export interface ArtistCredit {
  artistId?: string | null;
  firstArtistId?: string | null;
  albumArtistId?: string | null;
}

type CreditList = Array<{ id?: string | null } | null | undefined> | null | undefined;

interface SongCredits {
  artistId?: string | null;
  artists?: CreditList;
  albumArtists?: CreditList;
}

export function creditsArtist(credit: ArtistCredit, artistId: string): boolean {
  if (!artistId) return false;
  return credit.artistId === artistId || credit.firstArtistId === artistId || credit.albumArtistId === artistId;
}

// The song's first album artist (OpenSubsonic `albumArtists`), else the album
// record's own artist id: what the walk stores as album_artist_id and what the
// albums path judges, so the two agree on a server that lists no albumArtists.
export function firstAlbumArtistId(song: SongCredits, album?: { artistId?: unknown } | null): string | null {
  const first = song.albumArtists?.[0]?.id;
  if (typeof first === 'string' && first) return first;
  const own = album?.artistId;
  return typeof own === 'string' && own ? own : null;
}

export function songCredit(song: SongCredits, album?: { artistId?: unknown } | null): ArtistCredit {
  const first = song.artists?.[0]?.id;
  return {
    artistId: song.artistId ?? null,
    firstArtistId: typeof first === 'string' && first ? first : null,
    albumArtistId: firstAlbumArtistId(song, album),
  };
}
