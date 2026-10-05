// Pins the cue arithmetic around a rendered stem-blend clip
// (broadcast/stem-seam.ts).
//
// The clip airs as X ──cross──▶ clip ──cross──▶ Y, and `cross` OVERLAPS the
// two sides of each seam. The worker reports where the clip's first sample
// continues X (`blendStartSec`) and where its last sample reaches Y
// (`inCueSec`). Stamped verbatim, both seams lost the overlap: the clip's
// borrowed loop restarted 0.3s early, and Y's opening summed with its own
// audio from 0.3s earlier — the single stutter heard on stem blends.
//
// The tests model the timeline the way `cross` builds it (each item starts
// `crossSec` before the previous one's cue-out) and check that every crossfade
// mixes the same instant of the music on both sides. The audio-level twin is
// `scripts/stem-seam-test.sh` (real Liquidsoap, measured onsets).
// Run: `tsx scripts/stem-seam-cues.test.ts` (folded into `npm test`).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLIP_SEAM_CROSS_SEC, clipSeamCues } from '../src/broadcast/stem-seam.js';
import * as stemBlend from '../src/broadcast/stem-blend.js';

const close = (a: number, b: number, msg: string) =>
  assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);

// Timeline of X (cued out at outCue) → clip (clipSec long) → Y (cued in at
// inCue), with every seam overlapping by `cross`. Output time 0 = X's file
// time 0. Returns where each item starts on the output timeline.
function timeline(outCue: number, clipSec: number, cross: number) {
  const clipStart = outCue - cross;               // overlap X's last `cross`
  const yStart = clipStart + clipSec - cross;     // overlap the clip's last `cross`
  return { clipStart, yStart };
}

test('the stamped cues sit one seam overlap outside the clip edges', () => {
  const cues = clipSeamCues({ blendStartSec: 214.5, inCueSec: 12.0 });
  close(cues.outCueSec, 214.5 + CLIP_SEAM_CROSS_SEC, 'X cue-out');
  close(cues.inCueSec, 12.0 - CLIP_SEAM_CROSS_SEC, 'Y cue-in');
});

test('X → clip: the clip starts exactly where it continues X', () => {
  const render = { blendStartSec: 214.5, inCueSec: 12.0 };
  const clipSec = 12.0;
  const cues = clipSeamCues(render);
  const t = timeline(cues.outCueSec, clipSec, CLIP_SEAM_CROSS_SEC);
  // X's file time maps 1:1 to output time, so the clip's first sample must
  // land at output time == X's blendStartSec for the groove to continue.
  close(t.clipStart, render.blendStartSec, 'clip start vs X bar end');
});

test('clip → Y: both sides of the overlap are the same instant of Y', () => {
  const render = { blendStartSec: 214.5, inCueSec: 12.0 };
  const clipSec = 12.0; // the clip spans Y's 0 … inCueSec
  const cues = clipSeamCues(render);
  const t = timeline(cues.outCueSec, clipSec, CLIP_SEAM_CROSS_SEC);
  // Inside the overlap, the clip plays Y-time (out − clipStart) and the real
  // track plays Y-time (out − yStart + inCue). They must agree everywhere.
  for (const k of [0, 0.1, 0.2, CLIP_SEAM_CROSS_SEC]) {
    const out = t.yStart + k;
    const clipYTime = out - t.clipStart;
    const realYTime = out - t.yStart + cues.inCueSec;
    close(clipYTime, realYTime, `Y-time ${k}s into the overlap`);
  }
});

test('the verbatim (pre-fix) cues lose the overlap at both seams', () => {
  // The regression shape, stated so a revert to verbatim stamping fails here.
  const render = { blendStartSec: 214.5, inCueSec: 12.0 };
  const t = timeline(render.blendStartSec, 12.0, CLIP_SEAM_CROSS_SEC);
  close(render.blendStartSec - t.clipStart, CLIP_SEAM_CROSS_SEC, 'clip early by the overlap');
  const clipYTime = t.yStart - t.clipStart;  // what the clip plays as Y starts
  close(render.inCueSec - clipYTime, CLIP_SEAM_CROSS_SEC, 'Y jumps by the overlap');
  const fixed = clipSeamCues(render);
  assert.notEqual(fixed.outCueSec, render.blendStartSec);
  assert.notEqual(fixed.inCueSec, render.inCueSec);
});

test('stem-blend re-exports the same seam length its clip URI is stamped with', () => {
  assert.equal(stemBlend.CLIP_SEAM_CROSS_SEC, CLIP_SEAM_CROSS_SEC);
});
