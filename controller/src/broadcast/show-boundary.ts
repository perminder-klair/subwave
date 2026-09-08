// Show-boundary fade policy (#1574): whether an autonomous pick that would run
// past the next show change is cut there, and where. The cut rides the existing
// #447 `liq_cue_out` stamp (earliest-wins in subsonic.getAnnotatedUri) — never a
// second cue writer, since the cap, the silence trim and a stem blend all cut the
// same tail. The scan takes `minuteAt`/`keyAt` so it stays pure; the impure
// wrappers are at the bottom.

import { zonedParts } from '../time.js';
import { absoluteOffsetSec } from '../music/silence-trim.js';
import * as settings from '../settings.js';

// How far past its show's end a track may run before the cut is armed. Not an
// operator dial: the switch means "don't spill", not "cut on the dot".
export const BOUNDARY_TOLERANCE_SEC = 60;

// A boundary landing inside this window leaves the track alone: a shorter cut
// makes the closing track a stub, which is worse than the overrun.
export const BOUNDARY_MIN_PLAY_SEC = 90;

// Ceiling on the forward scan. A track's own playable span is the real horizon;
// this only bounds the work when something upstream reports a nonsense length.
export const BOUNDARY_MAX_HORIZON_SEC = 6 * 3600;

const MINUTE_MS = 60_000;

/** Station-zone hour boundaries in `(fromMs, toMs]`, ascending. Scanned minute by
 *  minute, not by adding an hour: zones sit at :30/:45 offsets and a DST step is
 *  not always a whole hour, so +1h is not reliably the next station hour (#353). */
export function stationHourBoundaries(
  fromMs: number,
  toMs: number,
  minuteAt: (ms: number) => number,
): number[] {
  const out: number[] = [];
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return out;
  // Minute-aligned and strictly after `fromMs`: a boundary at the start instant
  // has already passed.
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
 * `extra` carries instants a grid scan cannot see — a timed takeover's start and
 * expiry (#930), not hour-aligned — merged into the same ascending sweep.
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

/** An armed boundary cut. The overshoot rides along so the drain's booth-log line
 *  does not re-derive it from the cue. */
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
 * The offset is ABSOLUTE (the shape `liq_cue_out` carries), so a head-trimmed
 * track's cut is measured from byte zero; the played-to-absolute shift belongs to
 * `music/silence-trim.ts`. `startMs` is the pick's EXPECTED air time, never "now"
 * — the drain's own clock would cut by however long the pick waits in dj_queue.
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

  // Absolute, so the head trim is added back on: playback starts at cueIn.
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

/** Show identity for the scan. No show on air is itself an identity: coming off a
 *  show onto default programming is a boundary like any other. */
export function showKeyAt(ms: number): string {
  const show = settings.resolveActiveShow(new Date(ms));
  return show?.id ? `show:${show.id}` : 'default';
}

/** Per-show `fadeAtShowEnd` (null = inherit) over the station default; absent at
 *  both levels reads as off, so an upgrade is byte-identical. */
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
