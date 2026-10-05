// Cue arithmetic for the two seams around a rendered stem-blend clip
// (broadcast/stem-blend.ts). Dependency-free on purpose: the render harness
// (scripts/stem-seam-test.sh) imports this arithmetic, so the audio check runs
// against the controller's own numbers.
//
// The clip airs as  X ──cross──▶ clip ──cross──▶ Y,  and the worker reports two
// sample-exact points: the clip's first sample continues X at `blendStartSec`,
// and its last sample reaches Y at `inCueSec`. A crossfade is not a butt
// splice. `cross` OVERLAPS the last `crossSec` of the outgoing item with the
// first `crossSec` of the incoming one, so each seam takes `crossSec` out of the
// timeline. Stamping the worker's points verbatim therefore:
//   * started the clip `crossSec` early: the listener heard X's bar shortened
//     by the overlap before the borrowed loop restarted it;
//   * summed Y's audio just BEFORE `inCueSec` (the clip's end) with Y's audio
//     just AFTER it (the real track's start): the same song twice, `crossSec`
//     apart, on a downbeat. That is the single stutter heard on stem blends.
// Each cue moves outward by the overlap so the two sides of every crossfade
// sit on the same instant of the music:
//   * X plays `crossSec` past the bar end and fades out under the clip, whose
//     first sample now lands exactly at X's `blendStartSec`;
//   * Y enters `crossSec` before `inCueSec`, so the overlap mixes the clip's
//     last stretch with the SAME stretch of the real track.

// Cross length at the two clip seams (X→clip, clip→Y): long enough to declick,
// short enough that the rendered mix, not the crossfader, is the transition.
// These cues require #1774's mixer buffer wiring at short station crossfades;
// see docs/stem-transitions-research.md, "Stem-seam validation".
export const CLIP_SEAM_CROSS_SEC = 0.3;

export interface ClipSeamCues {
  outCueSec: number; // X's liq_cue_out
  inCueSec: number;  // Y's liq_cue_in
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

export function clipSeamCues(
  render: { blendStartSec: number; inCueSec: number },
  crossSec: number = CLIP_SEAM_CROSS_SEC,
): ClipSeamCues {
  return {
    outCueSec: round3(render.blendStartSec + crossSec),
    inCueSec: round3(render.inCueSec - crossSec),
  };
}
