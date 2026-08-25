// music/silence-trim.ts — the dead-air trim policy: which measured edge gaps
// become liq_cue_in / liq_cue_out, and how a trimmed head shifts every onset
// the analyzer measured from byte zero.
//
// Two things are pinned here that a formula-shaped test would miss:
//
//  1. A COLD-LOAD round trip on `settings.silenceTrim`. load()'s composition is
//     explicit and does not spread DEFAULTS, so a new key that update() happily
//     writes to settings.json vanishes on the next restart with nothing in the
//     logs (#1317, #1327). An in-process assertion passes on that bug.
//  2. The three guards' DIRECTIONS. Every one of them is a "cut less than the
//     measurement said" rule, and each fails silently in the expensive
//     direction — a min-gap that stops filtering eats a segued album's
//     deliberate space, a lost margin cuts the attack, a lost ceiling lets one
//     bad measurement halve a song.
//
// No audio, no library DB: tracks carry their own measurements so the library
// fallback is never reached HERE. That fallback is the path every real caller
// actually takes, and it has its own file — scripts/silence-trim-library.test.ts.
// Keep the split: this file is the arithmetic, that one is the plumbing, and a
// break in the plumbing is invisible to every assertion below.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-silence-trim-'));
process.env.STATE_DIR = stateRoot;

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { resolveSilenceTrim, shiftOnsetMs } = await import('../src/music/silence-trim.js');

const SETTINGS_PATH = path.join(stateRoot, 'settings.json');

// Load a hand-written settings.json the way a controller restart would.
async function coldLoad(silenceTrim: Record<string, unknown> | undefined) {
  writeFileSync(SETTINGS_PATH, JSON.stringify(silenceTrim === undefined ? {} : { silenceTrim }));
  setCache(null);
  await settings.load();
}

// A 200s track with a 6s leading blank and a 9s trailing one. `tailStartMs`
// is where that trailing gap opens, absolute: 200s - 9s.
const GAPPY = {
  duration: 200,
  leadSilenceMs: 6_000,
  tailSilenceMs: 9_000,
  tailStartMs: 191_000,
};

test('the operator dial survives a cold load', async () => {
  await coldLoad({ enabled: true, minGapMs: 4_000 });
  assert.equal(settings.get().silenceTrim.enabled, true);
  assert.equal(settings.get().silenceTrim.minGapMs, 4_000);
});

test('absent settings coerce to today: nothing trimmed', async () => {
  await coldLoad(undefined);
  assert.deepEqual(resolveSilenceTrim(GAPPY), { cueInSec: null, cueOutSec: null });
  // …and a malformed block reads as absent rather than as "enabled".
  await coldLoad({ enabled: 'yes please', minGapMs: 'soon' } as Record<string, unknown>);
  assert.deepEqual(resolveSilenceTrim(GAPPY), { cueInSec: null, cueOutSec: null });
});

test('an out-of-range cold-load threshold cannot weaken the safety floor', async () => {
  await coldLoad({ enabled: true, minGapMs: -1 });
  assert.equal(settings.get().silenceTrim.minGapMs, 1_500);
  // A finite-but-invalid hand edit must not make an ordinary sub-second lead
  // eligible for trimming; cold-load normalization is the safety boundary.
  assert.equal(resolveSilenceTrim({ duration: 200, leadSilenceMs: 900 }).cueInSec, null);
});

test('a measured gap becomes a cue point, margin kept', async () => {
  await coldLoad({ enabled: true, minGapMs: 1_500 });
  const t = resolveSilenceTrim(GAPPY);
  // 6000ms of blank, 250ms left in place → cue in at 5.75s, NOT 6s. The margin
  // is what keeps the cut off the attack; a test asserting 6 here would pass
  // on a build that clipped every transient.
  assert.equal(t.cueInSec, 5.75);
  // The tail is an ABSOLUTE offset: 200s − (9000 − 250)ms.
  assert.equal(t.cueOutSec, 191.25);
});

test('the min-gap dial is a floor, not a hint', async () => {
  await coldLoad({ enabled: true, minGapMs: 1_500 });
  // A track that opens a beat late is not dead air.
  assert.equal(resolveSilenceTrim({ duration: 200, leadSilenceMs: 900 }).cueInSec, null);
  // Exactly at the floor still qualifies…
  assert.equal(resolveSilenceTrim({ duration: 200, leadSilenceMs: 1_500 }).cueInSec, 1.25);
  // …and raising the dial retires a gap that used to qualify, which is how an
  // operator with a segued album turns this off for their library.
  await coldLoad({ enabled: true, minGapMs: 8_000 });
  assert.equal(resolveSilenceTrim(GAPPY).cueInSec, null);
  assert.equal(resolveSilenceTrim(GAPPY).cueOutSec, 191.25);
});

