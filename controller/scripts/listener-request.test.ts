// The shared listener-request chokepoint (broadcast/listener-request.ts).
//
// A typed `POST /request` and a Hotline Grant are two doors onto one set of
// rules. These pin the rules as the chokepoint states them, so a Grant cannot
// drift from a typed request: the admission gates and their order, the push's
// named outcomes, and the per-track refusals.
//
// Run: npm test -- listener-request

import assert from 'node:assert/strict';
import test from 'node:test';
import { queue } from '../src/broadcast/queue.js';
import * as settings from '../src/settings.js';
import {
  admitListenerRequest, noteRequestFrom, onRepeatCooldown, pushListenerRequest, requests,
} from '../src/broadcast/listener-request.js';

(queue as any).persist = () => {};
(queue as any).drainToLiquidsoap = async () => {};

function reset() {
  queue.upcoming = [];
  queue.current = null;
  requests.clear();
}

const track = (n: number) => ({ id: `t-${n}`, title: `Track ${n}`, artist: `Artist ${n}` });

test('admission refuses a full line with queue-full, counting requests still resolving', async () => {
  reset();
  await settings.update({ requests: { maxPending: 2, cooldownSec: 0, onePendingPerIp: false } } as never);
  await queue.push({ track: track(1), requestedBy: 'alice' });
  requests.set('r1', { id: 'r1', status: 'pending', createdAt: Date.now() });
  const verdict = admitListenerRequest(queue, '10.0.0.1');
  assert.equal(verdict.ok, false);
  assert.equal(!verdict.ok && verdict.reason, 'queue-full');
});

test('admission holds an IP whose last request is still queued', async () => {
  reset();
  await settings.update({ requests: { maxPending: 6, cooldownSec: 0, onePendingPerIp: true } } as never);
  await queue.push({ track: track(2), requestedBy: 'bob' });
  noteRequestFrom('10.0.0.2', { status: 'resolved', pick: { id: 't-2' }, createdAt: Date.now() });
  const verdict = admitListenerRequest(queue, '10.0.0.2');
  assert.equal(!verdict.ok && verdict.reason, 'one-pending');
  // A refused resolution queued nothing for them, so it never holds. (A fresh
  // IP: the attempt above already spent .2's per-IP cooldown.)
  noteRequestFrom('10.0.0.3', { status: 'resolved', refused: true, pick: { id: 't-2' }, createdAt: Date.now() });
  assert.equal(admitListenerRequest(queue, '10.0.0.3').ok, true);
});

test('the push names a duplicate as already-queued, never as a fresh queue slot', async () => {
  reset();
  assert.equal((await pushListenerRequest(queue, { track: track(3), requestedBy: 'carol' })).status, 'queued');
  assert.equal((await pushListenerRequest(queue, { track: track(3), requestedBy: 'dave' })).status, 'already-queued');
});

test('the repeat cooldown is off at zero and keyed on the track id', async () => {
  reset();
  await settings.update({ requests: { repeatCooldownMin: 0 } } as never);
  assert.equal(onRepeatCooldown(queue, 't-4'), false);
  assert.equal(onRepeatCooldown(queue, null), false);
});
