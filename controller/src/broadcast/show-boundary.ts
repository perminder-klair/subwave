// Show-boundary fade policy (#1574) — whether an autonomous pick that would
// run past the next show change is cut short at that change, and where.
//
// The failure it fixes: a show built on 20–30 minute material (ambient,
// classical, prog) picks one last track a few minutes before its slot ends, and
// that track is still playing well into the next show. The incoming presenter's
// opening link then airs over the outgoing show's music, which is the one thing
// a schedule grid is supposed to make impossible.
//
// The cut itself is NOT a new mechanism: it is the #447 `liq_cue_out` stamp the
// drain already writes for the hard length cap, arbitrated by the same
// "earliest wins" rule in subsonic.getAnnotatedUri. Adding a second cue writer
// was the obvious fix and the wrong one — the cap, the silence trim and a stem
// blend all cut the same track's tail, and they only stay consistent because
// one call site folds them together.
//
// Everything here is pure: the boundary scan takes a `minuteAt` and a `keyAt`
// rather than reaching for the station clock or the settings cache, so
// scripts/show-boundary.test.ts can drive a whole schedule grid without booting
// anything. The impure wrappers live at the bottom and are two lines each.

import { zonedParts } from '../time.js';
import { absoluteOffsetSec } from '../music/silence-trim.js';
import * as settings from '../settings.js';

// How far past its show's end a track may run before the cut is armed. Below
// this a cut buys nothing a listener would notice and costs a real ending: the
// incoming show's first link is written when its first track is PICKED, so a
// minute of overhang is absorbed by the pick/render latency that follows the
// boundary anyway. Not an operator dial — the switch is the operator's choice,
// the number is what makes the switch mean "don't spill", not "cut on the dot".
export const BOUNDARY_TOLERANCE_SEC = 60;

// A cut this short is worse than the overrun it prevents: the show's closing
// track becomes a stub, and a listener hears a record start and stop. When the
// boundary lands inside this window the track is left to run over — the pick
// should not have been made that late, and mutilating it does not fix that.
export const BOUNDARY_MIN_PLAY_SEC = 90;

// Ceiling on the forward scan. A track's own playable span is the real horizon;
// this only bounds the work when something upstream reports a nonsense length.
export const BOUNDARY_MAX_HORIZON_SEC = 6 * 3600;

const MINUTE_MS = 60_000;

/**
 * Station-zone hour boundaries in `(fromMs, toMs]`, ascending.
 *
 * Scanned minute by minute rather than derived by adding 3 600 000 ms: station
 * zones sit at :30 and :45 offsets (IST, Nepal), and a DST step is not always a
 * whole hour, so "the same instant plus an hour" is not reliably the next hour
 * on the station's own clock — which is the clock the schedule grid is painted
 * on (#353). The scan is bounded by the horizon, so it is at most a few hundred
 * cheap formatter reads per drained item.
 */
