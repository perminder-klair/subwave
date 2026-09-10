// Album / block queueing — the wiring (#1622 FR 4).
//
// The plan is pinned in queue-block.test.ts. This is everything the plan hands
// to the rest of the system, which is where the feature can be right on paper
// and wrong on air:
//
//   * the SCHEMA's two refusals. `order: 'shuffle'` and `limit` on an album are
//     refused rather than ignored, because silently discarding a field the
//     caller sent is how two fields come to disagree about what was asked for.
//   * the BLOCK STAMP is identity only. It must reach the item and the
//     snapshot, and it must carry the size it was PLANNED with, so a block half
//     played still reads "9 of 11".
//   * the CANCEL is the inverse of the press, and it is partial by design.
//   * a listener request behind a block is told how long, honestly.
//
// Run: npm test -- queue-block-wiring

import assert from 'node:assert/strict';
import test from 'node:test';
import { queue } from '../src/broadcast/queue.js';
import { queueBlockSchema, QUEUE_BLOCK_MAX_TRACKS } from '../src/schemas/dj.js';
import { formatWait, requestWaitClause, REQUEST_WAIT_NOTICE_SEC } from '../src/broadcast/queue/pure.js';

// Same neutralisation the other queue tests use: persist() writes JSON and
// drainToLiquidsoap() renders TTS and blocks on a mixer poll, neither of which
// is under test here.
(queue as any).persist = () => {};
(queue as any).drainToLiquidsoap = async () => {};

function reset() {
  queue.upcoming = [];
  queue.current = null;
}

const err = (body: unknown): string => {
  const r = queueBlockSchema.safeParse(body);
  assert.equal(r.success, false, 'expected this body to be refused');
  return r.success ? '' : r.error.issues[0].message;
};

// ── the schema ─────────────────────────────────────────────────────────────

test('a bare album block by trackId parses, and defaults to natural order', () => {
  const r = queueBlockSchema.safeParse({ kind: 'album', trackId: 'abc' });
  assert.equal(r.success, true);
  assert.equal(r.success && r.data.order, 'natural');
});

test('an album refuses shuffle rather than ignoring it', () => {
  assert.match(err({ kind: 'album', trackId: 'abc', order: 'shuffle' }), /own order/);
});

test('an album refuses a limit rather than cutting the record at it', () => {
  assert.match(err({ kind: 'album', trackId: 'abc', limit: 4 }), /queued whole/);
});

test('an artist block takes both', () => {
  const r = queueBlockSchema.safeParse({ kind: 'artist', artist: 'Jon Hopkins', limit: 4, order: 'shuffle' });
  assert.equal(r.success, true);
});

test('an album refuses an artist NAME — that names an artist block', () => {
  assert.match(err({ kind: 'album', artist: 'Jon Hopkins' }), /artist block/);
});

test('naming no block at all is refused', () => {
  assert.match(err({ kind: 'album' }), /trackId, id or artist is required/);
});

test('a limit past the cap is refused, since the cap is what truncates', () => {
  assert.match(err({ kind: 'artist', artist: 'X', limit: QUEUE_BLOCK_MAX_TRACKS + 1 }), /between 1 and/);
});

// ── the block stamp ────────────────────────────────────────────────────────

const blockPush = (n: number, id: string, size: number) => queue.push({
  track: { id: `b${n}`, title: `Track ${n}`, artist: 'A', album: 'Rec' },
  requestedBy: 'studio',
  operator: true,
  allowDuplicate: true,
  block: { id, label: 'Rec — A', index: n, size },
});

test('the stamp rides the item, and the block is not a listener in the line', async () => {
  reset();
  await blockPush(1, 'blk', 3);
  await blockPush(2, 'blk', 3);
  assert.equal(queue.upcoming[0].block?.id, 'blk');
  assert.equal(queue.upcoming[0].block?.label, 'Rec — A');
  assert.equal(queue.upcoming[1].block?.index, 2);
  // The two exemptions the block inherits verbatim from POST /dj/queue-track.
  assert.equal(queue.upcoming[0].requestedBy, 'studio', 'keeps the air-path discriminator');
  assert.equal(queue.pendingListenerRequests(), 0, 'and takes no request slot');
});

