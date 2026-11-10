// Pure decisions behind broadcast/scrobble.ts: no I/O, no settings, no clock of
// its own (every entry point takes `nowMs`). The eligibility rule is shared by
// all three backends; only Navidrome's gate differs, hence `planNavidrome`.

export interface ScrobbleTrackLike {
  id?: string | null;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  duration?: number | null; // seconds, optional
}

// Last.fm's rule: track >30s, and either >50% played or >4 minutes.
export const MIN_DURATION_SEC = 30;
export const MIN_ELAPSED_FLOOR_SEC = 240;

export function elapsedSeconds(
  startedAt: string | null | undefined,
  nowMs: number = Date.now(),
): number {
  if (!startedAt) return 0;
  const t = Date.parse(startedAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((nowMs - t) / 1000));
}

export function isEligibleScrobble(
  track: ScrobbleTrackLike | null,
  elapsed: number,
): boolean {
  if (!track?.title || !track?.artist) return false;
  const d = Number(track.duration);
  if (Number.isFinite(d) && d > 0) {
    if (d <= MIN_DURATION_SEC) return false;
    return elapsed >= d / 2 || elapsed >= MIN_ELAPSED_FLOOR_SEC;
  }
  // Duration unknown (auto-playlist tracks don't carry it through the annotation
  // chain). There is no skip endpoint, so a replaced track played to completion:
  // treat elapsed as the duration and apply only the >30s floor.
  return elapsed >= MIN_DURATION_SEC;
}

export interface NavidromePlanInput {
  /** settings.scrobble.navidrome.enabled — default false, so an upgrade is a no-op. */
  enabled: boolean;
  /** Navidrome URL + user + password all present in config. */
  configured: boolean;
  incoming: ScrobbleTrackLike | null;
  outgoing: ScrobbleTrackLike | null;
  outgoingStartedAt: string | null;
  nowMs?: number;
}

export interface NavidromePlan {
  /** `scrobble?submission=false` for this song id, or null. */
  nowPlayingId: string | null;
  /** `scrobble?submission=true` for this song id, or null. */
  submitId: string | null;
  /** `time` for the submission — ms since epoch, the moment the play STARTED. */
  submitAtMs: number | null;
  /** One-line reason nothing will be sent at all; null when the backend ran. */
  skip: string | null;
}

/**
 * What to send Navidrome for one track transition. Two deliberate differences
 * from the Last.fm / ListenBrainz plan:
 *
 * 1. No listener gate. Navidrome is the operator's own library and the point is
 *    rotation (#1298) — every aired track must be stamped so `lastPlayed` smart
 *    playlists work, whether or not anyone heard it. Never unify this onto
 *    `presentListeners()`.
 * 2. The song id is required, not artist/title: Subsonic `scrobble` addresses a
 *    row by id, so a play with no `subsonic_id` is skipped rather than guessed.
 *
 * The submission still honours the shared eligibility rule.
 */
export function planNavidrome(input: NavidromePlanInput): NavidromePlan {
  const empty: NavidromePlan = {
    nowPlayingId: null,
    submitId: null,
    submitAtMs: null,
    skip: null,
  };
  if (!input.enabled) return { ...empty, skip: 'navidrome scrobbling disabled' };
  if (!input.configured) return { ...empty, skip: 'navidrome not configured' };

  const plan: NavidromePlan = { ...empty };

  const incomingId = String(input.incoming?.id || '').trim();
  if (incomingId) plan.nowPlayingId = incomingId;

  const outgoingId = String(input.outgoing?.id || '').trim();
  if (outgoingId && input.outgoingStartedAt) {
    const startedMs = Date.parse(input.outgoingStartedAt);
    if (Number.isFinite(startedMs)) {
      const elapsed = elapsedSeconds(input.outgoingStartedAt, input.nowMs ?? Date.now());
      if (isEligibleScrobble(input.outgoing, elapsed)) {
        plan.submitId = outgoingId;
        plan.submitAtMs = startedMs;
      }
    }
  }
  return plan;
}
