// Pure decisions behind broadcast/scrobble.ts — no I/O, no settings reads, no
// clock of its own (every entry point takes `nowMs`). Split out so the
// eligibility rule and the Navidrome plan can be driven from a test table
// instead of a live station.
//
// The eligibility rule is shared by all three backends; the plan is
// Navidrome-only because Navidrome is the one backend whose gate differs (see
// `planNavidrome`).

export interface ScrobbleTrackLike {
  id?: string | null;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  duration?: number | null; // seconds, optional
}

// Last.fm's documented rule for a "valid scrobble":
//   - the track must be longer than 30 seconds
//   - and either >50% of the track has been played, or >4 minutes (whichever
//     comes first)
// When duration is unknown we can only enforce the 4-minute floor.
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
  // chain). SUB/WAVE has no skip endpoint — Liquidsoap controls pacing and a
  // new track replacing the old one means the old one played to natural
  // completion. Treat elapsed as the effective duration and apply only the
  // >30s floor (Last.fm's "ignore short clips" rule).
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
 * What to send Navidrome for one track transition.
 *
 * Two things make this different from the Last.fm / ListenBrainz plan, and
 * both are deliberate:
 *
 * 1. **No listener gate.** The public scrobblers fail CLOSED on an unknown
 *    listener count because a monitoring blip that pollutes a real Last.fm
 *    profile is worse than a missed entry. Navidrome is the operator's OWN
 *    library and the thing #1298 asks for is rotation: a `.nsp` smart playlist
 *    filtering on `lastPlayed` only works if every track the station actually
 *    aired is stamped. A play that nobody heard still has to stop the picker
 *    reaching for the same track an hour later, so an empty room is not a
 *    reason to skip. Never "unify" this onto `presentListeners()`.
 * 2. **The song id is required, not the artist/title pair.** Subsonic
 *    `scrobble` addresses a library row by id; an untracked auto-playlist play
 *    that reached the mixer without a `subsonic_id` has nothing to stamp and is
 *    silently skipped rather than guessed at.
 *
 * The submission still honours the shared eligibility rule, so a track cut
 * short doesn't count as a play.
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