test('an ordinary push carries no block', async () => {
  reset();
  await queue.push({ track: { id: 'x', title: 'X' }, requestedBy: 'alice' });
  assert.equal(queue.upcoming[0].block, undefined);
});

// `allowDuplicate` is how an operator press gets past the #619 dedup guard, so
// a block may legitimately hold the same track twice (a record with a reprise,
// a compilation). Nothing may collapse them.
test('a duplicate track inside one block queues twice', async () => {
  reset();
  const same = { id: 'dup', title: 'Reprise', artist: 'A' };
  await queue.push({ track: same, requestedBy: 'studio', operator: true, allowDuplicate: true, block: { id: 'b', label: 'L', index: 1, size: 2 } });
  await queue.push({ track: same, requestedBy: 'studio', operator: true, allowDuplicate: true, block: { id: 'b', label: 'L', index: 2, size: 2 } });
  assert.equal(queue.upcoming.length, 2);
});

test('the snapshot carries the block so the admin queue can badge it', async () => {
  reset();
  await blockPush(1, 'blk', 2);
  await queue.push({ track: { id: 'solo', title: 'Solo' }, requestedBy: null, aiPicked: true });
  const snap = queue.snapshot();
  assert.equal(snap.upcoming[0].block?.label, 'Rec — A');
  assert.equal(snap.upcoming[1].block, undefined);
});

// The size is stamped from the PLAN, so a block half played still reads
// "3 of 11" rather than shrinking with the queue as its tracks air.
test('the stamped size does not shrink as the block plays out', async () => {
  reset();
  await blockPush(1, 'blk', 3);
  await blockPush(2, 'blk', 3);
  await blockPush(3, 'blk', 3);
  queue.upcoming.shift(); // track 1 aired
  assert.equal(queue.upcoming[0].block?.index, 2);
  assert.equal(queue.upcoming[0].block?.size, 3);
});

// ── the cancel ─────────────────────────────────────────────────────────────

test('cancelling a block removes only that block', async () => {
  reset();
  await blockPush(1, 'blk', 2);
  await queue.push({ track: { id: 'keep', title: 'Keep' }, requestedBy: 'alice' });
  await blockPush(2, 'blk', 2);
  const out = await queue.removeUpcomingBlock('blk');
  assert.deepEqual({ removed: out.removed, kept: out.kept }, { removed: 2, kept: 0 });
  assert.deepEqual(queue.upcoming.map(i => i.track.id), ['keep']);
});

// Each removal splices `upcoming`, so a walk over the live array would skip
// every other member — the classic mutate-while-iterating bug, and here it
// would leave half a record on air after the operator pressed cancel.
test('every member goes, not every other one', async () => {
  reset();
  for (let n = 1; n <= 6; n++) await blockPush(n, 'blk', 6);
  const out = await queue.removeUpcomingBlock('blk');
  assert.equal(out.removed, 6);
  assert.equal(queue.upcoming.length, 0);
});

// Partial success is the NORMAL answer, not an error: on a long block the head
// is very often already committed to the mixer, and refusing the whole cancel
// over it would leave the operator pulling the rest by hand — the failure this
// exists to prevent.
test('a member the mixer already took plays out; the rest still go', async () => {
  reset();
  for (let n = 1; n <= 4; n++) await blockPush(n, 'blk', 4);
  queue.upcoming[0].sent = true;
  const removeItem = (queue as any).removeUpcomingItem.bind(queue);
  (queue as any).removeUpcomingItem = async (item: any) =>
    (item.sent ? { ok: false, reason: 'already-playing' } : removeItem(item));
  try {
    const out = await queue.removeUpcomingBlock('blk');
    assert.deepEqual({ removed: out.removed, kept: out.kept }, { removed: 3, kept: 1 });
    assert.equal(queue.upcoming.length, 1, 'the committed track stays and plays out');
  } finally {
    (queue as any).removeUpcomingItem = removeItem;
  }
});

