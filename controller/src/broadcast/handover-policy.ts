// Programme-outro timing policy. Persona handoffs are instead armed against
// the final outgoing track (session.ts) so music selection can look ahead
// without moving the on-air identity early.
//
// `handover.offsetMinutes` remains the dial for a programme episode's own
// outro beat. It is constrained to the programme scheduler stride so a saved
// value can never silently move that beat to an unsampled minute.

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

// Snapshot for the admin /debug surface, beside talkAirStatus()/clockStatus().
export function handoverStatus() {
  return {
    offsetMinutes: handoverOffsetMinutes(),
    offsetBounds: { ...HANDOVER_OFFSET_BOUNDS, step: HANDOVER_OFFSET_STEP_MINUTES },
  };
}
