// Pair-aware drain policy — the pure maths behind WHEN a queued track is
// handed to Liquidsoap (feature: pair-aware transitions, the #749 fix).
//
// Background: a track's annotate stamps (liq_cross_duration, liq_cue_out, the
// B2 stem-blend clip) control the transition at its OWN end — so they can only
// be pair-sized if its SUCCESSOR is known when the annotation is written.
// Today's eager drain (send on push) freezes every annotation seconds after
// the PREDECESSOR starts, one full track before the successor is picked.
// The fix: hold the tail of `upcoming` unsent until either its successor is
// queued behind it, or the on-air track is close enough to its end that we
// must send regardless. Pure and I/O-free so scripts/drain-policy.test.ts can
// pin the state machine.

// When the on-air track has less than this remaining, the deadline routine
// fires: pick the held item's successor now so the held item can drain
// pair-aware. Comfortably longer than a pick (seconds) + a cache-hit stem
// render (seconds-to-~1min), while still holding annotations open for most of
// each track's runtime.
export const DRAIN_DEADLINE_SEC = 120;

// Past this point the held item is sent with track-intrinsic stamps only —
// the pick/render didn't land in time and Liquidsoap must have the next track
// resolved well before the crossfade starts (1s queue poll + request resolve
// + subhttp fetch). Never risk dead air for a prettier seam.
export const HARD_DEADLINE_SEC = 45;

// Minimum gap between deadline-pick ATTEMPTS. The watcher tick re-enters
// maybeDeadlinePick every 1.5s for the whole pick window; a pick that fails
// fast (LLM host down, Navidrome refusing) would otherwise be re-fired ~50
// times per window — exactly the aggressive-retry pattern the LLM layer is
// documented to avoid. A successful pick self-limits (the held head gains a
// successor and the routine stops matching), so this only meters failures:
// the window still fits a few honest retries.
export const DEADLINE_PICK_COOLDOWN_SEC = 25;

// Seconds left before the on-air track's EFFECTIVE end — min(duration,
// stamped cue_out): a length-capped track ends at its cue, minutes before its
// tagged duration (pressure-test finding: raw duration desyncs the deadline).
// Null when unknowable (no start stamp / no usable duration) — callers treat
// null as "cannot schedule", which degrades to today's eager behaviour.
export function remainingSec(
  nowMs: number,
  startedAtMs: number | null | undefined,
  durationSec: number | null | undefined,
  cueOutSec?: number | null,
): number | null {
  if (typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs)) return null;
  const dur = typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null;
  if (dur == null) return null;
  const cue = typeof cueOutSec === 'number' && Number.isFinite(cueOutSec) && cueOutSec > 0 ? cueOutSec : null;
  const effective = cue != null ? Math.min(dur, cue) : dur;
  return (startedAtMs + effective * 1000 - nowMs) / 1000;
}

export type DrainAction = 'send-pair' | 'send-intrinsic' | 'hold';

// Decide what the drain loop does with the FIRST unsent item:
//  - 'send-pair'      — its successor is already queued behind it; stamp the
//                       pair-aware values and send now. This is also how a
//                       listener request landing behind a held pick releases
//                       it (the request IS the successor arriving) — FIFO is
//                       never inverted.
//  - 'hold'           — no successor yet, but there's still time for the
//                       deadline pick to provide one. The item stays unsent.
//  - 'send-intrinsic' — send now with track-intrinsic stamps only: the
//                       feature is off, the clock is unknowable (boot,
//                       recover, untracked auto play), or the hard deadline
//                       passed without a successor.
export function drainAction(opts: {
  pairDrain: boolean;
  hasSuccessor: boolean;
  remainingSec: number | null;
}): DrainAction {
  if (opts.hasSuccessor) return opts.pairDrain ? 'send-pair' : 'send-intrinsic';
  if (!opts.pairDrain) return 'send-intrinsic';
  if (opts.remainingSec == null) return 'send-intrinsic';
  if (opts.remainingSec < HARD_DEADLINE_SEC) return 'send-intrinsic';
  return 'hold';
}

// Whether the deadline routine should fire the successor pick this tick:
// inside the deadline window, not yet past the point where picking is
// pointless (the hard fallback owns the endgame; a pick landing after the
// intrinsic send would just sit in the queue an extra cycle — harmless, so
// the window extends to the hard deadline itself).
export function shouldDeadlinePick(remaining: number | null): boolean {
  return remaining != null && remaining < DRAIN_DEADLINE_SEC && remaining >= HARD_DEADLINE_SEC;
}
