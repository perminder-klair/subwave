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

// Effective on-air span: [cue_in, min(duration, cue_out)]. Both cue values are
// absolute offsets in the file, while startedAt is stamped when playback begins
// at cue_in, so the skipped head must not count toward the remaining clock.
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

// Seconds left before the on-air track's EFFECTIVE end — its playable span
// after both cue points. A length-capped or silence-trimmed track therefore
// ends when Liquidsoap does, not at its original tagged duration.
// Null when unknowable (no start stamp / no usable duration) — callers treat
// null as "cannot schedule", which degrades to today's eager behaviour.
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

// Runway the drain keeps for the commit tail that follows the intro render
// inside ONE drain pass: the bed's handoff write and the track URI's own
// (writeHandoff waits up to 5s each for Liquidsoap's 1.0s poll to consume the
// file), plus the loudness lookup and the annotate. The pre-render is an
// optimisation and must never eat into it.
export const DRAIN_COMMIT_RESERVE_SEC = 12;

// Below this there is no honest render window left — starting a TTS call that
// cannot finish only delays the music commit for a WAV nobody will use.
export const MIN_PRERENDER_BUDGET_SEC = 5;

// How long the drain may spend pre-rendering a queued item's intro/link WAV
// before it MUST commit the music instead (#1409). The hard deadline governs
// the drain VERDICT; everything between that verdict and the `next.txt` write
// is optional work, and on a slow local TTS engine the render alone can
// outlast the remaining runway — Liquidsoap then falls through to `auto.m3u`
// and the pick airs one track late.
//
// Returns:
//   null  — unbounded, today's behaviour. The clock is unknowable (boot,
//           recover, untracked auto play), so there is no seam to miss and
//           no basis for a budget.
//   0     — skip the pre-render entirely; commit the music now. `airIntro`
//           renders from `introScript` at air time, the path that already
//           covers a reaped WAV or a voice switch flipped back on.
//   >0    — seconds the render may take before the drain moves on without it.
//
// Skipping is cheap precisely because the render is recoverable at air time;
// a missed seam is not.
export function introRenderBudgetSec(remaining: number | null): number | null {
  if (remaining == null) return null;
  const budget = remaining - DRAIN_COMMIT_RESERVE_SEC;
  return budget >= MIN_PRERENDER_BUDGET_SEC ? budget : 0;
}

type DrainAction = 'send-pair' | 'send-intrinsic' | 'hold';

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
