// Pure mappers: Spotify Web API objects → the loose Subsonic-shaped Song/Album/
// Artist objects every SUB/WAVE consumer already reads. No network, no config —
// unit-pinned by scripts/spotify-source.test.ts.
//
// Conventions that matter downstream:
//   • `id` is the Spotify track id (base62, 22 chars — passes /cover/:id's
//     `^[\w-]{1,64}$` guard). It rides the frozen `subsonic_id` wire name.
//   • `artist` is ONE display string (Subsonic parity); the full list rides in
//     `artists` for anything that wants it.
//   • `year` is the ALBUM release year — Spotify has no per-track original
//     date, so a compilation's year is untrusted exactly as it is on Navidrome
//     and flows through the same `albumIsCompilation`/`albumEraUntrusted` flags
//     the era pipeline reads (music/era-suspect.ts judges those at walk time).
//   • `coverArt` is the track id: /cover/:id resolves the album image through
//     the source, so the wire shape stays identical to Navidrome's.
//   • `genres` come from the ARTIST (Spotify tags artists, never tracks); the
//     walk fills them in when it has the artist cached, else they stay [].
//   • `popularity` is read where Spotify still sends it, but February 2026
//     removed the field from track/album/artist objects for Development Mode
//     apps, so in practice it is now always undefined. The guards stay — they
//     already fail soft, and an extended-quota app still gets the number.

import type { Song, Album, Artist } from '../types.js';

export interface SpotifyImage { url: string; width?: number | null; height?: number | null }

export function releaseYear(date: string | null | undefined): number | undefined {
  const m = /^(\d{4})/.exec(String(date ?? ''));
  const y = m ? Number(m[1]) : NaN;
  return Number.isFinite(y) && y > 0 ? y : undefined;
}

export function msToSec(ms: unknown): number | undefined {
  return typeof ms === 'number' && ms > 0 ? Math.round(ms / 1000) : undefined;
}

// Smallest image at least `size` wide, else the largest available.
export function pickImage(images: SpotifyImage[] | null | undefined, size = 512): string | undefined {
  const list = (images ?? []).filter((i) => i?.url);
  if (!list.length) return undefined;
  const sorted = [...list].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return (sorted.find((i) => (i.width ?? 0) >= size) ?? sorted[sorted.length - 1]).url;
}

export function joinArtists(artists: Array<{ name?: string }> | null | undefined): string {
  return (artists ?? []).map((a) => String(a?.name ?? '').trim()).filter(Boolean).join(', ');
}

export function isVariousArtists(name: string | null | undefined): boolean {
  return /^various(\s+artists)?$/i.test(String(name ?? '').trim());
}

export interface MapTrackExtras {
  // Album object when the track came from an album/tracks listing (which omits it).
  album?: any;
  // Artist genres, keyed by artist id, when the walk has them cached.
  artistGenres?: Map<string, string[]>;
  // Set by a playlist/saved listing.
  addedAt?: string | null;
}

export function mapTrack(t: any, extras: MapTrackExtras = {}): Song | null {
  if (!t || typeof t.id !== 'string' || !t.id) return null;
  const album = t.album ?? extras.album ?? {};
  const artists: Array<{ id?: string; name?: string }> = Array.isArray(t.artists) ? t.artists : [];
  const albumArtists: Array<{ id?: string; name?: string }> = Array.isArray(album.artists) ? album.artists : [];
  const albumArtist = joinArtists(albumArtists) || undefined;
  const genres = extras.artistGenres
    ? [...new Set(artists.flatMap((a) => (a.id && extras.artistGenres!.get(a.id)) || []))]
    : [];
  const albumType = typeof album.album_type === 'string' ? album.album_type : undefined;
  const isCompilation = albumType === 'compilation' || isVariousArtists(albumArtist);
  return {
    id: t.id,
    title: t.name ?? '',
    artist: joinArtists(artists),
    artists: artists.map((a) => a.name).filter(Boolean),
    artistId: artists[0]?.id,
    album: album.name ?? '',
    albumId: album.id,
    albumArtist,
    year: releaseYear(album.release_date),
    duration: msToSec(t.duration_ms),
    genres,
    genre: genres[0],
    coverArt: t.id,
    explicit: Boolean(t.explicit),
    popularity: typeof t.popularity === 'number' ? t.popularity : undefined,
    trackNumber: typeof t.track_number === 'number' ? t.track_number : undefined,
    discNumber: typeof t.disc_number === 'number' ? t.disc_number : undefined,
    isPlayable: t.is_playable !== false && !t.restrictions,
    spotifyUri: typeof t.uri === 'string' ? t.uri : `spotify:track:${t.id}`,
    externalUrl: t.external_urls?.spotify,
    albumType,
    // Same names the Navidrome walk stamps, read by tag-library/flags.ts and
    // the era pipeline. Spotify has no original-release date, so a compilation
    // reads as unknown-year exactly as an unresolved Navidrome compilation does.
    albumIsCompilation: isCompilation,
    albumOriginalYear: null,
    ...(extras.addedAt ? { created: extras.addedAt } : {}),
    _imageUrl: pickImage(album.images),
  };
}

