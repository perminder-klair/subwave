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
// Run: `npm test -- stem-seam-cues`.

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

test('the clip and its outgoing track carry the cue lead radio.liq aligns on', async () => {
  // `cross` buffers whole frames, so the overlap it builds can fall a frame
  // short of the stamp. radio.liq buffers past `liq_clip_lead` and starts the
  // incoming side exactly that far before the outgoing one ends, which only
  // works if the lead it reads is the one the cues above were computed with.
  const { getAnnotatedUri, getClipUri } = await import('../src/music/subsonic.js');
  const song = { id: 'y', title: 'Y', artist: 'A', album: 'B', path: 'y.flac', crossSec: CLIP_SEAM_CROSS_SEC };
  const lead = `liq_clip_lead="${CLIP_SEAM_CROSS_SEC}"`;
  assert.ok(getClipUri(song, '/tmp/clip.wav', CLIP_SEAM_CROSS_SEC).includes(lead), 'clip');
  assert.ok(getAnnotatedUri(song, { cueOutSec: 200, clipLeadSec: CLIP_SEAM_CROSS_SEC }).includes(lead), 'outgoing');
  assert.ok(!getAnnotatedUri(song, { cueOutSec: 200 }).includes('liq_clip_lead'), 'an ordinary track carries none');
});

// CUE-IN LANDING (#2003): Liquidsoap 2.4.x starts Y on the first codec frame
// at or after its liq_cue_in, so the controller stamps how late
// (`liq_clip_cue_late`) and the mixer delays Y by it at clip → Y only. An MP3
// lands early by its encoder delay, stamped negative (#2077).

test('Y carries its probed cue-in landing at six decimals, not rounded to ms', async () => {
  const { getAnnotatedUri } = await import('../src/music/subsonic.js');
  const song = { id: 'y', title: 'Y', artist: 'A', album: 'B', path: 'y.flac', crossSec: 10 };
  // 126 samples at 44.1 kHz: ms rounding would stamp 0.003 (6 samples off).
  const uri = getAnnotatedUri(song, { cueInSec: 11.7, clipCueLateSec: 126 / 44100 });
  assert.ok(uri.includes('liq_clip_cue_late="0.002857"'), uri);
  assert.ok(uri.includes('liq_cue_in="11.7"'), uri);
});

test('an early landing (an MP3 with a LAME header) is stamped negative', async () => {
  const { getAnnotatedUri } = await import('../src/music/subsonic.js');
  const song = { id: 'y', title: 'Y', artist: 'A', album: 'B', path: 'y.mp3', crossSec: 10 };
  // 979 samples early: the measured CBR 320 clip → Y offset at cue 11.7 s.
  const uri = getAnnotatedUri(song, { cueInSec: 11.7, clipCueLateSec: -979 / 44100 });
  assert.ok(uri.includes('liq_clip_cue_late="-0.022200"'), uri);
});

test('no landing stamp without a probe, or outside the bound the mixer accepts', async () => {
  const { getAnnotatedUri } = await import('../src/music/subsonic.js');
  const { CUE_EARLY_MAX_SEC } = await import('../src/music/cue-landing.js');
  const song = { id: 'y', title: 'Y', artist: 'A', album: 'B', path: 'y.flac', crossSec: 10 };
  const plain = getAnnotatedUri(song, { cueInSec: 11.7 });
  assert.ok(!plain.includes('liq_clip_cue_late'), plain);
  for (const v of [null, 0, -CUE_EARLY_MAX_SEC, -0.2, 0.15, 0.4, Number.NaN]) {
    assert.ok(!getAnnotatedUri(song, { cueInSec: 11.7, clipCueLateSec: v }).includes('liq_clip_cue_late'), String(v));
  }
  // Identical to an URI built before the option existed (the stream URL's
  // auth salt is fresh per call, so compare up to the query).
  const noAuth = (u: string) => u.replace(/\?.*$/, '');
  assert.equal(noAuth(getAnnotatedUri(song, { cueInSec: 11.7, clipCueLateSec: null })), noAuth(plain));
});

test('radio.liq reads the landing only when the outgoing side is the clip, bounded by the lead', async () => {
  const { readFileSync } = await import('node:fs');
  const radio = readFileSync(new URL('../../liquidsoap/radio.liq', import.meta.url), 'utf8');
  const subsonicSrc = readFileSync(new URL('../src/music/subsonic.ts', import.meta.url), 'utf8');
  assert.ok(subsonicSrc.includes('liq_clip_cue_late='), 'the writer emits the key radio.liq reads');
  const reads = radio.match(/\w+\.metadata\["liq_clip_cue_late"\]/g) ?? [];
  assert.deepEqual(reads, ['b.metadata["liq_clip_cue_late"]'], 'read once, off the incoming side');
  const gate = /cue_late =\s*\n\s*if a\.metadata\["subwave_clip"\] == "1" then\s*\n\s*float_of_string\(default=0\., b\.metadata\["liq_clip_cue_late"\]\)\s*\n\s*else 0\. end/;
  assert.match(radio, gate, 'X → clip (incoming clip) never reads it');
  assert.match(radio, /cue_late > 0\. - cue_early_max and cue_late < min\(clip_lead, 0\.15\) then\s*\n\s*clip_lead - cue_late/,
    'bounded by the slack below and by the clip lead and 0.15 s above');
  assert.match(radio, /cue_early_max = clip_seam_slack - frame\.duration\(\)/, 'an early Y fits in the slack less a frame');
  // The writer's early bound sits inside the reader's: 2.4.6 runs 20 ms frames.
  const { CUE_EARLY_MAX_SEC } = await import('../src/music/cue-landing.js');
  const slack = Number(/^clip_seam_slack = ([0-9.]+)$/m.exec(radio)?.[1]);
  assert.ok(CUE_EARLY_MAX_SEC <= slack - 0.02, `${CUE_EARLY_MAX_SEC} vs slack ${slack}`);
  assert.match(radio, /d > seam_lead and d <= clip_max_d then d - seam_lead/, 'Y waits the landing longer');
  assert.match(radio, /clip_max_d = clip_lead \+ clip_seam_slack \+ frame\.duration\(\)/, 'buffer bound unchanged');
});

test('radio.liq no longer calls the removed cue_cut', async () => {
  const { readFileSync } = await import('node:fs');
  const radio = readFileSync(new URL('../../liquidsoap/radio.liq', import.meta.url), 'utf8');
  const code = radio.split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
  assert.ok(!/cue_cut\(/.test(code), 'cue_cut is a deprecated no-op on 2.4.x; cues apply at request resolution');
});
