// Pins the equal-power crossfade's mixer half (J4, settings.transitions.
// equalPowerCrossfade) in radio.liq. The audio behaviour is proven by
// scripts/fx-render-test.sh eqpower, which lifts the same fader and seam rule
// out of radio.liq and renders them; this file holds the source shape in
// place where that harness does not run (CI has no Liquidsoap).
//
// What must stay true:
//   - only an explicit "true" in the handoff file switches the curve, so an
//     absent or garbage file stays linear (an upgrade is byte-identical);
//   - the fader is cos out and sin^1.5 in (in^2 + out^2 within 0.7 dB of 1),
//     not Liquidsoap's own type="sin", which is sin^2 and dips like linear;
//   - it spans the whole buffer: the outgoing over `d`, the incoming over
//     `b_fade` (the fade-equals-cross-buffer rule);
//   - only a plain song-to-song seam takes it — never a stem-blend clip seam
//     (time-aligned copies of the same audio would sum +3 dB), a jingle, a
//     bed or pause break, or a seam a gesture owns.
//
// Run: npm test -- equal-power-seam

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const radio = readFileSync(join(here, '..', '..', 'liquidsoap', 'radio.liq'), 'utf8')
  .split('\n').filter(l => !l.trimStart().startsWith('#')).join('\n');

function block(start: RegExp, end: RegExp): string {
  const s = radio.search(start);
  assert.ok(s >= 0, `radio.liq has ${start}`);
  const rest = radio.slice(s);
  const e = rest.search(end);
  assert.ok(e > 0, `radio.liq closes ${start} with ${end}`);
  return rest.slice(0, e);
}

test('the curve defaults to linear and only an explicit "true" switches it', () => {
  assert.match(radio, /^equal_power_crossfade = ref\(false\)$/m);
  assert.match(radio, /equal_power_crossfade := \(raw == "true"\)/);
  assert.ok(radio.includes('liquidsoap_equal_power_crossfade.txt'), 'reads the handoff file settings/liquidsoap.ts writes');
});

test('the fader is cos out and sin^1.5 in over the elapsed fraction of its span, not fade type="sin"', () => {
  const fader = block(/^def equal_power_fade\(~span, ~rising, s\) =$/m, /^end$/m);
  // sin^1.5 in: no faster than linear over the first quarter (a quiet ending
  // into a loud start is a fade-in from silence), within 0.9 dB of constant
  // power against the cos out.
  assert.match(fader, /if rising then pow\(sin\(half_pi \* x\), 1\.5\) else cos\(half_pi \* x\) end/);
  assert.match(fader, /x = if span <= 0\. then 1\. else e \/ span end/);
  // override=null: the default override would swap the curve for the
  // incoming's liq_amplify (no fade-in, then a step of that gain).
  assert.match(fader, /amplify\(override=null, gain, s\)/);
  assert.match(radio, /^half_pi = acos\(-1\.\) \/ 2\.$/m);
  assert.ok(!/type="sin"/.test(radio), 'Liquidsoap\'s sin fade is sin^2 — it dips like linear');
});

test('both sides span the full buffer and keep the linear fade otherwise', () => {
  assert.match(radio,
    /elsif equal_power_seam then\s+equal_power_fade\(span=d, rising=false, a\.source\)\s+else\s+fade\.out\(duration=(?:d|a_fade), initial_metadata=a\.metadata, a\.source\)/,
    // a_fade where the stem-blend clip seam alignment (#1933) is present: it
    // equals d on every seam that is not a clip seam, so on every equal-power one.
    'outgoing: equal-power over d, else the unchanged linear fade.out');
  assert.match(radio,
    /b_source =\s+if equal_power_seam then\s+equal_power_fade\(span=b_fade, rising=true, b\.source\)\s+else\s+fade\.in\(duration=b_fade, initial_metadata=b\.metadata, b\.source\)\s+end/,
    'incoming: equal-power over b_fade, else the unchanged linear fade.in');
});

test('only a plain song-to-song seam takes the curve', () => {
  const rule = block(/^ {2}equal_power_seam =$/m, /\n\s*\n|\n {2}[a-z_]+ =/m);
  for (const needle of [
    'equal_power_crossfade()',
    'not jingle_in and not jingle_out',
    'a.metadata["subwave_clip"] != "1" and b.metadata["subwave_clip"] != "1"',
    'a.metadata["subwave_kind"] == "" and b.metadata["subwave_kind"] == ""',
    'not flagged(a.metadata, "liq_washout")', 'not flagged(a.metadata, "liq_loop")',
    'not flagged(b.metadata, "liq_sweep")', 'not flagged(b.metadata, "liq_dissolve")',
    'not flagged(b.metadata, "liq_chop")', 'not flagged(b.metadata, "liq_blend")',
  ]) assert.ok(rule.includes(needle), `equal_power_seam requires: ${needle}`);
  // The rule must be decided after the gesture flags it reads exist.
  assert.ok(radio.indexOf('  equal_power_seam =') > radio.indexOf('  chopping = b.metadata["liq_chop"]'));
});
