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
//  - There is a CEILING and there is NO FLOOR, and that asymmetry is the whole
//    point. It is the same asymmetry root CLAUDE.md draws between the
//    track-length cap and the track-length floor: a ceiling TRIMS a window that
//    is otherwise valid, so applying it costs nothing the operator asked for; a
//    floor cannot LENGTHEN a window that is genuinely short, so applying it
//    replaces the request with a different one. A grid that never changes
//    inside the horizon must still produce a bounded pin (schemas/schedule.ts:
//    the cap exists so a forgotten pin can't shadow the grid for days) — that
//    is the ceiling, and it stays. `OVERRIDE_MIN_MINUTES` used to be applied
//    here too, as its mirror image, and unifying the two is exactly what made
//    "end at the change" run PAST the change: a boundary five minutes out was
//    held to fifteen, so the pin shadowed the incoming show for ten minutes —
//    the one harm this option exists to remove, produced by the option itself.
//    `scheduleOverrideSchema` imposes no minimum (only `expiresAt > startedAt`
//    and the cap), so a five-minute pin is an ordinary stored override. The
//    floor stays on `until: 'fixed'`, where it is a bound on what an operator
//    may TYPE and belongs.
//
//    The trade that buys, stated rather than discovered: the switch lands at
//    the next track boundary, so a window shorter than the track now on air may
//    air the takeover late — or lapse having aired nothing at all, costing a
//    session roll each way. That is accepted. A pin asked to end at the change
//    ending early is a disappointment; one that runs past the change is the bug.
//
// The pure resolution and the impure scan are split so scripts/takeover-window.test.ts
// can drive the ceiling and the boundary cases without standing a schedule up.

import { OVERRIDE_MAX_MINUTES } from '../schemas/schedule.js';
import { zonedParts } from '../time.js';
import * as settings from '../settings.js';
import { nextShowChangeMs } from './show-boundary.js';

/** Which rule decided the end instant — the reason the dialog shows and the
 *  booth log prints, so an operator is never told a time without its why. */
export type TakeoverWindowSource =
  /** The grid's own next change, however near it is. */
  | 'schedule'
  /** No change within reach — held to the longest pin the station allows. */
  | 'maximum'
  /** A change was supplied but sits past the longest pin the station allows, so
   *  the window was trimmed to it. Distinct from 'maximum' because the two are
   *  opposite news — "the grid never moves on" versus "it moves on, later than
   *  a takeover can run" — and one reason string cannot say both. */
  | 'ceiling';

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
 * Pure, and one-directional: the returned `expiresAt` is never LATER than
 * `nextChangeAt`. Only the ceiling can move it, and only earlier. A resolved
 * window is therefore always one `scheduleOverrideSchema` would accept — it
 * enforces `expiresAt > startedAt` (the scan yields instants strictly after
 * `startedAt`) and the cap, and no minimum at all.
 */
export function resolveTakeoverWindow(input: {
  startedAt: number;
  nextChangeAt: number | null;
}): TakeoverWindow {
  const { startedAt } = input;
  const ceiling = startedAt + OVERRIDE_MAX_MINUTES * 60_000;
  const at = Number.isFinite(input.nextChangeAt) ? (input.nextChangeAt as number) : null;

  let expiresAt = at ?? ceiling;
  let source: TakeoverWindowSource = at == null ? 'maximum' : 'schedule';
  // `resolveTakeoverWindowNow` cannot reach this: the scan's horizon IS the
  // ceiling and its candidates are inclusive of it. It is a guard on a caller
  // passing its own instant in, which is why it gets its own source rather than
  // borrowing 'maximum' — that one means the grid never moves on, and telling
  // an operator so when it does, just later, is the wrong news.
  if (expiresAt > ceiling) {
    expiresAt = ceiling;
    source = 'ceiling';
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
