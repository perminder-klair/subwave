import { z } from 'zod';
import { createHash } from 'node:crypto';
import * as db from './library-db.js';
import * as library from './library.js';
import * as subsonic from './subsonic.js';
import * as settings from '../settings.js';
import * as blocklist from './blocklist.js';
import { preparationArtistSchema, preparationTrackSchema, type PreparationTrack } from '../schemas/show-preparation.js';
import { resolveExcludedPlaylistIds, resolveShowPlaylistPool } from './show-playlist.js';
import { applyStrictLocks } from './show-filter.js';
import { applyTrackFloor } from './track-floor.js';
import { applyKnownTrackCeiling } from './track-duration.js';
import { mapPool } from '../util/async-pool.js';
import { trackKey } from './recency.js';

export interface ArtistEpisodeSource {
  kind: 'artist'; identity: string;
  artist: { id: string; name: string };
  tracks: PreparationTrack[];
  ids: Set<string>;
}
const catalogues = new Map<string, { at: number; artist: ArtistEpisodeSource['artist']; tracks: PreparationTrack[] }>();
type EpisodeShow = NonNullable<ReturnType<typeof settings.resolveActiveShow>>;

export function intersectEpisodeSource<T extends { id?: string | null }>(tracks: T[], source: ArtistEpisodeSource | null): T[] {
  return source ? tracks.filter(t => !!t.id && source.ids.has(t.id)) : tracks;
}

export async function resolveArtistEpisodeSource(artistId: string, show: EpisodeShow, identity: string): Promise<ArtistEpisodeSource> {
  await library.load();
  let catalogue = catalogues.get(artistId);
  if (!catalogue || Date.now() - catalogue.at > 60_000) {
    const artist = preparationArtistSchema.parse(await subsonic.getArtist(artistId));
    if (artist.id !== artistId) throw new Error('The preparation artist is not in this library');
    const mirrored = db.tracksByArtistId(artistId);
    const expected = artist.album.reduce((n, album) => n + (album.songCount ?? 0), 0);
    let tracks: PreparationTrack[];
    if (expected > 0 && artist.album.every(a => a.songCount != null) && mirrored.length >= expected) {
      tracks = mirrored;
    } else {
      if (artist.album.length > 128) throw new Error('Artist catalogue is too large to fetch before playback; sync the library first');
      const albums = await mapPool(artist.album, 4, async album => {
        const songs = z.array(preparationTrackSchema).parse(await subsonic.getAlbum(album.id));
        return songs.filter(song => song.artistId === artistId || song.artists?.[0]?.id === artistId || song.albumArtists?.[0]?.id === artistId);
      });
      tracks = albums.flat();
    }
    catalogue = { at: Date.now(), artist: { id: artist.id, name: artist.name }, tracks };
    catalogues.set(artistId, catalogue);
    if (catalogues.size > 32) { const oldest = catalogues.keys().next().value; if (oldest) catalogues.delete(oldest); }
  }
  let tracks = blocklist.rejectBlocked(catalogue.tracks.filter(track => !subsonic.isStationArchive(track)));
  const excluded = await resolveExcludedPlaylistIds(show);
  if (excluded) tracks = tracks.filter(t => !excluded.has(t.id));
  if (show.playlistStrict && show.playlistIds.length) {
    const playlist = await resolveShowPlaylistPool(show);
    if (!playlist) throw new Error('The strict playlist could not be resolved for this artist episode');
    tracks = tracks.filter(t => playlist.ids.has(t.id));
  }
  if (show.filtersStrict) {
    const genres = (await Promise.all(show.genres.map(g => subsonic.resolveGenreName(g)))).filter((g): g is string => typeof g === 'string');
    tracks = applyStrictLocks(tracks, {
      genres, eras: show.eras, moods: show.moods, energies: show.energies,
      vocals: show.vocals === 'vocal' || show.vocals === 'instrumental' ? show.vocals : '',
    }, { starve: false });
  }
  tracks = applyTrackFloor(applyKnownTrackCeiling(tracks, settings.effectiveTrackLengthLimits(show).selectionMaxSec), settings.effectiveMinTrackSec(show), { starve: true });
  const seen = new Set<string>();
  tracks = tracks.filter(t => { const key = trackKey(t); if (seen.has(key)) return false; seen.add(key); return true; });
  if (!tracks.length) throw new Error('No playable songs remain for the prepared artist and show rules');
  const ids = new Set(tracks.map(t => t.id));
  const revision = createHash('sha256').update(JSON.stringify([...ids].sort())).digest('hex').slice(0, 16);
  return { kind: 'artist', identity: `${identity}:${revision}`, artist: catalogue.artist, tracks, ids };
}

export async function randomLibraryArtist({ minDistinctTracks = 2 }: { minDistinctTracks?: number } = {}): Promise<{ id: string; name: string } | null> {
  await library.load();
  const mirrored = db.artistIdentities(Math.max(1, minDistinctTracks));
  const artists = await subsonic.getLibraryArtists();
  if (!artists.length) return null;
  const indexedIds = new Set(artists.map(artist => artist.id));
  const eligible = mirrored.filter(artist => indexedIds.has(artist.id));
  if (eligible.length) return eligible[Math.floor(Math.random() * eligible.length)];
  const remaining = artists.slice();
  for (let n = 0; n < Math.min(5, artists.length); n++) {
    const [artist] = remaining.splice(Math.floor(Math.random() * remaining.length), 1);
    const full = preparationArtistSchema.parse(await subsonic.getArtist(artist.id));
    if (full.album.reduce((count, album) => count + (album.songCount ?? 0), 0) >= minDistinctTracks) return { id: full.id, name: full.name };
  }
  return null;
}
