// Hour markers (docs/plans/hour-markers.md): the proposed policy, before any of
// it is wired into the drain. Each case is a timeline in seconds from now.
//
// What this pins:
//   * soft drops only UNSENT rows that would start at or after the marker, and
//     lets the track airing at the marker finish.
//   * hard also ends the track airing at the marker AT the marker: an unsent
//     row by cue_out at its drain, a sent or on-air one by a timed skip, and a
//     would-be stub is dropped instead, reported as an early start.
//   * a sent row is never dropped; one starting after the marker is reported late.
//   * unknown is never acted on.
//   * markers are planned in queue order, each over the queue the last one left.
//   * forecastQueue is the GET /state airsAt walk.
//
// Run: npm test -- marker-policy

import assert from 'node:assert/strict';
import test from 'node:test';
import { forecastQueue } from '../src/broadcast/drain-policy.js';
import { planMarkers, type MarkerKind, type MarkerRow } from '../src/broadcast/marker-policy.js';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const at = (sec: number) => NOW + sec * 1000;
const row = (playableSec: number | null, opts: { sent?: boolean; hidden?: number } = {}): MarkerRow => ({
  playableSec, hiddenSec: opts.hidden ?? 0, sent: opts.sent ?? false,
});
const anchor = (kind: MarkerKind, atSec: number, playableSec = 200, id = 'm1'): MarkerRow => ({
  ...row(playableSec), marker: { id, at: at(atSec), kind },
});
const plan = (onAirRemainingSec: number | null, rows: MarkerRow[]) => planMarkers({ nowMs: NOW, onAirRemainingSec, rows });

test('no marker, no plan', () => {
  assert.deepEqual(plan(100, [row(200), row(200)]), { drop: [], endBy: [], skipAt: [], markers: [] });
});

test('soft: on time leaves the queue alone', () => {
  const p = plan(100, [row(200), anchor('soft', 500)]);
  assert.deepEqual(p.drop, []);
  assert.deepEqual(p.markers[0].outcome, { kind: 'on-time' });
});

test('soft: late drops the unsent rows that would start after the marker', () => {
  // On air ends at 100; rows start at 100, 300 and 500. Marker at 250.
  const p = plan(100, [row(200), row(200), row(200), anchor('soft', 250)]);
  assert.deepEqual(p.drop, [1, 2]);
  assert.deepEqual(p.markers[0].outcome, { kind: 'on-time' });
});

test('soft: a sent row starting after the marker is never dropped, only reported', () => {
  const p = plan(100, [row(200, { sent: true }), row(200, { sent: true }), anchor('soft', 250)]);
  assert.deepEqual(p.drop, []);
  assert.deepEqual(p.markers[0].outcome, { kind: 'late', bySec: 200 });
});

test('hard: the track airing at the marker ends at it, by cue_out at its drain', () => {
  // Row 0 airs 100–400; marker at 250, so it plays 150s and ends on the marker.
  const p = plan(100, [row(300), anchor('hard', 250)]);
  assert.deepEqual(p.endBy, [{ index: 0, atMs: at(250), markerId: 'm1' }]);
  assert.deepEqual(p.markers[0].outcome, { kind: 'on-time' });
});

test('hard: a would-be stub is dropped and the anchor starts early instead', () => {
  // Row 0 would play only 50s before the marker at 150.
  const p = plan(100, [row(300), anchor('hard', 150)]);
  assert.deepEqual(p.drop, [0]);
  assert.deepEqual(p.endBy, []);
  assert.deepEqual(p.markers[0].outcome, { kind: 'early', bySec: 50 });
});

test('hard: an on-air or sent track running past the marker needs a timed skip', () => {
  assert.deepEqual(plan(300, [anchor('hard', 120)]).skipAt, [{ target: 'on-air', atMs: at(120), markerId: 'm1' }]);
  assert.deepEqual(plan(100, [row(300, { sent: true }), anchor('hard', 250)]).skipAt,
    [{ target: 0, atMs: at(250), markerId: 'm1' }]);
});

test('hard: ending within the tolerance needs nothing', () => {
  const p = plan(100, [row(152), anchor('hard', 250)]);
  assert.deepEqual([p.drop, p.endBy, p.skipAt], [[], [], []]);
  assert.deepEqual(p.markers[0].outcome, { kind: 'on-time' });
});

test('unknown is never acted on', () => {
  assert.deepEqual(plan(null, [row(200), anchor('hard', 100)]).markers[0].outcome, { kind: 'unknown' });
  const p = plan(100, [row(null), row(200), anchor('soft', 50)]);
  assert.deepEqual(p.drop, []);
  assert.deepEqual(p.markers[0].outcome, { kind: 'unknown' });
});

test("each marker plans over the queue the one before it left", () => {
  // Rows would start at 100, 300, 500 (A), 700, 900 (B). Soft A at 250 drops
  // row 1, which pulls row 3 back to 500–700; hard B at 600 then cuts row 3
  // instead of dropping it.
  const p = plan(100, [row(200), row(200), anchor('soft', 250, 200, 'A'), row(200), anchor('hard', 600, 200, 'B')]);
  assert.deepEqual(p.drop, [1]);
  assert.deepEqual(p.endBy, [{ index: 3, atMs: at(600), markerId: 'B' }]);
  assert.deepEqual(p.markers.map((m) => m.outcome.kind), ['on-time', 'on-time']);
});

test('forecastQueue counts a sent row\'s bed behind it, and an unknown length ends the forecast', () => {
  assert.deepEqual(forecastQueue(100, [
    { playableSec: 200, hiddenSec: 20, sent: true },
    { playableSec: 200, hiddenSec: 0, sent: false },
    { playableSec: null, hiddenSec: 0, sent: false },
    { playableSec: 200, hiddenSec: 0, sent: false },
  ]), [120, 320, 520, null]);
  assert.deepEqual(forecastQueue(null, [{ playableSec: 200, hiddenSec: 0, sent: false }]), [null]);
});
