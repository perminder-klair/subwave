// Which show the auto.m3u fallback was built for (#1111).
//
// `refreshAutoPlaylist` steers the fallback pool by the RESOLVED active show —
// its genres, era windows, energies, moods, vocal mode, strictness and pinned
// Navidrome playlists. It ran only at boot and on the `autoQueueRefreshMinutes`
// cron (default 60), so a show change landing between two ticks left the
// previous show's fallback on disk: with the live queue empty, a Playlist Only
// (Strict) show coasted on the OUTGOING show's tracks — 26 of 28 entries
// outside the pinned playlist in the report — until the operator pressed
// Refresh. Strict is enforced correctly when the file is rebuilt; nothing was
// rebuilding it.
//
// So the scheduler stamps the show identity it built for and compares it at
// every show boundary. This module is that identity, kept pure and away from
// the call site so it can be pinned (scripts/auto-playlist-show.test.ts)
// without booting Navidrome or Liquidsoap.
//
// The key covers every field the pool build reads, not just the show id: an
// operator editing the LIVE show's pinned playlist or era window has changed
// what the fallback should contain just as much as a grid boundary has. Lists
// are sorted, so re-ordering genres — which cannot change the pool — does not
// spend a rebuild.

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
}

const strings = (v: unknown): string[] =>
  (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []).slice().sort();

// Era windows are objects, not strings — flatten each to `from-to` first so the
// same sort applies and an open end reads as an empty side.
const eras = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [])
    .map((e: { fromYear?: unknown; toYear?: unknown } | null) => `${e?.fromYear ?? ''}-${e?.toYear ?? ''}`)
    .sort();

/**
 * A stable identity for the show the fallback should be built for. No show on
 * air (default programming, and the explicit Default-programming takeover) is
 * itself an identity — coming off a show has to rebuild too.
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
  });
}

/** How the booth log names a show identity. Never the key — that is machinery. */
export function autoPlaylistShowLabel(show: AutoPlaylistShow | null | undefined): string {
  if (!show) return 'default programming';
  const name = typeof show.name === 'string' ? show.name.trim() : '';
  return name ? `"${name}"` : `show ${typeof show.id === 'string' ? show.id : '?'}`;
}

/**
 * Tracks which show identity the file on disk was built for.
 *
 * Three calls rather than a bare variable because the ORDER matters and the
 * ordering rules are the whole fix:
 *   - `built(show)` is stamped by every writer of the file, at the end of a
 *     refresh that landed. A refresh that threw left the previous show's
 *     entries on disk, so it must NOT stamp — the next boundary has to see the
 *     change and retry.
 *   - `claim(show)` is taken before an in-flight rebuild is awaited, so two
 *     boundaries landing in the same second (an expiry sweep against an
 *     operator's cancel) don't both fan out the same Navidrome queries. It
 *     hands back a rollback for the rebuild that fails.
 *   - the initial `null` reads as "needs a rebuild", which is right: a
 *     controller that has never written the file has never written it for this
 *     show either.
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
