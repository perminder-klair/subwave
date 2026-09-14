// The dissolve wash's clock cost (#1565) — a source-shape pin, not an audio
// test, because the thing that regresses here is invisible in the rendered
// output.
//
// The wash is four parallel combs whose tails are isolated by subtracting the
// dry signal. It used to do that subtraction per tap — `add([comb(a),
// amplify(-1., a)])` wrapped in its own `amplify(0.7, …)`, four times over —
// which is algebraically the same sum as one subtraction of `4a` but costs
// twelve extra full-frame operators on Liquidsoap's SINGLE streaming thread.
// Measured offline against liquidsoap 2.4.5, the folded form renders 1.87x
// faster (~345 → ~645 audio-seconds per 10s of CPU) for output that is
// bit-identical over 60s: 100.0000% of samples equal, max difference 0 LSB.
// The per-tap form stalled the clock on roughly one dissolve in five on a real
// station, which is the whole of #1565.
//
// So the shape is the fix, and a well-meaning "clearer" rewrite back to a
// per-tap helper would silently restore the stutter. This test refuses that,
// and refuses it in BOTH copies: `scripts/fx-render-test.sh` mirrors the block
// so envelope tuning can be rendered offline, and a harness that has drifted
// from the mixer proves nothing about the mixer.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

const SOURCES = [
  { name: 'liquidsoap/radio.liq', path: join(repo, 'liquidsoap', 'radio.liq'), src: 'a_source' },
  { name: 'scripts/fx-render-test.sh', path: join(repo, 'scripts', 'fx-render-test.sh'), src: 'a_src' },
];

for (const { name, path, src } of SOURCES) {
  test(`${name} sums the dissolve combs and subtracts the dry ONCE`, () => {
    const body = readFileSync(path, 'utf8');
    // The comments in both files quote the OLD shape to explain why it went,
    // so the negative assertions below read the code alone.
    const code = body.split('\n').filter(l => !l.trimStart().startsWith('#')).join('\n');

    // The four taps are the diffusion: mutually prime and tempo-unrelated, so
    // the tails smear instead of pulsing. Dropping to two was measured at only
    // ~15% on top of the fold — not worth the thinner wash.
    for (const tap of ['0.089', '0.113', '0.151', '0.181']) {
      assert.ok(
        code.includes(`comb(delay=${tap}, feedback=diss_fb, ${src})`),
        `${name} still runs a dissolve comb at ${tap}s`,
      );
    }

    // ONE subtraction for the cluster, sized to the number of taps.
    assert.ok(
      code.includes(`amplify(-4., ${src})`),
      `${name} subtracts the dry once, scaled to the four taps`,
    );

    // ...and none of the per-tap bookkeeping the fold removed.
    assert.ok(
      !code.includes('pure_tail'),
      `${name} has no per-tap pure_tail helper — that shape is what stalled the clock`,
    );
    assert.ok(
      !code.includes(`amplify(-1., ${src})`),
      `${name} has no per-tap dry subtraction left`,
    );

    // Both damping stages stay. Removing the second one was measured as free
    // (754 vs 762 — inside run-to-run noise), so it buys nothing and costs the
    // wash its depth; the wash reads as a large dark space, not an echo.
    const stages = code.match(/filter\.rc\(frequency=diss_cut, mode="low", wetness=diss_wet/g) ?? [];
    assert.equal(stages.length, 2, `${name} keeps the cascaded damping lowpass at two stages`);
  });
}
