// The call the web player's stall watchdog makes when its timer fires. The first
// fire keeps the #1232 rule; every look after it follows the clock alone, so a
// stream that stopped without an event still reconnects, and a healthy or
// OS-paused one never does. The hook around it needs a DOM, so the `ended`
// listener and the timers are proved in real browsers, not here.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HAVE_FUTURE_DATA, watchdogCall, type MediaClock } from './streamWatchdog';

const el = (over: Partial<MediaClock> = {}): MediaClock => ({
  paused: false, ended: false, readyState: 4, currentTime: 10, ...over,
});

test('HAVE_FUTURE_DATA is the media element constant', () => {
  assert.equal(HAVE_FUTURE_DATA, 3);
});

test('first fire: a clock that moved on a playing element is left alone', () => {
  assert.equal(watchdogCall(el({ currentTime: 10.2 }), 10, false), 'keep-watching');
  assert.equal(watchdogCall(el({ currentTime: 10.2, readyState: 3 }), 10, false), 'keep-watching');
});

test('first fire: a stopped clock, a starved element or a paused one reconnects, as it always has', () => {
  assert.equal(watchdogCall(el({ currentTime: 10 }), 10, false), 'reconnect');
  assert.equal(watchdogCall(el({ currentTime: 10.2, readyState: 2 }), 10, false), 'reconnect');
  assert.equal(watchdogCall(el({ currentTime: 10.2, paused: true }), 10, false), 'reconnect');
});

test('first fire after ended reconnects: the backoff timer the ended listener arms', () => {
  assert.equal(watchdogCall(el({ paused: true, ended: true }), 10, false), 'reconnect');
});

test('a fresh connection that never got going reconnects', () => {
  assert.equal(watchdogCall(el({ currentTime: 0, readyState: 0 }), 0, false), 'reconnect');
});

test('later looks: the clock crept past the stall, then stopped with no event (Firefox)', () => {
  // stalled at 3.9, the first fire saw 4.07 and looked again from there.
  assert.equal(watchdogCall(el({ currentTime: 4.07 }), 3.9, false), 'keep-watching');
  assert.equal(watchdogCall(el({ currentTime: 4.07 }), 4.07, true), 'reconnect');
});

test('later looks: a clock still moving keeps a healthy listener off the reconnect path', () => {
  let armedAt = 10;
  for (let i = 0; i < 100; i += 1) {
    const now = armedAt + 5;
    assert.equal(watchdogCall(el({ currentTime: now }), armedAt, true), 'keep-watching');
    armedAt = now;
  }
});

test('later looks: a clock that moved reads as moving whatever readyState says', () => {
  // A dip to HAVE_CURRENT_DATA with its `waiting` still queued is not a dead stream,
  // and `waiting` re-arms a first fire if it is one.
  assert.equal(watchdogCall(el({ currentTime: 10.2, readyState: 2 }), 10, true), 'keep-watching');
});

test('later looks: an element the OS paused is never restarted', () => {
  assert.equal(watchdogCall(el({ paused: true, currentTime: 10 }), 10, true), 'stand-down');
  assert.equal(watchdogCall(el({ paused: true, currentTime: 10.2 }), 10, true), 'stand-down');
});

test('later looks: ended is paused too, but it reconnects', () => {
  assert.equal(watchdogCall(el({ paused: true, ended: true, currentTime: 10 }), 10, true), 'reconnect');
  assert.equal(watchdogCall(el({ paused: true, ended: true, currentTime: 10.2 }), 10, true), 'reconnect');
});
