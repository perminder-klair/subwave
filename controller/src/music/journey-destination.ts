// Where a DJ-mode sonic journey may head (#1911). The journey's destination is
// the CLAP centroid of a small sample of tracks; this module decides which
// tracks that sample may come from.
//
// With no show on air the answer is unchanged: the daypart's energy bucket.
// With a show on air the destination must be somewhere INSIDE that show. A
// random energy bucket is how a show with a narrow era and style was walked,
// one waypoint per pick, into a lane its own brief excluded — the tool's
// description tells the model to strongly prefer the tracks nearest each
// waypoint, so the destination is where the set ends up.
//
// "Inside the show" is decided from what the operator configured, never from
// the free-text brief:
//   - a resolved playlist anchor is the show's sound, through the same
//     airableAnchorTracks rule the in-order walk and the no-repeat guard read;
//   - otherwise the show's music filters (genre, era, mood, energy, vocals)
//     applied HARD, whether the show is strict or not — a soft lean still says
//     where the show lives, and a destination is a direction, not a pick;
//   - a show with neither (a brief alone) cannot be placed in the library, so
//     it gets no journey at all. Heading for a guess is the bug being fixed;
//     the tempo/key run itself still plays.
// The excluded playlists drop in every case.

import * as library from './library.js';
import * as settings from '../settings.js';
import * as subsonic from './subsonic.js';
import { applyStrictLocks, hasEraBound, trackEnergy, type FilterTrack, type VocalMode, type YearRange } from './show-filter.js';
import { candidateCoverage } from './show-candidates.js';
import { airableAnchorTracks } from './show-recency.js';
import { applyKnownTrackCeiling } from './track-duration.js';
import { applyTrackFloor } from './track-floor.js';
import { resolveExcludedPlaylistIds, resolveShowPlaylistPool } from './show-playlist.js';
import { shuffle } from '../util/shuffle.js';

type DestinationTrack = FilterTrack & { id?: string; duration?: number | null; durationSec?: number | null };

export type JourneyShow = {
  id?: string;
  filtersStrict?: boolean;
  playlistStrict?: boolean;
  playlistIds?: string[];
  excludedPlaylistIds?: string[];
  genres?: string[];
  eras?: YearRange[];
  moods?: string[];
  energies?: string[];
  vocals?: string;
  minTrackLengthSeconds?: unknown;
  maxTrackSeconds?: unknown;
};

function vocalModeOf(raw: unknown): VocalMode | null {
  return raw === 'instrumental' || raw === 'vocal' ? raw : null;
}

// The tracks a journey may head toward while `show` is on air, or null when
// the show cannot be placed in the library (or nothing in it survives). Pure
// over its inputs; `libraryRows` is lazy because the full-library projection
// is only needed when no playlist anchor answers.
export function showDestinationPool<T extends DestinationTrack>({
  show,
  playlistTracks,
  libraryRows,
  resolvedGenres,
  excludedIds,
  minTrackSec = null,
  maxTrackSec = null,
}: {
  show: JourneyShow;
  // The show's resolved playlist anchor; null when it pins none or none resolved.
  playlistTracks: T[] | null;
  libraryRows: () => T[];
  // The show's free-text genres resolved onto library tags, unresolved ones
  // dropped — the pick paths' own rule ("the genre filter is OFF").
  resolvedGenres: string[];
  excludedIds: Set<string> | null;
  minTrackSec?: number | null;
  maxTrackSec?: number | null;
}): T[] | null {
  let pool: T[];
  if (playlistTracks?.length) {
    pool = airableAnchorTracks(playlistTracks, { show, excludedIds, resolvedGenres, minTrackSec, maxTrackSec });
  } else {
    // Nothing configured to place the show by: answer before the full-library
    // read, which a brief-only show would otherwise pay on every run start.
    const configured = !!(resolvedGenres.length || hasEraBound(show.eras) || show.moods?.length
      || show.energies?.length || vocalModeOf(show.vocals));
    if (!configured) return null;
    const rows = libraryRows();
    // A dimension the library carries no data for is not a lock, as on the
    // pick path: a hard mood filter over an untagged library empties
    // everything and would read as "this show has no sound".
    const coverage = candidateCoverage(rows);
    const locks = {
      genres: resolvedGenres,
      eras: hasEraBound(show.eras) ? show.eras! : [],
      moods: coverage.mood ? (show.moods ?? []) : [],
      energies: coverage.energy ? (show.energies ?? []) : [],
      vocals: coverage.vocal ? vocalModeOf(show.vocals) : null,
    };
    const placed = !!(locks.genres.length || locks.eras.length || locks.moods.length || locks.energies.length || locks.vocals);
    if (!placed) return null;
    pool = applyStrictLocks(rows, locks, { starve: true });
    pool = applyTrackFloor(applyKnownTrackCeiling(pool, maxTrackSec), minTrackSec, { starve: true });
    if (excludedIds?.size) pool = pool.filter(track => !!track.id && !excludedIds.has(track.id));
  }
  return pool.length ? pool : null;
}

// Shuffled, with the daypart's energy bucket first: inside the show, the
// journey still drifts the way the run's tempo/key target nudges, and falls
// back to the rest of the show when that bucket is thin.
export function destinationOrder<T extends DestinationTrack>(tracks: T[], preferredEnergy: string): string[] {
  const shuffled = shuffle(tracks);
  const ids: string[] = [];
  const rest: string[] = [];
  const seen = new Set<string>();
  for (const track of shuffled) {
    const id = track?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    (trackEnergy(track) === preferredEnergy ? ids : rest).push(id);
  }
  return ids.concat(rest);
}

async function resolvedShowGenres(genres: string[] | undefined): Promise<string[]> {
  const out: string[] = [];
  for (const genre of genres ?? []) {
    try {
      const resolved = await subsonic.resolveGenreName(genre);
      if (resolved) out.push(resolved);
    } catch {}
  }
  return out;
}

// Candidate destination ids, in probe order. With no show: the daypart energy
// bucket, exactly as before #1911. With a show: the show's own tracks, or null
// when the show cannot be placed — the caller then attaches no journey.
export async function journeyDestinationIds(show: JourneyShow | null, preferredEnergy: 'high' | 'low'): Promise<string[] | null> {
  // Ids only (#1723): mapping the whole bucket's rows just to sample 8 of them
  // cost ~0.75 s per run start on a 76k-track library.
  if (!show) return shuffle(library.idsByEnergy(preferredEnergy));
  const [playlistPool, excludedIds, resolvedGenres] = await Promise.all([
    resolveShowPlaylistPool(show),
    resolveExcludedPlaylistIds(show),
    resolvedShowGenres(show.genres),
  ]);
  const pool = showDestinationPool<DestinationTrack>({
    show,
    playlistTracks: playlistPool?.tracks ?? null,
    libraryRows: () => library.candidateFilterTracks(),
    resolvedGenres,
    excludedIds,
    minTrackSec: settings.effectiveMinTrackSec(show),
    maxTrackSec: settings.effectiveTrackLengthLimits(show).selectionMaxSec,
  });
  return pool ? destinationOrder(pool, preferredEnergy) : null;
}
