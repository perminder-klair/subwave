// "Until the schedule changes" — how a takeover's end instant is chosen (#1601).
//
// The timed takeover (#930) has always stored an ABSOLUTE `expiresAt` rather
// than a duration, so holding a pin until the weekly grid would have moved on
// anyway needs no new stored field: it is a different way of choosing that one
// instant. Everything downstream — resolveActiveShow, the janitor sweep, the
// programme span, the roster sweep — keeps reading an ordinary
// ScheduleOverride and cannot tell which way the window was picked.
//
// Three rules the obvious version gets wrong:
//
//  - The boundary is the GRID's, not the resolver's. `resolveActiveShow`
//    honours a live takeover, so scanning through it answers "when does the pin
//    I am about to replace run out", which is nobody's question. The scan hands
//    that same resolver a snapshot with the override taken OUT rather than
//    restating the day/hour lookup here — a second copy is how a takeover
//    replacing a takeover would come to disagree with the grid it is measured
//    against.
//  - The scan walks the STATION clock, minute by minute. Slots fire at the
//    hours the operator painted them in (#353) and zones sit at :30/:45
//    offsets, so "now plus an hour" is not reliably the next hour there. That
//    is `show-boundary.ts`'s `nextShowChangeMs`, reused rather than copied —
//    with no `extra` candidates, because a takeover's own start/expiry are
//    exactly what this question excludes.
//  - The answer is CLAMPED at both ends, and neither clamp is decoration. A
//    grid that never changes inside the horizon must still produce a bounded
//    pin (schemas/schedule.ts: the cap exists so a forgotten pin can't shadow
//    the grid for days), and a boundary a couple of minutes out would store a
//    window shorter than any takeover can act on — the switch lands at the next
//    track boundary, so a pin that expires before one arrives airs nothing at
//    all and costs two session rolls.
//
// The pure resolution and the impure scan are split so scripts/takeover-window.test.ts
// can drive every clamp without standing a schedule up.

import { OVERRIDE_MAX_MINUTES, OVERRIDE_MIN_MINUTES } from '../schemas/schedule.js';
import { zonedParts } from '../time.js';
import * as settings from '../settings.js';
import { nextShowChangeMs } from './show-boundary.js';

/** Which rule decided the end instant — the reason the dialog shows and the
 *  booth log prints, so an operator is never told a time without its why. */
export type TakeoverWindowSource =
  /** The grid's own next change. */
  | 'schedule'
  /** The change is nearer than a takeover can act in — held to the floor. */
  | 'minimum'
  /** No change within reach — held to the longest pin the station allows. */
  | 'maximum';

export interface TakeoverWindow {
  /** The absolute instant to store as `ScheduleOverride.expiresAt`. */
  expiresAt: number;
  /** Whole minutes from `startedAt`, for the booth log and the dialog. */
  minutes: number;
  source: TakeoverWindowSource;
  /** The grid change this was resolved from, or null when there is none in
   *  reach — reported so the dialog can say which of the two it is showing. */
  nextChangeAt: number | null;
}

/**
 * The window a `until: 'schedule-change'` takeover starting at `startedAt`
 * would get, given the next grid change (or null for none in reach).
 *
 * Pure. The clamps are the same pair the request bounds are written in, so a
 * resolved window is always one `scheduleOverrideSchema` would accept.
 */
export function resolveTakeoverWindow(input: {
  startedAt: number;
  nextChangeAt: number | null;
}): TakeoverWindow {
  const { startedAt } = input;
  const floor = startedAt + OVERRIDE_MIN_MINUTES * 60_000;
  const ceiling = startedAt + OVERRIDE_MAX_MINUTES * 60_000;
  const at = Number.isFinite(input.nextChangeAt) ? (input.nextChangeAt as number) : null;

  let expiresAt = at ?? ceiling;
  let source: TakeoverWindowSource = at == null ? 'maximum' : 'schedule';
  // Order matters only in that the floor is checked first: with a horizon of
  // OVERRIDE_MAX_MINUTES the scan cannot return anything past the ceiling, so
  // that branch is a guard on a caller passing its own instant in.
  if (expiresAt < floor) {
    expiresAt = floor;
    source = 'minimum';
  } else if (expiresAt > ceiling) {
    expiresAt = ceiling;
    source = 'maximum';
  }
  return {
    expiresAt,
    minutes: Math.round((expiresAt - startedAt) / 60_000),
    source,
    nextChangeAt: at,
  };
}

/**
 * The next instant the WEEKLY GRID stops naming the show it names at `fromMs`,
 * within one maximum takeover window, or null if it never does.
 *
 * A live takeover is excluded on purpose (see the header): the question is what
 * the schedule would have done, not what the pin being replaced was doing.
 */
export function nextGridChangeAt(fromMs: number, horizonMinutes = OVERRIDE_MAX_MINUTES): number | null {
  const gridOnly = { ...settings.get(), scheduleOverride: null };
  return nextShowChangeMs({
    fromMs,
    horizonMs: horizonMinutes * 60_000,
    // Coming OFF a show onto default programming is a change like any other —
    // the same identity showKeyAt uses, so the two scans agree about what a
    // boundary is.
    keyAt: (ms) => {
      const show = settings.resolveActiveShow(new Date(ms), gridOnly);
      return show?.id ? `show:${show.id}` : 'default';
    },
    minuteAt: (ms) => zonedParts(new Date(ms)).minute,
  });
}

/** The live answer: scan the grid, then apply the clamps. */
export function resolveTakeoverWindowNow(startedAt = Date.now()): TakeoverWindow {
  return resolveTakeoverWindow({ startedAt, nextChangeAt: nextGridChangeAt(startedAt) });
}