test('cancelling an unknown block reports nothing rather than throwing', async () => {
  reset();
  assert.deepEqual(await queue.removeUpcomingBlock('nope'), { removed: 0, kept: 0, label: null });
});

// ── the listener behind a block ────────────────────────────────────────────

test('the wait clause says nothing when the forecast is unknown or short', () => {
  assert.equal(requestWaitClause({ waitSec: null }), '');
  assert.equal(requestWaitClause({ waitSec: REQUEST_WAIT_NOTICE_SEC - 1 }), '');
  assert.equal(requestWaitClause({ waitSec: Number.NaN }), '');
});

test('the wait clause names the block when one is ahead', () => {
  const line = requestWaitClause({ waitSec: 40 * 60, blockLabel: 'Immunity — Jon Hopkins' });
  assert.match(line, /Immunity — Jon Hopkins/);
  assert.match(line, /about 40 minutes/);
});

test('with no block ahead it still gives the number', () => {
  const line = requestWaitClause({ waitSec: 12 * 60 });
  assert.doesNotMatch(line, /right through/);
  assert.match(line, /about 12 minutes/);
});

// Rounded and hedged, because it IS a forecast — but never rounded into
// vagueness, which is the whole point of telling the listener at all.
test('the wait reads as minutes, then as hours and minutes', () => {
  assert.equal(formatWait(59), '1 minute');
  assert.equal(formatWait(12 * 60), '12 minutes');
  assert.equal(formatWait(89 * 60), '89 minutes');
  assert.equal(formatWait(90 * 60), '1 hour 30 minutes');
  assert.equal(formatWait(120 * 60), '2 hours');
});

// airForecastSec is deliberately NOT remainingUntilItemAirs: that one walks the
// SENT chain only, which is right for the drain (nothing unsent is ever ahead
// of the item it asks about) and wrong here, where an unsent album track in
// front of a listener is very much going to play first.
test('the forecast counts unsent items ahead, which the drain clock does not', async () => {
  reset();
  queue.current = {
    track: { id: 'onair', title: 'On air', duration: 100 },
    startedAt: new Date().toISOString(),
  } as any;
  for (let n = 1; n <= 3; n++) {
    await queue.push({
      track: { id: `b${n}`, title: `T${n}`, artist: 'A', duration: 200 },
      requestedBy: 'studio', operator: true, allowDuplicate: true,
      block: { id: 'blk', label: 'Rec — A', index: n, size: 3 },
    });
  }
  await queue.push({ track: { id: 'req', title: 'Req', duration: 200 }, requestedBy: 'alice' });
  const request = queue.upcoming[queue.upcoming.length - 1];

  const forecast = queue.airForecastSec(request)!;
  // ~100s left on air plus three 200s album tracks.
  assert.ok(forecast > 690 && forecast <= 700, `forecast was ${forecast}`);
  // The drain's clock sees none of them, because none has been sent.
  assert.ok(queue.remainingUntilItemAirs(request)! < 101);
});

