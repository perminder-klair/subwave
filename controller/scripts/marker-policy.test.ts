// Hour markers (docs/plans/hour-markers.md): the pure policy the drain runs.
// Each case is a timeline in seconds from now. queue-marker-wiring.test.ts
// drives what the queue does with the plan.
//
// What this pins:
//   * soft drops only UNSENT rows that would start at or after the marker, and
//     lets the track airing at the marker finish.
//   * hard also ends the track airing at the marker AT the marker: an unsent
//     row by cue_out at its drain, a sent or on-air one by the cut at the
//     marker, and a would-be stub is dropped instead, reported as an early start.
//   * both wait when early: an unsent anchor a whole floor early is held while
//     the auto playlist fills, and less than that joins early.
//   * a sent row is never dropped, and nor is another anchor; one starting
//     after the marker is reported late.
//   * unknown drops nothing, and holds an unsent anchor only until the release lead.
//   * markers are planned in queue order, each over the queue the last one left.
//   * the hard anchor's send and the cut at the marker.
//   * forecastQueue is the GET /state airsAt walk.
//
// Run: npm test -- marker-policy

import assert from 'node:assert/strict';
import test from 'node:test';
import { forecastQueue } from '../src/broadcast/drain-policy.js';
import {
  markerCutDue, markerSendDue, planMarkers, MARKER_RELEASE_LEAD_SEC,
  type MarkerKind, type MarkerRow,
} from '../src/broadcast/marker-policy.js';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const at = (sec: number) => NOW + sec * 1000;
const row = (playableSec: number | null, opts: { sent?: boolean; hidden?: number } = {}): MarkerRow => ({
  playableSec, hiddenSec: opts.hidden ?? 0, sent: opts.sent ?? false,
});
const anchor = (kind: MarkerKind, atSec: number, playableSec = 200, id = 'm1', sent = false): MarkerRow => ({
  ...row(playableSec, { sent }), marker: { id, at: at(atSec), kind },
});
const plan = (onAirRemainingSec: number | null, rows: MarkerRow[]) => planMarkers({ nowMs: NOW, onAirRemainingSec, rows });

test('no marker, no plan', () => {
  assert.deepEqual(plan(100, [row(200), row(200)]), { drop: [], hold: [], endBy: [], markers: [] });
});

test('soft: on time leaves the queue alone', () => {
  // The anchor starts at 300, 30s before its marker: under the wait's floor.
  const p = plan(100, [row(200), anchor('soft', 330)]);
  assert.deepEqual([p.drop, p.hold], [[], []]);
  assert.deepEqual(p.markers[0].outcome, { kind: 'on-time' });
});

test('early by the floor or more: the anchor is held while the auto playlist fills', () => {
  for (const kind of ['soft', 'hard'] as const) {
    const p = plan(100, [row(200), anchor(kind, 500)]);
    assert.deepEqual([p.drop, p.hold, p.endBy], [[], [1], []]);
    assert.deepEqual(p.markers[0].outcome, { kind: 'waiting', bySec: 200 });
  }
});

test('a sent anchor cannot be held, so it is reported early', () => {
  const p = plan(100, [row(200, { sent: true }), anchor('soft', 500, 200, 'm1', true)]);
  assert.deepEqual(p.hold, []);
  assert.deepEqual(p.markers[0].outcome, { kind: 'early', bySec: 200 });
});

test('hard: early under the floor joins early rather than wait', () => {
  const p = plan(100, [row(200), anchor('hard', 330)]);
  assert.deepEqual([p.drop, p.hold, p.endBy], [[], [], []]);
  assert.deepEqual(p.markers[0].outcome, { kind: 'early', bySec: 30 });
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

test('hard: an on-air or sent track running past the marker is left to the cut', () => {
  for (const p of [plan(300, [anchor('hard', 120)]), plan(100, [row(300, { sent: true }), anchor('hard', 250)])]) {
    assert.deepEqual([p.drop, p.hold, p.endBy], [[], [], []]);
    assert.deepEqual(p.markers[0].outcome, { kind: 'on-time' });
  }
});

test('hard: ending within the tolerance needs nothing', () => {
  const p = plan(100, [row(152), anchor('hard', 250)]);
  assert.deepEqual([p.drop, p.hold, p.endBy], [[], [], []]);
  assert.deepEqual(p.markers[0].outcome, { kind: 'on-time' });
});

test('unknown drops nothing, and holds an unsent anchor only until the release lead', () => {
  const p = plan(100, [row(null), row(200), anchor('soft', 50)]);
  assert.deepEqual(p.drop, []);
  assert.deepEqual(p.markers[0].outcome, { kind: 'unknown' });
  const lead = MARKER_RELEASE_LEAD_SEC;
  assert.deepEqual(plan(null, [row(200), anchor('hard', lead + 1)]).hold, [1]);
  assert.deepEqual(plan(null, [row(200), anchor('hard', lead)]).hold, []);
  assert.deepEqual(plan(null, [anchor('hard', 600, 200, 'm1', true)]).hold, []);
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

test('a wait lengthens the queue ahead of the next marker', () => {
  // A is held to 500, so it airs 500–700, and hard B at 650 cuts it there.
  const p = plan(100, [row(200), anchor('soft', 500, 200, 'A'), anchor('hard', 650, 200, 'B')]);
  assert.deepEqual(p.hold, [1]);
  assert.deepEqual(p.endBy, [{ index: 1, atMs: at(650), markerId: 'B' }]);
  assert.deepEqual(p.markers.map((m) => m.outcome.kind), ['waiting', 'on-time']);
});

test('an anchor is never dropped for a later marker; that marker is late', () => {
  // A waits until 900, which runs past B's 150: A stays, and B is late.
  const p = plan(100, [row(200), anchor('soft', 900, 200, 'A'), anchor('soft', 150, 200, 'B')]);
  assert.deepEqual(p.drop, []);
  assert.deepEqual(p.markers[1].outcome, { kind: 'late', bySec: 200 });
});

test('a hard anchor goes to the mixer by the release lead, whatever a pair drain would hold', () => {
  const lead = MARKER_RELEASE_LEAD_SEC * 1000;
  const hard = { id: 'm1', at: at(600), kind: 'hard' as const };
  assert.equal(markerSendDue(hard, hard.at - lead - 1), false);
  assert.equal(markerSendDue(hard, hard.at - lead), true);
  assert.equal(markerSendDue({ ...hard, kind: 'soft' }, hard.at), false);
  assert.equal(markerSendDue(null, hard.at), false);
});

test('the cut at a hard marker: on time, never early, never a click, and late after a restart', () => {
  const marker = { id: 'm1', at: at(0), kind: 'hard' as const };
  const cut = (o: Partial<Parameters<typeof markerCutDue>[0]>) =>
    markerCutDue({ nowMs: NOW, marker, anchorSent: true, onAirRemainingSec: 120, ...o });
  assert.equal(cut({}), true);
  assert.equal(cut({ nowMs: NOW - 1 }), false);
  assert.equal(cut({ onAirRemainingSec: 5 }), false);
  assert.equal(cut({ onAirRemainingSec: null }), true);
  assert.equal(cut({ nowMs: NOW + 3_600_000 }), true);
  assert.equal(cut({ anchorSent: false }), false);
  assert.equal(cut({ marker: { ...marker, kind: 'soft' } }), false);
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
