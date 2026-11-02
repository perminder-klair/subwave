// Hour markers: the wiring (docs/plans/hour-markers.md).
//
// The rules are pinned in marker-policy.test.ts. This is what the queue does
// with them, which is where the feature can be right on paper and wrong on air:
//
//   * the SCHEMA takes an ISO time or epoch ms, inside the next 12 hours.
//   * a marker rides its item into the /state snapshot with the plan's outcome.
//   * the DRAIN drops a row that would start after its marker before sending
//     it, holds an early anchor (so the auto playlist fills), never shapes a
//     seam into a held anchor, and folds a hard marker's end time into cue_out.
//   * an operator skip never commits a held anchor.
//   * a marker whose item leaves the queue moves to the next item, or is
//     dropped and logged when nothing after it can carry the time.
//   * the CUT at a hard marker fires once, and only once its anchor is queued.
//
// Run: npm test -- queue-marker-wiring

import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { queue } from '../src/broadcast/queue.js';
import type { QueueItem } from '../src/broadcast/queue/types.js';
import { queueMarkerSchema } from '../src/schemas/dj.js';

// Same neutralisation the other queue tests use: persist() writes JSON and
// drainToLiquidsoap() renders TTS and blocks on a mixer poll, neither of which
// is under test here. The drain's marker step is driven directly.
(queue as any).persist = () => {};
(queue as any).drainToLiquidsoap = async () => {};

const NOW = Date.UTC(2026, 10, 3, 6, 50);
const at = (sec: number) => NOW + sec * 1000;

beforeEach((t) => {
  if ('mock' in t) t.mock.timers.enable({ apis: ['Date'], now: NOW });
});

const item = (id: string, opts: Partial<QueueItem> & { duration?: number } = {}): QueueItem => {
  const { duration = 200, ...rest } = opts;
  return { track: { id, title: `Track ${id}`, artist: 'A', duration }, queuedAt: new Date(NOW).toISOString(), ...rest } as QueueItem;
};
const hard = (sec: number, id = 'm') => ({ id, at: at(sec), kind: 'hard' as const });
const soft = (sec: number, id = 'm') => ({ id, at: at(sec), kind: 'soft' as const });

// The track on air has 100s left.
function reset(upcoming: QueueItem[]) {
  queue.current = {
    track: { id: 'air', title: 'On Air', artist: 'A', duration: 300 },
    startedAt: new Date(NOW - 200_000).toISOString(),
    source: 'ai',
  } as QueueItem;
  queue.upcoming = upcoming;
  queue._hourMarkerCuts.clear();
}
const step = (it: QueueItem, force = false) => queue.hourMarkerDrainStep(it, force);
const logged = (re: RegExp) => queue.djLog.some((e) => re.test(e.message));

// ── the schema ─────────────────────────────────────────────────────────────

test('the schema takes an ISO time or epoch ms, inside the next 12 hours', () => {
  const parse = (body: object) => queueMarkerSchema.safeParse({ trackId: 'a', kind: 'hard', ...body });
  const iso = parse({ at: new Date(at(600)).toISOString() });
  assert.equal(iso.success && iso.data.at, at(600));
  assert.equal(parse({ at: at(600), kind: 'soft' }).success, true);
  assert.equal(parse({ at: at(-30) }).success, true, 'a marker for "now" from a slow phone still lands');
  assert.equal(parse({ at: at(-120) }).success, false);
  assert.equal(parse({ at: at(13 * 3600) }).success, false);
  assert.equal(parse({ at: '07:00' }).success, false, 'a bare clock time names no day');
  assert.equal(parse({ at: at(600), kind: 'wait' }).success, false);
});

// ── setting it ─────────────────────────────────────────────────────────────

test("a marker rides its item into the snapshot, with the plan's outcome", () => {
  // b would start at 300; its marker is at 600, so it waits.
  reset([item('a'), item('b')]);
  const r = queue.setHourMarker('b', at(600), 'hard');
  assert.ok(r.ok);
  assert.deepEqual(r.outcome, { kind: 'waiting', bySec: 300 });
  const snap = queue.snapshot();
  assert.deepEqual(snap.upcoming[1].marker, {
    id: r.marker.id, at: new Date(at(600)).toISOString(), kind: 'hard', outcome: { kind: 'waiting', bySec: 300 },
  });
  assert.equal(snap.upcoming[0].marker, undefined);
  assert.deepEqual(queue.setHourMarker('nope', at(600), 'soft'), { ok: false, reason: 'not-queued' });
});