// A bed is written straight to next.txt by maybePushBed and is never an
// `upcoming` entry, so a walk of the queue sails past it — the #1574 failure,
// where an uncounted bed put the show-boundary cut a whole link late. Both of
// this forecast's callers are understated by the miss in the direction that
// matters: the listener is told their request is closer than it is, and
// runsPastShowChange under-reports the overrun.
test('the forecast counts a bed queued ahead, which is not an upcoming entry', async () => {
  reset();
  queue.current = {
    track: { id: 'onair', title: 'On air', duration: 100 },
    startedAt: new Date().toISOString(),
  } as any;
  await queue.push({ track: { id: 'link', title: 'Linked', duration: 200 }, requestedBy: null, aiPicked: true });
  await queue.push({ track: { id: 'req', title: 'Req', duration: 200 }, requestedBy: 'alice' });
  const request = queue.upcoming[1];

  const bare = queue.airForecastSec(request)!;
  // The bed is decided at the item's own drain, so mark it sent and bedded the
  // way drainToLiquidsoap does.
  queue.upcoming[0].sent = true;
  queue.upcoming[0].bedDelaySec = 24;
  assert.equal(queue.airForecastSec(request), bare + 24, 'the link\'s bed pushes the request back');
});

// The item's own bed plays immediately ahead of it, so it delays this item too.
test("the forecast counts the item's OWN bed", async () => {
  reset();
  queue.current = {
    track: { id: 'onair', title: 'On air', duration: 100 },
    startedAt: new Date().toISOString(),
  } as any;
  await queue.push({ track: { id: 'req', title: 'Req', duration: 200 }, requestedBy: 'alice' });
  const request = queue.upcoming[0];
  const bare = queue.airForecastSec(request)!;
  request.bedDelaySec = 18;
  assert.equal(queue.airForecastSec(request), bare + 18);
});

test('the forecast counts pause-and-talk silence hidden ahead of a request', async () => {
  reset();
  queue.current = {
    track: { id: 'onair', title: 'On air', duration: 100 },
    startedAt: new Date().toISOString(),
  } as any;
  await queue.push({ track: { id: 'next', title: 'Next', duration: 200 }, requestedBy: null });
  await queue.push({ track: { id: 'req', title: 'Req', duration: 200 }, requestedBy: 'alice' });
  const request = queue.upcoming[1];
  const bare = queue.airForecastSec(request)!;
  queue.upcoming[0].sent = true;
  queue.upcoming[0].pauseDelaySec = 34.75;
  assert.equal(queue.airForecastSec(request), bare + 34.75);
});

test("the forecast counts the item's OWN pause-and-talk delay", async () => {
  reset();
  queue.current = {
    track: { id: 'onair', title: 'On air', duration: 100 },
    startedAt: new Date().toISOString(),
  } as any;
  await queue.push({ track: { id: 'req', title: 'Req', duration: 200 }, requestedBy: 'alice' });
  const request = queue.upcoming[0];
  const bare = queue.airForecastSec(request)!;
  request.pauseDelaySec = 19;
  assert.equal(queue.airForecastSec(request), bare + 19);
});

// An UNSENT item ahead has had no bed pushed — the decision happens at ITS
// drain — so a zero contribution is correct rather than a miss. Pinned so the
// next person to touch bedDelayBeforeItemAirs does not "fix" the sent gate.
test('an unsent item ahead contributes no bed, because it has none yet', async () => {
  reset();
  queue.current = {
    track: { id: 'onair', title: 'On air', duration: 100 },
    startedAt: new Date().toISOString(),
  } as any;
  await queue.push({ track: { id: 'link', title: 'Linked', duration: 200 }, requestedBy: null, aiPicked: true });
  await queue.push({ track: { id: 'req', title: 'Req', duration: 200 }, requestedBy: 'alice' });
  const request = queue.upcoming[1];
  const bare = queue.airForecastSec(request)!;
  // Stamped but never drained: nothing is in next.txt for it.
  queue.upcoming[0].sent = false;
  queue.upcoming[0].bedDelaySec = 24;
  assert.equal(queue.airForecastSec(request), bare);
});

test('the forecast is null when the clock is unknowable', async () => {
  reset();
  queue.current = null;
  await queue.push({ track: { id: 'req', title: 'Req', duration: 200 }, requestedBy: 'alice' });
  assert.equal(queue.airForecastSec(queue.upcoming[0]), null);
});
