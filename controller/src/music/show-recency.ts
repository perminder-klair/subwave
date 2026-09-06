// No-repeat capacity for scheduled shows.
//
// The station-wide hard window is safe only when it is clamped to the actual
// universe a pick may draw from. Most picks use the full library; a resolved
// playlistStrict show instead uses its post-filter, post-exclusion playlist.
// Keeping the decision here makes the agent and pool paths share one policy.

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
  // Whether that window is the show's own full-rotation window (#1612) rather
  // than the operator's configured N clamped to a universe. Read by the pool
  // picker, which has to sample its show-playlist source differently when all
  // but a handful of the anchor is withheld; never re-derived at a call site.
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
    // The picker resolves free-text show genres onto exact library tags before
    // filtering. Use that same lock here so capacity and eligibility agree.
    resolvedGenres?: string[];
    // The show's effective minimum track length (#1573), already resolved by
    // the caller through settings.effectiveMinTrackSec. Counted HARD, matching
    // the agent's discovery tools: a playlist's 40-second interlude is never
    // going to air, so counting it would size the window against a rotation
    // that is bigger than the one really turning — which, under an exhaustive
    // window, is the difference between one eligible track and none.
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
  // Hard, unlike the pool picker's own never-starve application of the same
  // floor: this is a COUNT of what can air, not a pool that must not empty.
  // A floor that leaves nothing leaves an empty rotation, which falls through
  // to a zero window below and hands the show back to the relaxable cascade.
  const airable = applyTrackFloor(filtered, minTrackSec ?? null, { starve: true });

  // Count audible identities, not Subsonic rows: duplicate rips with different
  // ids consume one slot in the real rotation and must not inflate its capacity.
  const identities = new Set<string>();
  for (const track of airable) {
    if (!track?.id || excludedIds?.has(track.id)) continue;
    identities.add(track.title ? `key:${trackKey(track)}` : `id:${track.id}`);
  }

  // Full rotation (#1612): the operator asked for every track in this anchor to
  // air once before any of them repeats, so the window is the rotation's own
  // size rather than the configured N. Recomputed on every pick, so a playlist
  // that grows in Navidrome widens the window on the next one.
  // `=== true`, not truthy: showBool() reads anything but a real boolean true
  // as off, and a policy that disagreed with the shape would opt a
  // hand-edited `"playlistExhaust": "yes"` into a window the save path says it
  // never set.
  if (show.playlistExhaust === true) {
    const window = exhaustiveNoRepeatWindow(identities.size);
    // A rotation too small to carry its own window (exhaustiveNoRepeatWindow
    // returned 0) must not silently fall back to the CONFIGURED window instead:
    // that number was measured against the library, not against a handful of
    // tracks, and re-clamping it here would reintroduce exactly the guard the
    // headroom just refused. Off means off — the relaxable cascade takes it.
    return { window, exhaustive: window > 0 };
  }

  return { window: effectiveNoRepeatWindow(configuredN, identities.size), exhaustive: false };
}
