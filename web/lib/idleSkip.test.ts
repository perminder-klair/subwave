// The web player's skip over a woken station's stale idle silence (#2072).
// While idle the mounts serve blank(), so a fresh connection's burst is
// stream.bufferSeconds of silence ahead of the programme it wakes. The player
// may close up on the live edge through that silence, down to a 5s cushion,
// but never past the first music on either side of the pause, including when
// the mounts burst more than is advertised.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_BURST_SECONDS, MIN_SKIP_SECONDS, MUSIC_MARGIN_SECONDS, SKIP_CUSHION_SECONDS, idleSkipSeconds, type IdleSkipInput } from './idleSkip';

const BUFFER = 22;
// One connection on the local clock: the stream request, its first audio, and
// a /state read sent after it that answered 60ms later.
const AT = { requestedAt: 1_000, firstAudioAt: 1_150, readSentAt: 1_200, readReceivedAt: 1_260, now: 1_260 };
const LONG_PAUSE = 10 * 60_000;

const input = (over: Partial<IdleSkipInput> = {}): IdleSkipInput => ({
  bufferSeconds: BUFFER,
  window: { startedMsAgo: LONG_PAUSE, endedMsAgo: null },
  ...AT,
  ...over,
});
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≉ ${expected}`);

test('the constants are the shipped ones', () => {
  assert.equal(SKIP_CUSHION_SECONDS, 5);
  assert.equal(MUSIC_MARGIN_SECONDS, 1);
  assert.equal(MIN_SKIP_SECONDS, 1);
  // The entrypoint's clamp on the rendered burst, through the settings bound.
  assert.equal(MAX_BURST_SECONDS, 60);
});

test('a fully silent burst keeps only the cushion', () => {
  // Still paused when the read was answered: this listener's own connection is
  // what wakes it, so all 22s ahead of them are silence.
  near(idleSkipSeconds(input()), BUFFER - SKIP_CUSHION_SECONDS);
  // A wake the other side of the read changes nothing while it is recent.
  near(idleSkipSeconds(input({ window: { startedMsAgo: LONG_PAUSE, endedMsAgo: 400 } })), 17);
});

test('a partly-music burst stops short of the music', () => {
  // Someone else woke the station 10s before the read: the last ~10s of the
  // burst is programme. The listener stays a margin behind its first note.
  const skip = idleSkipSeconds(input({ window: { startedMsAgo: LONG_PAUSE, endedMsAgo: 10_000 } }));
  near(skip, BUFFER - (10.06 + MUSIC_MARGIN_SECONDS));
  // Woken 3s before: the music sits inside the cushion anyway.
  near(idleSkipSeconds(input({ window: { startedMsAgo: LONG_PAUSE, endedMsAgo: 3_000 } })), 17);
  // Woken 16.5s before: only the head of the burst is silence.
  near(idleSkipSeconds(input({ window: { startedMsAgo: LONG_PAUSE, endedMsAgo: 16_500 } })), BUFFER - 17.56);
});

test('a station that is not waking skips nothing', () => {
  assert.equal(idleSkipSeconds(input({ window: null })), 0, 'never paused since boot');
  assert.equal(idleSkipSeconds(input({ window: undefined })), 0, 'an older controller');
  assert.equal(idleSkipSeconds(input({ window: { startedMsAgo: 3 * LONG_PAUSE, endedMsAgo: LONG_PAUSE } })), 0);
  // Woken just long enough ago that what is left is under the floor.
  assert.equal(idleSkipSeconds(input({ window: { startedMsAgo: LONG_PAUSE, endedMsAgo: 20_500 } })), 0);
  assert.equal(idleSkipSeconds(input({ window: { startedMsAgo: LONG_PAUSE, endedMsAgo: 22_000 } })), 0);
});

test('a pause that began inside the burst skips nothing: its head is music', () => {
  // The pause must predate the connection by the longest burst the mounts can
  // render plus the margin. It is timed from the read's arrival back to the
  // stream request (260ms), so a slow read can only make it look younger.
  near(idleSkipSeconds(input({ window: { startedMsAgo: 61_260, endedMsAgo: null } })), 17);
  assert.equal(idleSkipSeconds(input({ window: { startedMsAgo: 61_159, endedMsAgo: null } })), 0);
  assert.equal(idleSkipSeconds(input({ window: { startedMsAgo: 2_000, endedMsAgo: null } })), 0);
  assert.equal(idleSkipSeconds(input({ window: { startedMsAgo: 20_000, endedMsAgo: 5_000 } })), 0);
});

test('a tune-in 30s into a pause on a default station skips nothing', () => {
  // A 22s burst is all silence by then, but the planner cannot know the mounts
  // burst only 22s (next test), so it waits out the longest burst they can.
  assert.equal(idleSkipSeconds(input({ window: { startedMsAgo: 30_260, endedMsAgo: null } })), 0);
});

test('a burst longer than advertised never fast-forwards the music before the pause', () => {
  // bufferSeconds lowered from 22 to 10 and saved, the broadcast not yet
  // restarted: /now-playing advertises 10 while Icecast still bursts 22s. A
  // tune-in 15s into the pause gets 7s of the frozen track ahead of the
  // silence, and the shed starts at the head of the burst.
  const lowered = { bufferSeconds: 10, window: { startedMsAgo: 15_260, endedMsAgo: null } };
  assert.equal(idleSkipSeconds(input(lowered)), 0);
  // Any burst the mounts can render: the setting tops out at MAX_BURST_SECONDS.
  assert.equal(idleSkipSeconds(input({ ...lowered, window: { startedMsAgo: MAX_BURST_SECONDS * 1000, endedMsAgo: null } })), 0);
  // Once the pause predates that, the advertised figure sizes the skip as before.
  near(idleSkipSeconds(input({ ...lowered, window: { startedMsAgo: 61_260, endedMsAgo: null } })), 10 - SKIP_CUSHION_SECONDS);
});

test('a stale /state read skips nothing, and a late answer skips less', () => {
  // The 5s feed poll, or any read sent before this connection's first audio,
  // cannot vouch for what the burst holds.
  assert.equal(idleSkipSeconds(input({ readSentAt: 900, readReceivedAt: 960, now: 1_260 })), 0);
  assert.equal(idleSkipSeconds(input({ readSentAt: 1_149 })), 0);
  // A fresh read still ages: the station may have woken the moment it was
  // answered, so every second since is a second of music behind the listener.
  near(idleSkipSeconds(input({ now: AT.readSentAt + 14_000 })), BUFFER - 15);
  assert.equal(idleSkipSeconds(input({ now: AT.readSentAt + 20_500 })), 0);
  // A slow answer counts from when the read was sent, not when it came back.
  near(idleSkipSeconds(input({ readReceivedAt: 9_200, now: 9_200 })), BUFFER - 9);
});

test('a buffer at or below the cushion skips nothing', () => {
  for (const bufferSeconds of [0, 4, SKIP_CUSHION_SECONDS, 5.5]) {
    assert.equal(idleSkipSeconds(input({ bufferSeconds })), 0, String(bufferSeconds));
  }
  near(idleSkipSeconds(input({ bufferSeconds: 6.5 })), 1.5);
  for (const bufferSeconds of [null, undefined, Number.NaN, Infinity]) {
    assert.equal(idleSkipSeconds(input({ bufferSeconds })), 0, String(bufferSeconds));
  }
});

test('clock skew between server and client cannot move the answer', () => {
  // The server sends ages on its own clock and the client differences its own
  // readings, so a client clock hours (or seconds) off from the server's, or a
  // server clock off from true time, changes nothing.
  for (const window of [
    { startedMsAgo: LONG_PAUSE, endedMsAgo: null },
    { startedMsAgo: LONG_PAUSE, endedMsAgo: 10_000 },
    { startedMsAgo: 61_000, endedMsAgo: null },
  ]) {
    const base = idleSkipSeconds(input({ window }));
    for (const skew of [3_600_000, -3_600_000, 37_000, -37_000]) {
      const shifted = Object.fromEntries(Object.entries(AT).map(([k, v]) => [k, v + skew])) as typeof AT;
      assert.equal(idleSkipSeconds(input({ window, ...shifted })), base, `skew ${skew}`);
    }
  }
});

test('malformed or out-of-order inputs skip nothing', () => {
  for (const window of [
    { startedMsAgo: -1, endedMsAgo: null },
    { startedMsAgo: LONG_PAUSE, endedMsAgo: -5 },
    { startedMsAgo: 10_000, endedMsAgo: 20_000 }, // resumed before it paused
    { startedMsAgo: Number.NaN, endedMsAgo: null },
    { startedMsAgo: '600000', endedMsAgo: null },
    { endedMsAgo: null },
  ]) {
    assert.equal(idleSkipSeconds(input({ window: window as never })), 0, JSON.stringify(window));
  }
  assert.equal(idleSkipSeconds(input({ firstAudioAt: 900 })), 0, 'audio before the request');
  assert.equal(idleSkipSeconds(input({ readReceivedAt: 1_100 })), 0, 'answer before the read');
  assert.equal(idleSkipSeconds(input({ now: 1_000 })), 0, 'now before the answer');
  assert.equal(idleSkipSeconds(input({ now: Number.NaN })), 0);
});
