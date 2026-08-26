// No-repeat capacity for scheduled shows.
//
// The station-wide hard window is safe only when it is clamped to the actual
// universe a pick may draw from. Most picks use the full library; a resolved
// playlistStrict show instead uses its post-filter, post-exclusion playlist.
// Keeping the decision here makes the agent and pool paths share one policy.

import { effectiveNoRepeatWindow, trackKey } from './recency.js';
import { applyStrictLocks, type FilterTrack, type VocalMode, type YearRange } from './show-filter.js';

type ShowTrack = FilterTrack & {
  id?: string;
  title?: string | null;
  artist?: string | null;
};

type RecencyShow = {
  playlistStrict?: boolean;
  filtersStrict?: boolean;
  genres?: string[];
  eras?: YearRange[];
  moods?: string[];
  energies?: string[];
  vocals?: string;
} | null;

export function effectiveShowNoRepeatWindow(
  configuredN: number | null | undefined,
  libraryTotal: number | null | undefined,
  {
    show,
    playlistTracks,
    excludedIds,
    resolvedGenres,
  }: {
    show: RecencyShow;
    playlistTracks: ShowTrack[] | null;
    excludedIds: Set<string> | null;
    // The picker resolves free-text show genres onto exact library tags before
    // filtering. Use that same lock here so capacity and eligibility agree.
    resolvedGenres?: string[];
  },
): number {
  // A soft anchor can leave the playlist, and an unresolved strict anchor has
  // no playlist lock at runtime. Both still need the library-wide window.
  if (!show?.playlistStrict || playlistTracks == null) {
    return effectiveNoRepeatWindow(configuredN, libraryTotal);
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

  // Count audible identities, not Subsonic rows: duplicate rips with different
  // ids consume one slot in the real rotation and must not inflate its capacity.
  const identities = new Set<string>();
  for (const track of filtered) {
    if (!track?.id || excludedIds?.has(track.id)) continue;
    identities.add(track.title ? `key:${trackKey(track)}` : `id:${track.id}`);
  }

  return effectiveNoRepeatWindow(configuredN, identities.size);
}
