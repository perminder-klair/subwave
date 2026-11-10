// Pins the SFX layer's mix level in radio.liq (#1689).
//
// `smooth_add` adds `special` at its own level and only scales `normal` by `p`
// while the special source has signal. The stinger used to be pre-scaled with
// `amplify(0.7, sfx_queue)`, which put it ~-3 dB under a programme that was
// itself only ~-3 dB down and carried the mic_chain-boosted DJ: an explicit
// POST /sfx/:name/play answered {"ok":true} and was all but inaudible. The fix
// airs the stinger at unity and leaves the light duck (`p={0.7}`) alone, so
// both halves are pinned. The SFX level is a literal by design (see
// docs/internals/broadcast.md), not a setting, so the only place a regression
// can land is this text.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const RADIO_LIQ = join(here, '..', '..', 'liquidsoap', 'radio.liq');
const liq = readFileSync(RADIO_LIQ, 'utf8');

test('the stinger airs at unity gain', () => {
  assert.ok(
    /^sfx_bed = amplify\(1\.0, sfx_queue\)$/m.test(liq),
    'radio.liq must define sfx_bed = amplify(1.0, sfx_queue)',
  );
});

test('no 0.7 pre-scale on the sfx_queue survives', () => {
  assert.ok(
    !/amplify\(\s*0\.7\s*,\s*sfx_queue\s*\)/.test(liq),
    'amplify(0.7, sfx_queue) buries stingers under the DJ (#1689)',
  );
});

test('the SFX smooth_add keeps its light p={0.7} duck', () => {
  // Scope to the one smooth_add whose special is sfx_bed, so edits to the
  // voice/intro layers or the dissolve wash cannot trip this.
  const calls = [...liq.matchAll(/smooth_add\(([^)]*)\)/g)].map((m) => m[1]);
  const sfx = calls.filter((args) => /special\s*=\s*sfx_bed\b/.test(args));
  assert.equal(sfx.length, 1, 'exactly one smooth_add mixes sfx_bed');
  assert.match(sfx[0], /\bp\s*=\s*\{\s*0\.7\s*\}/);
  assert.match(sfx[0], /\bnormal\s*=\s*radio\b/);
});
