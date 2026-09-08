// Show handover policy: when the outgoing host signs off, and what has to happen
// before the incoming one opens (#1576).
//
// Timing is a dial (`handover.offsetMinutes`, default 5). It must stay a
// multiple of the talk table's sampling stride: the outro is a station-clock
// window sampled once on a fixed process stride, so a window narrower than the
// stride — or opening off it — is never sampled and the show silently stops
// signing off.
//
// Ordering is not a dial: one closing track always separates the sign-off from
// the incoming host.

import * as settings from '../settings.js';
import {
  HANDOVER_OFFSET_BOUNDS,
  HANDOVER_OFFSET_STEP_MINUTES,
} from '../schemas/settings.js';
import { normalizeHandoverOffsetMinutes } from '../settings/normalize.js';
import { DEFAULTS } from '../settings/defaults.js';

// Minutes before the show boundary the sign-off airs, read live. Re-normalised
// on the way out (same function the load path calls) because `get()` is also
// served from a profile switch and a backup restore, and an offset the talk row
// cannot sample costs the show its sign-off with nothing logged.
export function handoverOffsetMinutes(): number {
  return normalizeHandoverOffsetMinutes(
    settings.get()?.handover?.offsetMinutes,
    DEFAULTS.handover.offsetMinutes,
  );
}

// What the incoming host waits for, counted from when the sign-off AIRED. BOTH
// counters are required — a boundary count alone releases too early on eager
// drains (which ask at track start), an opportunity count alone releases too
// early on pair-aware drains (which ask ~120s before the end of the track the
// sign-off ducked). Together they mean one whole track played between the two
// voices.
//
// Only a drain/boundary cycle that could itself have aired the greeting may bank
// a decline; the wall-clock :00 session roll may not. Hence the queue splits the
// pure question (`closingTrackHolds`) from the answer
// (`noteHandoverOpportunityDeclined`).
export const HANDOVER_MIN_BOUNDARIES = 1;
export const HANDOVER_MIN_HELD = 1;

export type HandoverProgress = {
  // Track starts observed since the sign-off aired.
  boundariesSince: number;
  // Handover opportunities already declined by this rule.
  heldOpportunities: number;
};

// `null` means no sign-off has aired, and must cost nothing. Nothing bounds the
// wait here on purpose: the mic-pass's own 20-minute staleness and a pending
// intro's gates already bound it.
export function holdsForClosingTrack(progress: HandoverProgress | null): boolean {
  if (!progress) return false;
  return progress.boundariesSince < HANDOVER_MIN_BOUNDARIES
    || progress.heldOpportunities < HANDOVER_MIN_HELD;
}

// Snapshot for the admin /debug surface.
export function handoverStatus() {
  return {
    offsetMinutes: handoverOffsetMinutes(),
    offsetBounds: { ...HANDOVER_OFFSET_BOUNDS, step: HANDOVER_OFFSET_STEP_MINUTES },
    closingTrack: { boundaries: HANDOVER_MIN_BOUNDARIES, held: HANDOVER_MIN_HELD },
  };
}
