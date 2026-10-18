// Crossfades overlap both clip seams. Move X's cue out and Y's cue in by crossSec so each
// overlap mixes the same musical instant. Short seam crosses require the #1774 mixer buffer
// wiring. `cross` buffers whole frames, so its overlap can fall a frame short of crossSec;
// X and the clip therefore also carry crossSec as `liq_clip_lead`, and radio.liq buffers
// past it and starts the incoming side exactly crossSec before the outgoing one ends.
// scripts/stem-seam-test.sh, #1774, docs/stem-transitions-research.md.
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
