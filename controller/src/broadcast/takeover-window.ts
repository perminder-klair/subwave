// "Until the schedule changes" — how a takeover's end instant is chosen (#1601).
// The stored shape is an ordinary ScheduleOverride with an absolute `expiresAt`;
// only the way that instant is chosen differs, and nothing downstream can tell.
//
// Three rules:
//  - The boundary is the GRID's. The scan hands `resolveActiveShow` a snapshot
//    with the override taken OUT rather than restating the lookup here, or a
//    takeover replacing a takeover would measure itself against itself.
//  - The scan walks the STATION clock minute by minute (slots sit at painted
//    hours, zones at :30/:45), reusing show-boundary.ts's `nextShowChangeMs`
//    with no `extra` candidates — a takeover's own start/expiry are excluded.
//  - There is a CEILING and NO FLOOR. A ceiling trims an otherwise valid window;
//    a floor cannot lengthen a genuinely short one, and applying
//    OVERRIDE_MIN_MINUTES here is what made "end at the change" run PAST the
//    change. The floor stays on `until: 'fixed'`, where it bounds what an
//    operator may type. Accepted trade: the switch lands at the next track
//    boundary, so a very short window may air late or lapse unaired.

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
 * The window a `until: 'schedule-change'` takeover starting at `startedAt` gets,
 * given the next grid change (null for none in reach). One-directional: the
 * returned `expiresAt` is never LATER than `nextChangeAt`.
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
  // Only reachable for a caller passing its own instant in — the scan's horizon
  // IS the ceiling. Its own source, because 'maximum' means the grid never moves
  // on, which is the wrong news when it does, just later.
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
 * within one maximum takeover window, or null. A live takeover is excluded: the
 * question is what the schedule would have done.
 */
export function nextGridChangeAt(fromMs: number, horizonMinutes = OVERRIDE_MAX_MINUTES): number | null {
  const gridOnly = { ...settings.get(), scheduleOverride: null };
  return nextShowChangeMs({
    fromMs,
    horizonMs: horizonMinutes * 60_000,
    // Same identity showKeyAt uses, so the two scans agree about boundaries;
    // coming off a show onto default programming is a change like any other.
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
