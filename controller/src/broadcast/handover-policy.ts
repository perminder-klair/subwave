// Show handover policy — WHEN the outgoing host signs off, and what has to
// happen before the incoming one opens (#1576).
//
// A show changeover is two spoken moments with a boundary between them: the
// programme outro (the sign-off, a station-clock beat in the final hour) and
// the incoming host's first words (the persona mic-pass, or the standalone
// programme intro when the persona did not change). Both were placed by
// accident rather than by design — the outro at a hardcoded :55, the intro at
// whatever the next pick cycle happened to be — so on a station whose tracks
// run short the two landed seconds apart: two voices back to back, and five
// minutes in which the outgoing host had already said goodbye and had nothing
// left to do.
//
// The two halves are separate rules with separate homes, and neither belongs at
// a call site:
//
//   - TIMING is a dial. `handover.offsetMinutes` moves the outro window earlier
//     in the final hour; 5 is where the beat has always fired, so an upgrade is
//     byte-identical. The value is constrained to the talk table's sampling
//     stride at the save path (schemas/settings.ts) and repaired at load, for a
//     reason worth restating here: the outro is a STATION-clock window that the
//     talk table's programme row samples on a fixed PROCESS stride, so a window
//     narrower than that stride — or opening off it — is one the row never
//     lands inside, and the failure is silent. A show simply stops signing off.
//
//   - ORDERING is not a dial. Whatever the offset, one closing track separates
//     the sign-off from the incoming host. Making it configurable would only
//     offer operators the arrangement the issue was raised about.
//
// Pure and settings-free below the read, so scripts/handover-timing.test.ts can
// walk both drain modes without a queue or a station.

import * as settings from '../settings.js';
import {
  HANDOVER_OFFSET_BOUNDS,
  HANDOVER_OFFSET_STEP_MINUTES,
} from '../schemas/settings.js';
import { normalizeHandoverOffsetMinutes } from '../settings/normalize.js';
import { DEFAULTS } from '../settings/defaults.js';

// Minutes before the show boundary the sign-off airs, read live (a change
// applies at the next programme tick — nothing is handed to the mixer).
//
// Re-normalised on the way out rather than trusted: settings.load() repairs the
// stored value, but `get()` is also served from a station profile switch and a
// backup restore, and an offset the talk row cannot sample costs the show its
// sign-off with nothing logged. The repair rule itself is not restated — it is
// the same function the load path calls.
export function handoverOffsetMinutes(): number {
  return normalizeHandoverOffsetMinutes(
    settings.get()?.handover?.offsetMinutes,
    DEFAULTS.handover.offsetMinutes,
  );
}

// ---------------------------------------------------------------------------
// THE ORDERING RULE
// ---------------------------------------------------------------------------

// What the incoming host's first words have to wait for, counted from the
// moment the sign-off AIRED.
//
// The obvious rule — "wait for the next track boundary" — is wrong in both
// drain modes, in opposite directions, because the two put the handover
// question at different points in a track:
//
//   - Eager drains ask at the track START. The next boundary is where the
//     closing track BEGINS, so airing there puts the incoming host straight on
//     the back of the sign-off with no music in between at all.
//   - Pair-aware drains (transitions.pairDrain, DJ-mode personas) ask from the
//     deadline routine, ~120s before the on-air track ends — which, right after
//     a sign-off, is still the track the sign-off ducked. No boundary has
//     passed yet, so a boundary count alone would hold correctly here and
//     release too early there.
//
// So both are required, and together they mean the same thing in either mode:
// one whole track of music has played between the two voices.
//
//   `boundariesSince` — track starts since the sign-off aired. At least one, so
//     the track the sign-off played over has finished.
//   `heldOpportunities` — handover asks already declined. At least one, so the
//     first ask (whenever in the track it fell) was spent on the closing track
//     rather than on the sign-off's own.
//
// Which makes WHO MAY COUNT part of the rule rather than a detail of the
// caller. An opportunity is a drain/boundary cycle that could itself have
// carried the incoming host's first words; the wall-clock :00 session roll
// reaches the same question and is not one. Banking its answer would satisfy
// the second counter inside the track the sign-off ducked, so the next boundary
// meets both and the incoming host opens as the closing track begins — the
// eager-drain row of the table above, restored through the other counter. The
// queue therefore splits the question (`closingTrackHolds`, pure and free to
// ask) from the answer (`noteHandoverOpportunityDeclined`, for opportunities
// only), and each call site states which it is.
//
// A pair-drained station therefore hears the incoming host over the closing
// track's outro, into the transition — the mic-pass's existing spot — and an
// eagerly-drained one hears them at the boundary that ends it. Both are "one
// closing track later"; neither is a stacked pair of voices.
export const HANDOVER_MIN_BOUNDARIES = 1;
export const HANDOVER_MIN_HELD = 1;

export type HandoverProgress = {
  // Track starts observed since the sign-off aired.
  boundariesSince: number;
  // Handover opportunities already declined by this rule.
  heldOpportunities: number;
};

// Whether the incoming host must wait. `null` is "no sign-off has aired" — the
// overwhelmingly common case (every boundary with no programme outro behind it)
// and the one that must cost nothing: a persona changeover with no sign-off is
// a mic-pass, which is a designed two-voice moment and is not what this rule is
// about.
//
// Nothing here bounds the wait, on purpose. The mic-pass already expires
// (HANDOFF_MAX_AGE_MS, 20 minutes) and a pending programme intro already
// survives its own gates until it can air; a second timeout here would be a
// third rule about the same wait, and the release condition is one track away
// by construction.
export function holdsForClosingTrack(progress: HandoverProgress | null): boolean {
  if (!progress) return false;
  return progress.boundariesSince < HANDOVER_MIN_BOUNDARIES
    || progress.heldOpportunities < HANDOVER_MIN_HELD;
}

// Snapshot for the admin /debug surface, beside talkAirStatus()/clockStatus().
export function handoverStatus() {
  return {
    offsetMinutes: handoverOffsetMinutes(),
    offsetBounds: { ...HANDOVER_OFFSET_BOUNDS, step: HANDOVER_OFFSET_STEP_MINUTES },
    closingTrack: { boundaries: HANDOVER_MIN_BOUNDARIES, held: HANDOVER_MIN_HELD },
  };
}
