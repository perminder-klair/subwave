// Which show the auto.m3u fallback was built for (#1111). The scheduler stamps
// this identity and compares it at every show boundary, so a show change
// between refresh ticks rebuilds instead of coasting on the outgoing show.
//
// The key covers every field the pool build reads, not just the show id —
// editing the live show's pinned playlist or era window changes what the
// fallback should contain. Lists are sorted, so re-ordering never rebuilds.

export interface AutoPlaylistShow {
  id?: unknown;
  name?: unknown;
  genres?: unknown;
  eras?: unknown;
  energies?: unknown;
  moods?: unknown;
  vocals?: unknown;
  filtersStrict?: unknown;
  playlistIds?: unknown;
  playlistStrict?: unknown;
  excludedPlaylistIds?: unknown;
  maxTrackSeconds?: unknown;
  minTrackLengthSeconds?: unknown;
}

const strings = (v: unknown): string[] =>
  (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []).slice().sort();

// Era windows are objects: flatten to `from-to` so the same sort applies and an
// open end reads as an empty side.
const eras = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [])
    .map((e: { fromYear?: unknown; toYear?: unknown } | null) => `${e?.fromYear ?? ''}-${e?.toYear ?? ''}`)
    .sort();

/**
 * A stable identity for the show the fallback should be built for. No show on
 * air is itself an identity — coming off a show has to rebuild too.
 */
export function autoPlaylistShowKey(show: AutoPlaylistShow | null | undefined): string {
  if (!show) return 'default';
  return JSON.stringify({
    id: typeof show.id === 'string' ? show.id : '',
    genres: strings(show.genres),
    eras: eras(show.eras),
    energies: strings(show.energies),
    moods: strings(show.moods),
    vocals: typeof show.vocals === 'string' ? show.vocals : '',
    filtersStrict: show.filtersStrict === true,
    playlistIds: strings(show.playlistIds),
    playlistStrict: show.playlistStrict === true,
    excludedPlaylistIds: strings(show.excludedPlaylistIds),
    maxTrackSeconds: typeof show.maxTrackSeconds === 'number' ? show.maxTrackSeconds : null,
    // Changes WHICH tracks the fallback may contain (#1573), so it rebuilds.
    minTrackLengthSeconds:
      typeof show.minTrackLengthSeconds === 'number' ? show.minTrackLengthSeconds : null,
  });
}

/** How the booth log names a show identity. Never the key — that is machinery. */
export function autoPlaylistShowLabel(show: AutoPlaylistShow | null | undefined): string {
  if (!show) return 'default programming';
  const name = typeof show.name === 'string' ? show.name.trim() : '';
  return name ? `"${name}"` : `show ${typeof show.id === 'string' ? show.id : '?'}`;
}

/**
 * Tracks which show identity the file on disk was built for. Ordering is the
 * whole point:
 *   - `built(show)` is stamped only at the end of a refresh that LANDED; a
 *     refresh that threw must not stamp, so the next boundary retries.
 *   - `claim(show)` is taken before awaiting an in-flight rebuild so two
 *     boundaries in the same second don't both fan out Navidrome queries; it
 *     returns a rollback for the rebuild that fails.
 *   - initial `null` reads as "needs a rebuild".
 */
export function createShowBuildTracker() {
  let builtFor: string | null = null;
  return {
    /** True when the file on disk was not built for this show. */
    needsRebuild(show: AutoPlaylistShow | null | undefined): boolean {
      return autoPlaylistShowKey(show) !== builtFor;
    },
    /** Record a build that landed. */
    built(show: AutoPlaylistShow | null | undefined): void {
      builtFor = autoPlaylistShowKey(show);
    },
    /** Claim a rebuild before awaiting it; call the returned rollback if it fails. */
    claim(show: AutoPlaylistShow | null | undefined): () => void {
      const previous = builtFor;
      builtFor = autoPlaylistShowKey(show);
      return () => { builtFor = previous; };
    },
  };
}
