// Hold the unsent tail until its successor is known or the hard deadline requires intrinsic
// stamps. Pick the successor early enough for selection and a cached stem render. #749,
// scripts/drain-policy.test.ts..
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

// Intro pre-render budget: null is unbounded when air time is unknown; zero skips pre-render;
// positive values bound the wait. airIntro can render the script later without delaying music.
// #1409.
export function introRenderBudgetSec(remaining: number | null): number | null {
  if (remaining == null) return null;
  const budget = remaining - DRAIN_COMMIT_RESERVE_SEC;
  return budget >= MIN_PRERENDER_BUDGET_SEC ? budget : 0;
}

type DrainAction = 'send-pair' | 'send-intrinsic' | 'hold';

// A successor releases the held item with pair stamps, including a listener request; preserve
// FIFO. Without a successor, hold until the deadline or send intrinsic stamps when timing is
// unavailable.
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