export function stationHourBoundaries(
  fromMs: number,
  toMs: number,
  minuteAt: (ms: number) => number,
): number[] {
  const out: number[] = [];
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return out;
  // Minute-aligned and strictly after `fromMs`: every zone offset in use is a
  // whole number of minutes, so an hour boundary can only land on one, and a
  // boundary at the start instant itself has already passed.
  let t = Math.floor(fromMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (; t <= toMs; t += MINUTE_MS) {
    if (minuteAt(t) === 0) out.push(t);
  }
  return out;
}

/**
 * The first instant in `(fromMs, fromMs + horizonMs]` at which the show on air
 * is no longer the one on air at `fromMs`, or null if it never changes inside
 * the horizon.
 *
 * `extra` carries the instants a grid scan cannot see — a timed takeover's
 * start and expiry (#930), which are not hour-aligned. They are merged into the
 * same ascending sweep rather than special-cased, so a takeover that begins
 * mid-hour and a grid change an hour later are judged by one rule.
 */
export function nextShowChangeMs(input: {
  fromMs: number;
  horizonMs: number;
  keyAt: (ms: number) => string;
  minuteAt: (ms: number) => number;
  extra?: number[];
}): number | null {
  const { fromMs, horizonMs, keyAt, minuteAt } = input;
  if (!Number.isFinite(fromMs) || !(horizonMs > 0)) return null;
  const toMs = fromMs + horizonMs;
  const candidates = stationHourBoundaries(fromMs, toMs, minuteAt);
  for (const ms of input.extra ?? []) {
    if (Number.isFinite(ms) && ms > fromMs && ms <= toMs) candidates.push(ms);
  }
  candidates.sort((a, b) => a - b);
  const base = keyAt(fromMs);
  for (const ms of candidates) {
    if (keyAt(ms) !== base) return ms;
  }
  return null;
}

/** An armed boundary cut: where to stop, and how much spill it prevents. The
 *  overshoot rides along because the drain's booth-log line wants it and a
 *  caller re-deriving it from the cue is a second copy of this rule. */
export interface BoundaryCut {
  /** ABSOLUTE offset in the file, the shape `liq_cue_out` carries. */
  cueOutSec: number;
  /** Seconds this track would otherwise have run into the next show. */
  overshootSec: number;
}

/**
 * Where to cue this track out so it ends at the show boundary, or null to leave
 * it alone.
 *
 * The returned offset is ABSOLUTE, the same shape `liq_cue_out` already carries
 * — so a head-trimmed track's cut is measured from byte zero, not from where
 * playback starts, and the played-to-absolute shift is `music/silence-trim.ts`'s
 * to own rather than a local addition here. `startMs` is the pick's EXPECTED
 * air time, never "now": a link is written when the pick is made and airs when
 * the pick starts (the forecast rule in broadcast/queue/pure.ts), and a boundary
 * computed from the drain's own clock would cut a track that has not started yet
 * by however long it waits in dj_queue — or behind a bed.
 */
export function resolveBoundaryCueSec(input: {
  startMs: number;
  cueInSec: number;
  playableSec: number;
  boundaryMs: number | null;
  toleranceSec?: number;
  minPlaySec?: number;
}): BoundaryCut | null {
  const { startMs, boundaryMs } = input;
  const tolerance = input.toleranceSec ?? BOUNDARY_TOLERANCE_SEC;
  const minPlay = input.minPlaySec ?? BOUNDARY_MIN_PLAY_SEC;
  if (boundaryMs == null || !Number.isFinite(boundaryMs)) return null;
  if (!Number.isFinite(startMs)) return null;
  const playable = input.playableSec;
  if (!Number.isFinite(playable) || playable <= 0) return null;

  // Seconds of this track that would air on the far side of the boundary.
  const overshootSec = (startMs + playable * 1000 - boundaryMs) / 1000;
  if (overshootSec <= tolerance) return null;

  // Where the boundary falls inside the track. Absolute, so the head trim is
  // added back on — playback starts at cueIn, not at zero.
  const playedSec = (boundaryMs - startMs) / 1000;
  if (playedSec < minPlay) return null;
  const cueOut = absoluteOffsetSec(input.cueInSec, playedSec);
  // A cut at or before the head is not a cut, it is an empty track.
  if (!(cueOut > absoluteOffsetSec(input.cueInSec, 0))) return null;
  return {
    cueOutSec: Math.round(cueOut * 100) / 100,
    overshootSec: Math.round(overshootSec * 100) / 100,
  };
}

// ── impure wrappers ─────────────────────────────────────────────────────────

/** Show identity for the scan. No show on air is itself an identity — coming
 *  off a show onto default programming is a boundary like any other. */
export function showKeyAt(ms: number): string {
  const show = settings.resolveActiveShow(new Date(ms));
  return show?.id ? `show:${show.id}` : 'default';
}

/**
 * Whether the show ending at `date` wants its last track faded at the boundary.
 * Per-show `fadeAtShowEnd` (null = inherit) over the station default, the same
 * precedence shape as `effectiveMaxTrackSec` — and absent at both levels reads
 * as off, so an upgrade is byte-identical.
 */
export function fadeAtShowEndActive(date = new Date()): boolean {
  return settings.effectiveFadeAtShowEnd(settings.resolveActiveShow(date));
}

/** The next show change at or after `fromMs`, within `horizonSec`. */
export function nextShowBoundaryMs(fromMs: number, horizonSec: number): number | null {
  const horizon = Math.min(Math.max(0, horizonSec), BOUNDARY_MAX_HORIZON_SEC);
  if (!(horizon > 0)) return null;
  const ov = settings.get()?.scheduleOverride;
  return nextShowChangeMs({
    fromMs,
    horizonMs: horizon * 1000,
    keyAt: showKeyAt,
    minuteAt: (ms) => zonedParts(new Date(ms)).minute,
    extra: ov ? [Number(ov.startedAt), Number(ov.expiresAt)] : [],
  });
}
