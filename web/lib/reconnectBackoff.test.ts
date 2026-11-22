// The web player's reconnect backoff, driven through the sequences a real
// connection goes through. The hook around it needs a DOM, so the listeners and
// timers are proved in real browsers, not here.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NO_BACKOFF,
  PLAYED_MAX_MS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  STAYED_UP_MS,
  connectionClosed,
  connectionStarted,
  reachedPlaying,
  type Backoff,
} from './reconnectBackoff';
import { WATCHDOG_MS } from './streamWatchdog';

/** One listener's timeline, called the way usePlayer calls it. */
function listener(start: Backoff = NO_BACKOFF) {
  let state = start;
  let now = 1_000_000;
  return {
    get state() { return state; },
    /** A new connection that reaches `playing` and plays for `ms`. */
    plays(ms: number) {
      state = connectionStarted(state);
      state = reachedPlaying(state, now);
      now += ms;
    },
    /** A new connection that is refused before it plays. */
    refused() {
      state = connectionStarted(state);
    },
    wait(ms: number) {
      now += ms;
    },
    playingAgain() {
      state = reachedPlaying(state, now);
    },
    /** `error` or `ended`: returns the delay, and waits it out. */
    closes() {
      const { delayMs, next } = connectionClosed(state, now);
      state = next;
      now += delayMs;
      return delayMs;
    },
  };
}

