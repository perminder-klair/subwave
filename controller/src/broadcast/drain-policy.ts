// Pair-aware drain policy (#749): WHEN a queued track is handed to Liquidsoap.
// A track's annotate stamps control the transition at its own end, so they can
// only be pair-sized if its SUCCESSOR is known when written — hence the tail of
// `upcoming` is held unsent until a successor is queued behind it, or the
// on-air track is close enough to its end that it must send regardless. Pure
// and I/O-free for scripts/drain-policy.test.ts.

// Remaining time at which the deadline routine picks the held item's successor
// so it can drain pair-aware. Longer than a pick + a cache-hit stem render.
export const DRAIN_DEADLINE_SEC = 120;

// Past this the held item is sent with track-intrinsic stamps only: Liquidsoap
// needs the next track resolved well before the crossfade. Never risk dead air
// for a prettier seam.
export const HARD_DEADLINE_SEC = 45;

// Minimum gap between deadline-pick ATTEMPTS. The watcher re-enters every 1.5s,
// so without this a fast-failing pick re-fires ~50 times per window. A
// successful pick self-limits, so this only meters failures.
export const DEADLINE_PICK_COOLDOWN_SEC = 25;

// Effective on-air span: [cue_in, min(duration, cue_out)]. Cue values are
// absolute file offsets while startedAt is stamped at cue_in, so the skipped
// head must not count toward the remaining clock.
export function playableDurationSec(
  durationSec: number | null | undefined,
  cueOutSec?: number | null,
  cueInSec?: number | null,
): number | null {
  const dur = typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null;
  if (dur == null) return null;
  const cueOut = typeof cueOutSec === 'number' && Number.isFinite(cueOutSec) && cueOutSec > 0 ? cueOutSec : null;
  const cueIn = typeof cueInSec === 'number' && Number.isFinite(cueInSec) && cueInSec > 0 ? cueInSec : 0;
  return Math.max(0, Math.min(dur, cueOut ?? dur) - cueIn);
}

// Seconds left before the on-air track's EFFECTIVE end (playable span after
// both cue points), so a capped or trimmed track ends when Liquidsoap does.
// Null when unknowable; callers treat null as "cannot schedule" and drain
// eagerly.
export function remainingSec(
  nowMs: number,
  startedAtMs: number | null | undefined,
  durationSec: number | null | undefined,
  cueOutSec?: number | null,
  cueInSec?: number | null,
): number | null {
  if (typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs)) return null;
  const playable = playableDurationSec(durationSec, cueOutSec, cueInSec);
  if (playable == null) return null;
  return (startedAtMs + playable * 1000 - nowMs) / 1000;
}

// Runway kept for the commit tail after the intro render in one drain pass:
// the bed and track handoff writes (up to 5s each), the loudness lookup and the
// annotate. The pre-render must never eat into it.
export const DRAIN_COMMIT_RESERVE_SEC = 12;

// Below this there is no honest render window left — starting a TTS call that
// cannot finish only delays the music commit for a WAV nobody will use.
export const MIN_PRERENDER_BUDGET_SEC = 5;

// How long the drain may pre-render an intro/link WAV before it MUST commit the
// music (#1409). On a slow TTS engine the render alone can outlast the runway
// and the pick then airs one track late.
//   null — unbounded; the clock is unknowable, so there is no seam to miss.
//   0    — skip the pre-render; airIntro re-renders from introScript at air
//          time, so skipping is cheap and a missed seam is not.
//   >0   — seconds the render may take before the drain moves on without it.
export function introRenderBudgetSec(remaining: number | null): number | null {
  if (remaining == null) return null;
  const budget = remaining - DRAIN_COMMIT_RESERVE_SEC;
  return budget >= MIN_PRERENDER_BUDGET_SEC ? budget : 0;
}

type DrainAction = 'send-pair' | 'send-intrinsic' | 'hold';

// Decide what the drain loop does with the FIRST unsent item:
//  - 'send-pair'      — successor already queued; stamp pair-aware and send.
//                       A listener request landing behind a held pick releases
//                       it the same way, so FIFO is never inverted.
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

// Whether the deadline routine fires the successor pick this tick: inside the
// deadline window and not past the hard deadline, which owns the endgame.
export function shouldDeadlinePick(remaining: number | null): boolean {
  return remaining != null && remaining < DRAIN_DEADLINE_SEC && remaining >= HARD_DEADLINE_SEC;
}
