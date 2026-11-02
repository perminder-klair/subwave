// The length cap's cue-out is stamped only on a track that runs past the cap
// (music/track-floor.capCueOutSec).
//
// THE DEFECT THIS GUARDS. Every capped pick used to carry liq_cue_out=<cap>,
// on the belief that a cue-out past the end is a no-op. It is not: Liquidsoap's
// cue-out wrapper (request.ml, 2.4) reports remaining time as
// `cue_out - position` when the decoder cannot measure the file, which is the
// normal case for a Navidrome stream ("Estimating duration from bitrate"). A
// 5-minute song stamped at 600 claimed minutes of runway to its last second,
// `cross` never opened its buffer, and with a max track length set on a show
// every seam played back-to-back — the mixer log showed "End of track reached
// at 309.73 before cue-out point at 600.00!" on every track. Setting the show's
// cap to 0 brought the crossfades back, which is how it was confirmed.
//
// Run: npm test -- cap-cue-out

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { capCueOutSec } from '../src/music/track-floor.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(path.join(here, '..', 'src', rel), 'utf8');

test('a track shorter than the cap gets NO cap cue-out', () => {
  assert.equal(capCueOutSec(309.7, 600), null);
  assert.equal(capCueOutSec(600, 600), null, 'exactly at the cap is not over it');
});

test('a track longer than the cap is still cut at the cap', () => {
  assert.equal(capCueOutSec(9300, 600), 600);
  assert.equal(capCueOutSec(600.5, 600), 600);
});

test('an unknown length still stamps the cap — nothing else would stop it', () => {
  for (const unknown of [null, undefined, 0, -1, NaN]) {
    assert.equal(capCueOutSec(unknown as number | null | undefined, 600), 600, `len=${String(unknown)}`);
  }
});

test('no cap (null/0/negative/garbage) → no stamp, whatever the length', () => {
  for (const off of [null, undefined, 0, -5, NaN]) {
    assert.equal(capCueOutSec(9300, off as number | null | undefined), null, `cap=${String(off)}`);
    assert.equal(capCueOutSec(null, off as number | null | undefined), null, `cap=${String(off)}, len unknown`);
  }
});

test('both writers of a capped annotation route the cap through capCueOutSec', () => {
  // The drain (next.txt) and the auto.m3u coast are the only two capped
  // annotation paths; a raw `maxDurationSec,` passed to getAnnotatedUri at
  // either is the regression.
  const drain = src('broadcast/queue.ts');
  const coast = src('broadcast/scheduler.ts');
  for (const [name, text] of [['queue.ts', drain], ['scheduler.ts', coast]] as const) {
    const call = text.slice(text.indexOf('subsonic.getAnnotatedUri('), text.indexOf('subsonic.getAnnotatedUri(') + 400);
    assert.match(call, /maxDurationSec:\s*capCueOutSec\(/, `${name} must pass the cap through capCueOutSec`);
  }
});