export function mapAlbum(a: any): Album | null {
  if (!a || typeof a.id !== 'string') return null;
  const artists: Array<{ id?: string; name?: string }> = Array.isArray(a.artists) ? a.artists : [];
  return {
    id: a.id,
    name: a.name ?? '',
    artist: joinArtists(artists) || undefined,
    artistId: artists[0]?.id,
    year: releaseYear(a.release_date),
    songCount: typeof a.total_tracks === 'number' ? a.total_tracks : undefined,
    coverArt: a.id,
    // ISO release date keeps parity with Subsonic's `created`/`releaseDate`
    // for the newest-first sort in getRecentSongsByArtist.
    releaseDate: typeof a.release_date === 'string' ? a.release_date : undefined,
    albumType: typeof a.album_type === 'string' ? a.album_type : undefined,
    isCompilation: a.album_type === 'compilation' || isVariousArtists(joinArtists(artists)),
    _imageUrl: pickImage(a.images),
  };
}

export function mapArtist(a: any): Artist | null {
  if (!a || typeof a.id !== 'string') return null;
  return {
    id: a.id,
    name: a.name ?? '',
    genres: Array.isArray(a.genres) ? a.genres.map(String) : [],
    popularity: typeof a.popularity === 'number' ? a.popularity : undefined,
    _imageUrl: pickImage(a.images),
  };
}

export function mapPlaylist(p: any) {
  if (!p || typeof p.id !== 'string') return null;
  return {
    id: p.id,
    name: p.name ?? '',
    comment: p.description ?? undefined,
    owner: p.owner?.display_name ?? undefined,
    // `tracks` was renamed `items` in February 2026; read either.
    songCount: typeof p.items?.total === 'number' ? p.items.total
      : typeof p.tracks?.total === 'number' ? p.tracks.total : undefined,
    coverArt: p.id,
    _imageUrl: pickImage(p.images),
  };
}

// A playlist/saved item wraps the track; skip local files, episodes and
// unavailable rows (Spotify returns a null payload for a removed track).
//
// BOTH wrapper keys are read on purpose. February 2026 renamed the playlist
// row's `track` to `item` (GET /playlists/{id}/items), while the saved-tracks
// row (GET /me/tracks) still says `track`. This is the one function both walks
// go through, so accepting either here is what keeps them a single seam
// instead of two shapes drifting apart at their call sites.
export function unwrapItem(item: any): any | null {
  const t = item?.item ?? item?.track ?? item;
  if (!t || t.is_local || t.type === 'episode' || typeof t.id !== 'string') return null;
  return t;
}

export const SPOTIFY_ID_RE = /^[0-9A-Za-z]{22}$/;

export function trackIdFromUri(s: string | null | undefined): string | null {
  const v = String(s ?? '').trim();
  const m = /^spotify:track:([0-9A-Za-z]{22})$/.exec(v) || /open\.spotify\.com\/track\/([0-9A-Za-z]{22})/.exec(v);
  if (m) return m[1];
  return SPOTIFY_ID_RE.test(v) ? v : null;
}
