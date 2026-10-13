// No-repeat capacity for scheduled shows: the hard window clamped to the universe
// a pick may draw from. One module so the agent and pool paths share one policy.

import { effectiveNoRepeatWindow, exhaustiveNoRepeatWindow, trackKey } from './recency.js';
import { applyStrictLocks, type FilterTrack, type VocalMode, type YearRange } from './show-filter.js';
import { applyKnownTrackCeiling } from './track-duration.js';
import { applyTrackFloor } from './track-floor.js';

type ShowTrack = FilterTrack & {
  id?: string;
  title?: string | null;
  artist?: string | null;
  duration?: number | null;
  durationSec?: number | null;
};

type RecencyShow = {
  playlistStrict?: boolean;
  playlistExhaust?: boolean;
  filtersStrict?: boolean;
  genres?: string[];
  eras?: YearRange[];
  moods?: string[];
  energies?: string[];
  vocals?: string;
} | null;

export type ShowNoRepeatGuard = {
  // Distinct plays the hard guard withholds — what queue.recentlyPlayedByCount
  // is asked for.
  window: number;
  // The show's own full-rotation window (#1612) rather than a clamped N. The pool
  // picker samples its show-playlist source differently when set; never re-derive.
  exhaustive: boolean;
};

// What of a strict anchor can actually AIR: the show's strict locks (never-
// starve, as the pool picker applies them), the known length ceiling, the
// minimum-length floor, and the excluded playlists. ORDER-PRESERVING — every
// step is a filter — so the in-order walk (music/playlist-order.ts) walks the
// same set this guard counts. Two copies of "can this anchor track air" is how
// the rotation size and the running order would come to disagree.
export function airableAnchorTracks<T extends ShowTrack>(
  playlistTracks: T[],
  {
    show,
    excludedIds,
    resolvedGenres,
    minTrackSec,
    maxTrackSec,
  }: {
    show: RecencyShow;
    excludedIds: Set<string> | null;
    resolvedGenres?: string[];
    minTrackSec?: number | null;
    maxTrackSec?: number | null;
  },
): T[] {
  const filtered = show?.filtersStrict
    ? applyStrictLocks(playlistTracks, {
        genres: resolvedGenres ?? show.genres ?? [],
        eras: show.eras ?? [],
        moods: show.moods ?? [],
        energies: show.energies ?? [],
        vocals: (show.vocals === 'instrumental' || show.vocals === 'vocal'
          ? show.vocals
          : '') as VocalMode,
      }, { starve: false })
    : playlistTracks;
  // Hard, unlike the pool picker's never-starve use of the same floor: what can
  // air, not a pool that must not empty. Nothing left = nothing airable.
  const airable = applyTrackFloor(applyKnownTrackCeiling(filtered, maxTrackSec), minTrackSec ?? null, { starve: true });
  return airable.filter(track => !!track?.id && !excludedIds?.has(track.id));
}

// The whole library a STRICT-filter show may draw from: the indexed library's
// lock projection (library.candidateFilterTracks()) through the same airable
// rule as a strict anchor — never-starve locks, length ceiling and floor,
// excluded playlists. Null when the show is not strict, so a caller can pass
// the result straight to showNoRepeatGuard and the small-pool picker tool.
//
// Without it a strict show's hard window was sized from the WHOLE library: a
// 290-play window against a 49-track show withheld every eligible track within
// a few hours, every discovery source came back empty, and each pick fell to
// the fallback pool. A strict playlist was already clamped to its own size; a
// strict filter is the same kind of closed catalogue.
export function strictShowLibraryPool<T extends ShowTrack>(
  libraryTracks: T[] | null | undefined,
  opts: {
    show: RecencyShow;
    excludedIds: Set<string> | null;
    resolvedGenres?: string[];
    minTrackSec?: number | null;
    maxTrackSec?: number | null;
  },
): T[] | null {
  if (!opts.show?.filtersStrict || !libraryTracks) return null;
  return airableAnchorTracks(libraryTracks, opts);
}

export function showNoRepeatGuard(
  configuredN: number | null | undefined,
  libraryTotal: number | null | undefined,
  {
    show,
    playlistTracks,
    episodeTracks = null,
    excludedIds,
    resolvedGenres,
    minTrackSec,
    maxTrackSec,
    showLibraryPool = null,
  }: {
    show: RecencyShow;
    playlistTracks: ShowTrack[] | null;
    episodeTracks?: ShowTrack[] | null;
    excludedIds: Set<string> | null;
    // Free-text show genres already resolved onto library tags, so capacity and
    // eligibility agree.
    resolvedGenres?: string[];
    // settings.effectiveMinTrackSec (#1573). Counted HARD: a track that will
    // never air must not size the window.
    minTrackSec?: number | null;
    maxTrackSec?: number | null;
    // strictShowLibraryPool's answer for this show; null/absent keeps the
    // library-wide window.
    showLibraryPool?: ShowTrack[] | null;
  },
): ShowNoRepeatGuard {
  if (episodeTracks) {
    const identities = new Set(episodeTracks.map(track => track.title ? `key:${trackKey(track)}` : `id:${track.id}`));
    return { window: effectiveNoRepeatWindow(configuredN, identities.size), exhaustive: false };
  }
  // A soft anchor can leave the playlist, and an unresolved strict anchor has
  // no playlist lock at runtime. Both still need the library-wide window.
  if (!show?.playlistStrict || playlistTracks == null) {
    // A strict-filter show cannot leave its filters, whatever its playlist
    // posture, so its own pool is the catalogue the window must fit.
    if (showLibraryPool) {
      return { window: effectiveNoRepeatWindow(configuredN, identityCount(showLibraryPool)), exhaustive: false };
    }
    return { window: effectiveNoRepeatWindow(configuredN, libraryTotal), exhaustive: false };
  }

  const airable = airableAnchorTracks(playlistTracks, { show, excludedIds, resolvedGenres, minTrackSec, maxTrackSec });

  const identities = { size: identityCount(airable) };

  // Full rotation (#1612): window is the rotation's own size, recomputed per pick.
  // `=== true`, not truthy, matching showBool()'s reading of the saved shape.
  if (show.playlistExhaust === true) {
    // Too small to carry its own window yields 0 and must NOT fall back to the
    // configured window; off means off and the relaxable cascade takes it.
    const window = exhaustiveNoRepeatWindow(identities.size);
    return { window, exhaustive: window > 0 };
  }

  return { window: effectiveNoRepeatWindow(configuredN, identities.size), exhaustive: false };
}

// Count audible identities, not rows: duplicate rips with different ids consume
// one slot in the real rotation and must not inflate its capacity.
function identityCount(tracks: ShowTrack[]): number {
  const identities = new Set<string>();
  for (const track of tracks) {
    identities.add(track.title ? `key:${trackKey(track)}` : `id:${track.id}`);
  }
  return identities.size;
}
