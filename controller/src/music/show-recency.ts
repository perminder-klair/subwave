// No-repeat capacity for scheduled shows: the hard window clamped to the universe
// a pick may draw from. One module so the agent and pool paths share one policy.

import { effectiveNoRepeatWindow, exhaustiveNoRepeatWindow, trackKey } from './recency.js';
import { applyStrictLocks, type FilterTrack, type VocalMode, type YearRange } from './show-filter.js';
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

export function showNoRepeatGuard(
  configuredN: number | null | undefined,
  libraryTotal: number | null | undefined,
  {
    show,
    playlistTracks,
    excludedIds,
    resolvedGenres,
    minTrackSec,
  }: {
    show: RecencyShow;
    playlistTracks: ShowTrack[] | null;
    excludedIds: Set<string> | null;
    // Free-text show genres already resolved onto library tags, so capacity and
    // eligibility agree.
    resolvedGenres?: string[];
    // settings.effectiveMinTrackSec (#1573). Counted HARD: a track that will
    // never air must not size the window.
    minTrackSec?: number | null;
  },
): ShowNoRepeatGuard {
  // A soft anchor can leave the playlist, and an unresolved strict anchor has
  // no playlist lock at runtime. Both still need the library-wide window.
  if (!show?.playlistStrict || playlistTracks == null) {
    return { window: effectiveNoRepeatWindow(configuredN, libraryTotal), exhaustive: false };
  }

  const filtered = show.filtersStrict
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
  // Hard, unlike the pool picker's never-starve use of the same floor: a count of
  // what can air, not a pool that must not empty. Nothing left = zero window.
  const airable = applyTrackFloor(filtered, minTrackSec ?? null, { starve: true });

  // Count audible identities, not Subsonic rows: duplicate rips with different
  // ids consume one slot in the real rotation and must not inflate its capacity.
  const identities = new Set<string>();
  for (const track of airable) {
    if (!track?.id || excludedIds?.has(track.id)) continue;
    identities.add(track.title ? `key:${trackKey(track)}` : `id:${track.id}`);
  }

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
