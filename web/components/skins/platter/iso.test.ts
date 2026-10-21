// The focus-mode deck is painted back to front by hand and its tonearm is
// solved by trigonometry, so the promises both rely on are pinned here.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { project } from '@/components/iso/geometry';
import { ARM, DECK, PLATTER, RECORD, VIEWBOX, armAngle, armAngleAt, ringTicks, stylusAt } from './iso';

const fromCentre = (angle: number) => {
  const [x, y] = stylusAt(angle);
  return Math.hypot(x - PLATTER.cx, y - PLATTER.cy);
};

test('the stylus lands on the groove it was solved for', () => {
  for (const r of [44, 60, 75, 90]) {
    assert.ok(Math.abs(fromCentre(armAngleAt(r)) - r) < 0.5, `asked for ${r}, got ${fromCentre(armAngleAt(r))}`);
  }
});

test('playing tracks the record inward; parked clears it', () => {
  const start = fromCentre(armAngle('play', 0));
  const end = fromCentre(armAngle('play', 1));
  assert.ok(start > end, 'the arm should move toward the label as the song plays');
  assert.ok(start < RECORD.r && end > 30, 'the stylus left the grooves');
  assert.ok(fromCentre(armAngle('rest', null)) > PLATTER.r, 'a parked arm still sits over the platter');
  // An unknown length plays from the lead-in rather than jumping to the end.
  assert.equal(armAngle('play', null), armAngle('play', 0));
});

test('the arm comes down the record’s right side, toward the viewer', () => {
  // World +y is toward the viewer's left-front; the stylus must sit in front
  // of the pivot, not swing over the record's far side.
  const [, y] = stylusAt(armAngle('play', 0.5));
  assert.ok(y > ARM.py + 60, `stylus at y=${y} is behind the pivot`);
});

test('the sleeves stand wholly behind the plinth, so they paint first', () => {
  for (const b of [DECK.sleeveBox, DECK.nextSleeveBox]) {
    assert.ok(b.y + b.d <= DECK.plinthBox.y, 'a sleeve reaches the plinth');
  }
  assert.ok(DECK.nextSleeveBox.y + DECK.nextSleeveBox.d <= DECK.sleeveBox.y, 'the crate sleeve is not behind the front one');
});

test('the frame holds every corner the scene draws', () => {
  const { plinthBox: p, sleeveBox: s } = DECK;
  for (const pt of [project(p.x + p.w, p.y + p.d, 0), project(p.x, p.y + p.d, 0), project(s.x, s.y, s.h), project(s.x + s.w, s.y, s.h)]) {
    assert.ok(pt[0] > VIEWBOX.x0 && pt[0] < VIEWBOX.x0 + VIEWBOX.w, `x ${pt[0]} outside`);
    assert.ok(pt[1] > VIEWBOX.y0 && pt[1] < VIEWBOX.y0 + VIEWBOX.h, `y ${pt[1]} outside`);
  }
});

test('the ring lights as many ticks as the song has played', () => {
  const count = (d: string) => (d.match(/M/g) ?? []).length;
  assert.equal(count(ringTicks(null).lit), 0);
  assert.equal(count(ringTicks(0.5).lit), 30);
  assert.equal(count(ringTicks(1).lit) + count(ringTicks(1).unlit), 60);
  assert.equal(count(ringTicks(2).unlit), 0, 'an over-long elapsed lights the ring, no more');
});
