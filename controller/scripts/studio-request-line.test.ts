// An operator's studio push must not consume a listener's request slot.
//
// `POST /dj/queue-track` pushes `requestedBy: 'studio'`, and it has to: that
// field is the discriminator four air-path behaviours key off — the #447 length
// cap (queue.ts `maxDurationSec`), the show-boundary cut (`resolveBoundaryCut`),
// the bed's `BedReason` and the sub-crossfade warning — and an explicit
// operator action wants every one of those exemptions.
//
// `routes/request.ts` then counted the same truthiness as "a listener is
// waiting in line" (`upcoming.filter(i => i.requestedBy).length` against
// `settings.requests.maxPending`, default 6). So six presses of Queue on air
// shut the listener request line for as long as those six tracks took to play,
// answering every listener "The request queue's full — try again in a few
// minutes" with nothing in the refusal, the response or the booth log naming
// the real cause. FR 4's album block would have made that the normal case: one
// press, a whole record, the line shut for the length of the album.
//
// The fix is a second field rather than a second meaning on the first one, so
// the two questions stay separable — and `queue.pendingListenerRequests()` is
// the one place that asks the second.
//
// Run: npm test -- studio-request-line

import assert from 'node:assert/strict';
import test from 'node:test';
import { queue } from '../src/broadcast/queue.js';

// push() persists a JSON snapshot and kicks the drain (TTS render + the handoff
// file Liquidsoap polls). Neither is part of the contract here, and both would
// touch disk or block on a poll timeout in a bare test process — the same
// neutralisation scripts/request-dedup.test.ts uses.
(queue as any).persist = () => {};
(queue as any).drainToLiquidsoap = async () => {};

function reset() {
  queue.upcoming = [];
  queue.current = null;
}

const listenerTrack = (n: number) => ({ id: `listener-${n}`, title: `Listener ${n}`, artist: 'Someone' });
const studioTrack = (n: number) => ({ id: `studio-${n}`, title: `Studio ${n}`, artist: 'Operator' });

test('a listener request counts toward the pending line', async () => {
  reset();
  await queue.push({ track: listenerTrack(1), requestedBy: 'alice' });
  await queue.push({ track: listenerTrack(2), requestedBy: 'bob' });
  assert.equal(queue.pendingListenerRequests(), 2);
});

test('an AI pick does not — it is nobody waiting', async () => {
  reset();
  await queue.push({ track: listenerTrack(1), requestedBy: null, aiPicked: true });
  assert.equal(queue.pendingListenerRequests(), 0);
});

test('a studio push does not, even though it carries requestedBy', async () => {
  reset();
  // Exactly what POST /dj/queue-track sends.
  await queue.push({ track: studioTrack(1), requestedBy: 'studio', operator: true, allowDuplicate: true });
  assert.equal(queue.upcoming.length, 1, 'the track is queued as normal');
  assert.equal(queue.upcoming[0].requestedBy, 'studio', 'and keeps the air-path discriminator');
  assert.equal(queue.pendingListenerRequests(), 0, 'but is not a listener in the line');
});

test('the bug: a full block of studio pushes leaves the request line open', async () => {
  reset();
  // maxPending's default is 6. Before the fix these six shut the line.
  for (let n = 0; n < 6; n++) {
    await queue.push({ track: studioTrack(n), requestedBy: 'studio', operator: true, allowDuplicate: true });
  }
  assert.equal(queue.upcoming.length, 6);
  assert.equal(queue.pendingListenerRequests(), 0, 'six operator presses are not six pending requests');
});

test('the two are counted independently in one queue', async () => {
  reset();
  await queue.push({ track: studioTrack(1), requestedBy: 'studio', operator: true, allowDuplicate: true });
  await queue.push({ track: listenerTrack(1), requestedBy: 'alice' });
  await queue.push({ track: studioTrack(2), requestedBy: 'studio', operator: true, allowDuplicate: true });
  await queue.push({ track: listenerTrack(2), requestedBy: 'bob' });
  assert.equal(queue.upcoming.length, 4);
  assert.equal(queue.pendingListenerRequests(), 2, 'only the two listener requests');
});

// The cap bounds how deep the LINE gets, not how far down it Liquidsoap has
// reached: a request already handed over is still a listener waiting to hear
// their song, so narrowing this to `!sent` would under-count and let the queue
// grow past maxPending.
test('a sent-but-unaired listener request is still pending', async () => {
  reset();
  await queue.push({ track: listenerTrack(1), requestedBy: 'alice' });
  queue.upcoming[0].sent = true;
  assert.equal(queue.pendingListenerRequests(), 1);
});

// maxPending bounds what is still WAITING. A request that reached air has been
// served, and counting it would hold a slot shut for the length of the track.
test('a request on air is no longer pending', async () => {
  reset();
  await queue.push({ track: listenerTrack(1), requestedBy: 'alice' });
  queue.current = queue.upcoming.shift()!;
  assert.equal(queue.pendingListenerRequests(), 0);
});

// The field is absent on every item in a queue.json written before it existed.
// Absent must read as "not known to be an operator push" — i.e. the old
// behaviour — rather than as false-y-therefore-listener in one place and
// operator in another. A recovered snapshot only survives 2h (queue.recover's
// cutoff), so this degrades and then heals on its own.
test('an item recovered without the field counts as it did before', () => {
  reset();
  queue.upcoming = [
    { track: studioTrack(1), requestedBy: 'studio', queuedAt: new Date().toISOString() },
  ] as any;
  assert.equal(queue.pendingListenerRequests(), 1);
});