test('a marker is cleared by its id, and the track stays queued', () => {
  reset([item('a', { marker: soft(600) })]);
  assert.equal(queue.clearHourMarker('m'), true);
  assert.equal(queue.upcoming[0].marker, undefined);
  assert.equal(queue.clearHourMarker('m'), false);
});

// ── the drain ──────────────────────────────────────────────────────────────

test('the drain drops a row that would start after its marker, before sending it', async () => {
  // a would air 100–300, after soft b's 50: a goes and b airs next.
  reset([item('a'), item('b', { marker: soft(50) })]);
  assert.equal(await step(queue.upcoming[0]), 'dropped');
  assert.deepEqual(queue.upcoming.map((i) => i.track.id), ['b']);
  assert.ok(logged(/soft marker removed from queue: Track a/));
});

test('the drain holds an early anchor, and shapes no seam into it', async () => {
  reset([item('a'), item('b', { marker: soft(600) })]);
  assert.deepEqual(await step(queue.upcoming[0]), { successorHeld: true, endBy: null });
  assert.equal(await step(queue.upcoming[1]), 'hold');
  // force releases the head a forced drain was raised for.
  assert.deepEqual(await step(queue.upcoming[1], true), { successorHeld: false, endBy: null });
});

test("a hard marker's end time reaches the drain as a cue_out", async () => {
  // a airs 100–400; hard b at 250 ends it 150s in.
  reset([item('a', { duration: 300 }), item('b', { marker: hard(250) })]);
  const s = await step(queue.upcoming[0]);
  assert.deepEqual(s, { successorHeld: false, endBy: { index: 0, atMs: at(250), markerId: 'm' } });
  assert.ok(typeof s === 'object');
  const cut = queue.resolveHourMarkerCut(queue.upcoming[0], s.endBy, 300, { cueInSec: null, cueOutSec: null }, null);
  assert.deepEqual(cut, { cueOutSec: 150, overshootSec: 150 });
});

test('an operator skip never commits a held anchor', async () => {
  reset([item('b', { marker: soft(600) })]);
  assert.deepEqual(await queue.commitBeforeSkip(), { pending: false, committed: false, waitedMs: 0 });
});

// ── leaving the queue ──────────────────────────────────────────────────────

test('a cancelled anchor passes its marker to the next item without one', async () => {
  reset([item('a', { marker: hard(600, 'm1') }), item('b', { marker: soft(900, 'm2') }), item('c')]);
  assert.deepEqual(await queue.removeUpcoming('a'), { ok: true });
  assert.deepEqual(queue.upcoming.map((i) => i.marker?.id), ['m2', 'm1']);
  assert.ok(logged(/marker moves to "Track c": "Track a" was removed/));
});

test('with nothing after it, the marker is dropped and logged', async () => {
  reset([item('a', { marker: hard(600) })]);
  assert.deepEqual(await queue.removeUpcoming('a'), { ok: true });
  assert.equal(queue.upcoming.length, 0);
  assert.ok(logged(/marker dropped: "Track a" was removed and nothing queued after it/));
});

// ── the cut ────────────────────────────────────────────────────────────────

test('the cut at a hard marker fires once, and only once its anchor is queued', () => {
  let skips = 0;
  const skip = async () => { skips++; };
  reset([item('b', { marker: hard(-1) })]);
  queue.maybeHourMarkerCut(skip);
  assert.equal(skips, 0, 'the anchor is not in the mixer yet');
  queue.upcoming[0].sent = true;
  queue.maybeHourMarkerCut(skip);
  queue.maybeHourMarkerCut(skip);
  assert.equal(skips, 1, 'a second tick would cut the anchor itself');
  reset([item('b', { sent: true, marker: hard(30) })]);
  queue.maybeHourMarkerCut(skip);
  reset([item('b', { sent: true, marker: soft(-1) })]);
  queue.maybeHourMarkerCut(skip);
  assert.equal(skips, 1, 'never before its time, and never for a soft marker');
});

test('an anchor that starts is logged with how it kept its time', () => {
  queue._hourMarkerCuts.add('m');
  queue.hourMarkersAired([item('b', { marker: hard(-3) })], NOW);
  assert.equal(queue._hourMarkerCuts.has('m'), false);
  assert.ok(logged(/hard marker: "Track b" started on time/));
  queue.hourMarkersAired([item('c', { marker: soft(-40) })], NOW);
  assert.ok(logged(/soft marker: "Track c" started 40s late/));
});