test('the curve: quick first retry, doubling to a minute, and it stays there', () => {
  const l = listener();
  const delays = Array.from({ length: 10 }, () => {
    l.refused();
    return l.closes();
  });
  assert.deepEqual(delays, [500, 1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  assert.equal(RECONNECT_BASE_MS, 500);
  assert.equal(RECONNECT_MAX_MS, 60_000);
});

test('a connection that plays for a moment and closes grows the backoff, to 16 s', () => {
  for (const played of [250, 1000, STAYED_UP_MS - 1]) {
    const l = listener();
    const delays = Array.from({ length: 8 }, () => {
      l.plays(played);
      return l.closes();
    });
    assert.deepEqual(delays, [500, 1000, 2000, 4000, 8000, 16_000, 16_000, 16_000], `played ${played}`);
  }
  assert.equal(PLAYED_MAX_MS, 16_000);
});

test('the count climbs past the 16 s ceiling, so a refused connect takes the full curve', () => {
  const l = listener();
  for (let i = 0; i < 7; i += 1) {
    l.plays(1000);
    l.closes();
  }
  l.refused();
  assert.equal(l.closes(), 60_000);
  l.plays(1000);
  assert.equal(l.closes(), 16_000);
});

test('a connection that stays up keeps the first reconnect quick, every time', () => {
  for (const played of [STAYED_UP_MS, 5000, 3_600_000]) {
    const l = listener();
    for (let i = 0; i < 6; i += 1) {
      l.plays(played);
      assert.equal(l.closes(), 500, `played ${played}`);
    }
  }
});

test('the line sits between the measured rows', () => {
  // The tests around this one read STAYED_UP_MS, so they follow it wherever it moves.
  // A 3 s cut must grow; a 4.2 s cut has sound 90% of the time and must not.
  const cutAfter = (played: number) => {
    const l = listener({ retries: 3, heldRetries: 0, playingSince: null });
    l.plays(played);
    return l.closes();
  };
  assert.equal(cutAfter(3000), 4000);
  assert.equal(cutAfter(4200), 500);
});

test('one outage on a listener who has been up: as quick as ever, then the curve', () => {
  const l = listener();
  l.plays(3_600_000);
  const delays = [l.closes()];
  for (let i = 0; i < 3; i += 1) {
    l.refused();
    delays.push(l.closes());
  }
  assert.deepEqual(delays, [500, 1000, 2000, 4000]);
});

test('a refused connect never inherits the last connection\'s playing', () => {
  // Reading the old stamp would call every refused connect a success: 500 ms forever.
  const l = listener();
  l.plays(3_600_000);
  l.closes();
  l.refused();
  assert.equal(l.closes(), 1000);
  l.refused();
  assert.equal(l.closes(), 2000);
});

test('a connection that stays up clears a count built by earlier ones', () => {
  const l = listener();
  for (let i = 0; i < 5; i += 1) {
    l.plays(1000);
    l.closes();
  }
  l.plays(STAYED_UP_MS);
  assert.equal(l.closes(), 500);
});

test('a long outage: the wait outlives it as it always has, and a good connection clears it', () => {
  const l = listener();
  for (let i = 0; i < 10; i += 1) {
    l.refused();
    l.closes();
  }
  assert.equal(l.state.retries, 10);
  l.plays(STAYED_UP_MS);
  assert.equal(l.closes(), 500);
});

test('a connection that dies right after a long outage waits 16 s, not the outage\'s minute', () => {
  const l = listener();
  for (let i = 0; i < 10; i += 1) {
    l.refused();
    l.closes();
  }
  l.plays(1000);
  assert.equal(l.closes(), 16_000);
});

test('the watchdog replacing a connection leaves the reset standing', () => {
  // A source that flaps: refused connects, a short play that stalls, and the
  // watchdog's reconnect, which never reports a close. The next refusal starts
  // the curve over, so these listeners never climb to a minute.
  const l = listener();
  for (let i = 0; i < 20; i += 1) {
    l.refused();
    assert.equal(l.closes(), 500);
    l.refused();
    assert.equal(l.closes(), 1000);
    l.plays(1400);
    l.wait(WATCHDOG_MS);
  }
});

test('only the first playing of a connection starts its clock', () => {
  // A slow link: `waiting` and `playing` every few seconds on one connection.
  const l = listener();
  l.plays(STAYED_UP_MS);
  l.wait(1000);
  l.playingAgain();
  l.wait(100);
  assert.equal(l.closes(), 500);
});

test('a later playing does not reset what an early close took back', () => {
  const l = listener({ retries: 3, heldRetries: 0, playingSince: null });
  l.plays(1000);
  l.playingAgain();
  assert.equal(l.closes(), 4000);
});

test('Firefox reports one reset twice, error then ended: one failure, one delay', () => {
  const l = listener({ retries: 2, heldRetries: 0, playingSince: null });
  l.plays(1000);
  const atError = connectionClosed(l.state, 1_000_000 + 1000);
  const atEnded = connectionClosed(atError.next, 1_000_000 + 1500);
  assert.equal(atError.delayMs, 2000);
  assert.equal(atEnded.delayMs, 2000);
  assert.equal(atEnded.next.retries, 3);
});

test('Firefox on a listener who has been up: both reports are the first retry', () => {
  const l = listener();
  l.plays(3_600_000);
  const atError = connectionClosed(l.state, 1_000_000 + 3_600_000);
  const atEnded = connectionClosed(atError.next, 1_000_000 + 3_622_000);
  assert.equal(atError.delayMs, 500);
  assert.equal(atEnded.delayMs, 500);
  assert.equal(atEnded.next.retries, 1);
});

test('Firefox: a connection that crosses the line during play-out counts as up', () => {
  // The reset arrives 1 s in, and the buffer plays on for 22 s before `ended`.
  const l = listener({ retries: 4, heldRetries: 0, playingSince: null });
  l.plays(1000);
  const atError = connectionClosed(l.state, 1_000_000 + 1000);
  const atEnded = connectionClosed(atError.next, 1_000_000 + 23_000);
  assert.equal(atError.delayMs, 8000);
  assert.equal(atEnded.delayMs, 500);
});

test('a clock stepped backwards never reads as a connection that stayed up', () => {
  const l = listener({ retries: 3, heldRetries: 0, playingSince: null });
  l.plays(0);
  const { delayMs } = connectionClosed(l.state, 1_000_000 - 3_600_000);
  assert.equal(delayMs, 4000);
});

test('the threshold stays below the watchdog, so anything it replaced counts as up', () => {
  assert.ok(STAYED_UP_MS <= WATCHDOG_MS);
});