test('the ceiling bounds one bad measurement', async () => {
  await coldLoad({ enabled: true, minGapMs: 1_500 });
  // 5 minutes of "silence" on a 600s track is a broken measurement. It is
  // still acted on — but only up to MAX_TRIM_SEC, so the damage is bounded at
  // 30s rather than five minutes.
  const t = resolveSilenceTrim({
    duration: 600, leadSilenceMs: 300_000, tailSilenceMs: 300_000, tailStartMs: 300_000,
  });
  assert.equal(t.cueInSec, 30);
  assert.equal(t.cueOutSec, 570);
});

test('a degenerate pair yields no cue_out rather than an empty request', async () => {
  await coldLoad({ enabled: true, minGapMs: 1_500 });
  // A 4s track whose tail "silence" outlasts it: cue_out would land at or
  // before cue_in, which Liquidsoap resolves as a request with no audio.
  const t = resolveSilenceTrim({
    duration: 4, leadSilenceMs: 2_000, tailSilenceMs: 3_500, tailStartMs: 500,
  });
  assert.equal(t.cueOutSec, null);
  // An unknown duration is the same refusal — a cue_out is absolute, so it
  // cannot be computed without a length to subtract from.
  assert.equal(resolveSilenceTrim({ tailSilenceMs: 9_000 }).cueOutSec, null);
});

test('the cue_out comes off the measured end, not the tagged duration', async () => {
  await coldLoad({ enabled: true, minGapMs: 1_500 });
  // The tag says 200s; the analyzer decoded a file that really ends at 203s and
  // reports the gap opening at 194s. Deriving the cue as (duration - gap) would
  // put it at 191.25s — 3s of real music cut off the end for no reason but a
  // stale header. tailStartMs + tailSilenceMs is the end the measurement SAW.
  const t = resolveSilenceTrim({
    duration: 200, tailSilenceMs: 9_000, tailStartMs: 194_000,
  });
  assert.equal(t.cueOutSec, 194.25);
});

test('a row analysed before tailStartMs existed falls back to the duration', async () => {
  await coldLoad({ enabled: true, minGapMs: 1_500 });
  // null is "this column predates the measurement", not "the gap opens at 0" —
  // the tagged duration is still better than refusing to trim at all.
  const t = resolveSilenceTrim({ duration: 200, tailSilenceMs: 9_000, tailStartMs: null });
  assert.equal(t.cueOutSec, 191.25);
});

test('durationSec is accepted alongside duration', async () => {
  await coldLoad({ enabled: true, minGapMs: 1_500 });
  // /now-playing resolves the trim off the lean library row, which spells the
  // length `durationSec`. Reading only `duration` there silently dropped the
  // tail side for every auto-playlist play.
  const t = resolveSilenceTrim({ durationSec: 200, leadSilenceMs: 6_000, tailSilenceMs: 9_000 });
  assert.equal(t.cueInSec, 5.75);
  assert.equal(t.cueOutSec, 191.25);
});

test('unmeasured edges stay untouched even with the feature on', async () => {
  await coldLoad({ enabled: true, minGapMs: 1_500 });
  // null is "not measured" (old analysis, capped download, an entirely-silent
  // analysis window), never "zero-length gap".
  assert.deepEqual(
    resolveSilenceTrim({ duration: 200, leadSilenceMs: null, tailSilenceMs: null }),
    { cueInSec: null, cueOutSec: null },
  );
});

test('onsets shift onto the trimmed timeline', async () => {
  await coldLoad({ enabled: true, minGapMs: 1_500 });
  // An 8s intro on a track whose first 5.75s are cut is a 2.25s runway on air.
  // Un-shifted, the DJ writes to 8s of runway and talks over the vocal.
  assert.equal(shiftOnsetMs(GAPPY, 8_000), 2_250);
  // An onset inside the trimmed head clamps to zero, never negative.
  assert.equal(shiftOnsetMs(GAPPY, 1_000), 0);
  // No leading trim → the value is passed through untouched.
  assert.equal(shiftOnsetMs({ duration: 200, leadSilenceMs: 100 }, 8_000), 8_000);
  // Un-analysed stays un-analysed: null in, null out, so the intro budget
  // stays a bonus rather than a precondition.
  assert.equal(shiftOnsetMs(GAPPY, null), null);
});

test('the feature switch is the outermost gate', async () => {
  await coldLoad({ enabled: false, minGapMs: 1_500 });
  assert.deepEqual(resolveSilenceTrim(GAPPY), { cueInSec: null, cueOutSec: null });
  // …including for the onset shift, or a disabled station would still be
  // reporting runway it never trimmed away.
  assert.equal(shiftOnsetMs(GAPPY, 8_000), 8_000);
});
