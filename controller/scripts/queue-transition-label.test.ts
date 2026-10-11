// Pins the admin queue's plain-language description of the imminent seam
// (broadcast/queue/pure.ts nextTransitionLabel → snapshot().nextTransition).
//
// Two properties are load-bearing:
//
//  - The label mirrors radio.liq's dj_transition precedence (:287-291, :381),
//    which lives on BOTH sides of the pair: washout/loop ride the OUTGOING
//    track, sweep/blend/dissolve/chop ride the INCOMING one. A label derived
//    from one side alone is wrong roughly half the time.
//  - The label is a FACT, not a forecast. applyMixTransition, the pair stamps
//    and the stem-blend arm all run when the incoming item drains, so flags on
//    an unsent item are raw agent proposals — vetoes may strip them and
//    drain-time policy may add others. Anything unsent must read null, which
//    the dashboard renders as an em dash.
//
// Run: npx tsx scripts/queue-transition-label.test.ts (auto-discovered by npm test).
import assert from 'node:assert/strict';
import test from 'node:test';

import { nextTransitionLabel } from '../src/broadcast/queue/pure.js';

const item = (track = {}, stemSeam = false, sent = true) => ({ track, stemSeam, sent });

test('no incoming item means no seam to describe', () => {
  assert.equal(nextTransitionLabel(null, null), null);
});

test('an unknown outgoing side still reports the plain crossfade', () => {
  // Boot/recover: nothing is on air yet, and an auto.m3u fill carries no queue
  // item — so it can carry no exit gesture either. Normal is the honest answer.
  assert.equal(nextTransitionLabel(null, item()), 'Normal');
});

test('an unsent incoming item is a proposal, never a label', () => {
  assert.equal(nextTransitionLabel(item(), item({ sweep: true }, false, false)), null);
});

test('the sent gate outranks even a stem-seam stamp', () => {
  // stemSeam is stamped on the successor at its PREDECESSOR's drain, so it
  // routinely rides an unsent item. Reporting it here would put the label a
  // whole track early.
  assert.equal(nextTransitionLabel(item(), item({}, true, false)), null);
});

test('exit gestures ride the outgoing track', () => {
  assert.equal(nextTransitionLabel(item({ washout: true }), item()), 'Washout');
  assert.equal(nextTransitionLabel(item({ loop: true }), item()), 'Loop');
});

test('entry gestures ride the incoming track', () => {
  assert.equal(nextTransitionLabel(item(), item({ sweep: true })), 'Sweep');
  assert.equal(nextTransitionLabel(item(), item({ blend: true })), 'Blend');
  assert.equal(nextTransitionLabel(item(), item({ dissolve: true })), 'Dissolve');
  assert.equal(nextTransitionLabel(item(), item({ chop: true })), 'Chop');
});

test('a washout coexists with sweep and blend', () => {
  assert.equal(
    nextTransitionLabel(item({ washout: true }), item({ sweep: true })),
    'Washout + Sweep',
  );
  assert.equal(
    nextTransitionLabel(item({ washout: true }), item({ blend: true })),
    'Washout + Blend',
  );
});

test('a washout suppresses dissolve and chop', () => {
  // radio.liq:289-291 — enforced there too, so the label must describe what
  // actually airs rather than what the queue happens to hold.
  assert.equal(
    nextTransitionLabel(item({ washout: true }), item({ dissolve: true, chop: true })),
    'Washout',
  );
});

test('a loop suppresses every entry gesture', () => {
  // radio.liq:288 + :381 — the loop IS the transition; garnishing it chokes
  // the gesture.
  assert.equal(
    nextTransitionLabel(item({ loop: true }), item({ sweep: true, blend: true })),
    'Loop',
  );
});

test('an exit gesture on the INCOMING track shapes its own future ending', () => {
  // Reading loop/washout off the incoming item would report the seam AFTER
  // the one the header names.
  assert.equal(nextTransitionLabel(item(), item({ loop: true, washout: true })), 'Normal');
});

test('a rendered stem blend owns the whole seam', () => {
  // The arm strips exit gestures from the outgoing track and entry gestures
  // from the incoming one, so no live effect can survive alongside it — but
  // the override is asserted here rather than trusted upstream.
  assert.equal(
    nextTransitionLabel(item({ washout: true }), item({ sweep: true }, true)),
    'Stem blend',
  );
});

test('a show-boundary cut on the outgoing track is a plain crossfade', () => {
  // radio.liq reads liq_show_fade off the OUTGOING track and stands every
  // gesture down on both sides of the seam (#1574) — an entry flag left on the
  // successor must not read as the transition that airs.
  assert.equal(
    nextTransitionLabel(item({ showFade: true }), item({ sweep: true, chop: true })),
    'Normal',
  );
  assert.equal(
    nextTransitionLabel(item({ showFade: true, washout: true }), item({ blend: true })),
    'Normal',
  );
});
