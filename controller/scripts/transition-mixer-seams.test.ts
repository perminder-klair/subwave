// Three mixer-side seam rules in radio.liq's dj_transition, pinned as source
// shapes because none of them is visible to a controller test and the renders
// that prove them need Docker (`scripts/fx-render-test.sh loopgaps |
// jingleseam`, plus the chop level tables in liquidsoap/CLAUDE.md).
//
//   1. JINGLE SEAMS. The rotate and jingle_now sit upstream of cross, so on
//      A -> J -> B the J -> B seam reads B's entry flag, which was validated for
//      A -> B. Both jingle sources stamp `subwave_jingle` and every
//      incoming-side gesture stands down when the outgoing track carries it.
//   2. LOOP FRAME RULES. A comb built inside the transition never stores its
//      first 20 ms frame, and an amplify getter only switches on a frame
//      boundary, so the old gate (close at bar) dropped out at every repeat.
//      The bar snaps to the frame grid and the dry gate holds one extra frame.
//   3. CHOP INCOMING FADE. The chop silences the outgoing on its own clock,
//      min(d, 10s); an incoming fade over the full d left a hole from there to
//      d (-47.4 dB at d=30 against a -37 dB track).
//
// Rules 2 and 3 are checked in BOTH copies: the harness mirrors the blocks so
// they can be rendered offline, and a harness that has drifted from the mixer
// proves nothing about the mixer. Rule 1 needs no mirror — the harness LIFTS
// those lines out of radio.liq.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

// Code only: both files quote the OLD shapes in comments to explain why they went.
function code(path: string): string {
  return readFileSync(path, 'utf8').split('\n').filter(l => !l.trimStart().startsWith('#')).join('\n');
}

const radio = code(join(repo, 'liquidsoap', 'radio.liq'));
const harness = code(join(repo, 'scripts', 'fx-render-test.sh'));

function armingLine(flag: string): string {
  const line = radio.split('\n').find(l => l.includes(`${flag}"] == "true"`));
  assert.ok(line, `radio.liq arms ${flag}`);
  return line;
}

test('every incoming-side gesture stands down on a jingle\'s seam', () => {
  assert.match(radio, /^ {2}jingle_out = a\.metadata\["subwave_jingle"\] == "true"$/m,
    'the guard reads the OUTGOING track');
  for (const flag of ['liq_sweep', 'liq_dissolve', 'liq_chop', 'liq_blend']) {
    const line = armingLine(flag);
    assert.ok(line.includes('not jingle_out'), `${flag} must stand down after a jingle — its line reads: ${line.trim()}`);
  }
  // The outgoing gestures describe the ending track's OWN ending, which is still
  // true going into a jingle, and a jingle never carries them itself.
  for (const flag of ['liq_washout', 'liq_loop']) {
    assert.ok(!armingLine(flag).includes('jingle_out'), `${flag} is not a jingle-seam concern`);
  }
});

test('both jingle sources carry the mark the guard reads', () => {
  const mark = 'metadata.map(update=true, fun (_) -> [("subwave_jingle", "true")], ';
  // The automatic rotate's playlist, and jingle_now — the path every jingle
  // takes when the controller owns the rotate (#1619).
  assert.ok(radio.includes(`jingles = ${mark}jingles)`), 'the rotate\'s jingles are marked');
  assert.ok(radio.includes(`jingle_now = ${mark}jingle_now)`), 'on-demand jingles are marked');
  // Marked AFTER the source.available gate wraps them and BEFORE either joins
  // the music chain, so the mark rides every jingle that reaches cross.
  assert.ok(radio.indexOf(`jingles = ${mark}jingles)`) < radio.indexOf('rotate(weights=[1, jingle_ratio()], [jingles, music])'));
  assert.ok(radio.indexOf(`jingle_now = ${mark}jingle_now)`) < radio.indexOf('[jingle_now, music]'));
});

for (const [name, body] of [['liquidsoap/radio.liq', radio], ['scripts/fx-render-test.sh', harness]] as const) {
  test(`${name}: the loop bar sits on the frame grid and the dry gate holds one extra frame`, () => {
    assert.ok(body.includes('bar = fd * float_of_int(int_of_float(bar / fd + 0.5))'), 'bar snaps to frame.duration()');
    assert.ok(body.includes('if e < bar + 0.5 * fd then 1.0 else 0.0 end'),
      'the gate covers the frame no comb keeps');
    assert.ok(!body.includes('edge = 0.012'), 'the sub-frame smoothstep edge (never rendered) is gone');
  });

  test(`${name}: the chop's incoming fade runs on the chop's own clock`, () => {
    assert.ok(body.includes('chop_dd = if d > 10. then 10. else d end'), 'one compressed clock');
    assert.ok(body.includes('dd = chop_dd'), 'the chop gate rides it');
    const flag = name === 'liquidsoap/radio.liq' ? 'chopping' : 'chop_on';
    assert.ok(body.includes(`b_fade = if ${flag} then chop_dd else d end`), 'and so does the incoming fade');
    assert.match(body, /fade\.in\(duration=b_fade, /, 'the incoming fade uses it');
  });
}
