// Shared source availability policy: whether a discovery source may run for the
// current show. Each rule is reached from the pool picker, the auto.m3u coast,
// the discovery tools and the Shortlist planner, so it lives here once.

// #642: configured or resolved show playlists own the curated-playlist lane,
// including stale pins.
export function allowsMoodPlaylistDiscovery({ hasPlaylistAnchor = false, playlistTracks, playlistLock }: {
  hasPlaylistAnchor?: boolean; playlistTracks?: readonly unknown[] | null; playlistLock?: ReadonlySet<string> | null;
}): boolean {
  return !hasPlaylistAnchor && !playlistTracks?.length && !playlistLock;
}

// Soft show moods count as pinned too; strict locks are only one way an
// operator can own the mood direction.
export function allowsMoodWildcardDiscovery(scope: {
  hasPinnedMoods?: boolean;
  moodLock?: readonly unknown[] | null;
  episodeSource?: unknown;
  audioWaypoint?: readonly unknown[] | null;
  playlistLock?: unknown;
}): boolean {
  return !scope.hasPinnedMoods && !scope.moodLock?.length
    && !scope.episodeSource && !scope.audioWaypoint?.length && !scope.playlistLock;
}
