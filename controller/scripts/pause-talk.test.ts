import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PAUSE_TALK_ARM_MAX_AGE_MS,
  PAUSE_TALK_EXIT_CROSS_SEC,
  PAUSE_TALK_RELEASE_LATENCY_MS,
  PAUSE_TALK_SAFETY_MS,
  pauseTalkArmExpired,
  pauseTimelineDelayMs,
  resolveTalkPlacement,
  releaseDelayMs,
  silenceDurationMs,
  wantsPauseTalk,
} from '../src/broadcast/pause-talk.js';

test('pause-talk is an explicit show opt-in with an inclusive duration threshold', () => {
  assert.equal(wantsPauseTalk({ enabled: true, eligible: true, clipMs: 20_000, minSeconds: 20 }), true);
  assert.equal(wantsPauseTalk({ enabled: false, eligible: true, clipMs: 20_000, minSeconds: 20 }), false);
  assert.equal(wantsPauseTalk({ enabled: true, eligible: false, clipMs: 20_000, minSeconds: 20 }), false);
  assert.equal(wantsPauseTalk({ enabled: true, eligible: true, clipMs: 19_999, minSeconds: 20 }), false);
  assert.equal(wantsPauseTalk({ enabled: true, eligible: true, clipMs: null, minSeconds: 20 }), false);
});

// The predecessor's crossfade is mixed over the head of the silence, so it has
// to be paid for in the silence AND waited out before the mic opens. Budget it
// in one place only and the segment plays under a fading song.
test('the silence covers the incoming crossfade, the release latency and the exit ramp', () => {
  const voiceWindowMs = 31_250;
  const incomingCrossMs = 10_000;   // station default crossfadeDuration
  assert.equal(
    silenceDurationMs({ voiceWindowMs, incomingCrossMs }),
    incomingCrossMs
      + PAUSE_TALK_RELEASE_LATENCY_MS
      + voiceWindowMs
      + PAUSE_TALK_EXIT_CROSS_SEC * 1000
      + PAUSE_TALK_SAFETY_MS,
  );
});

test('silence budgeting never goes negative on nonsense inputs', () => {
  const floor = PAUSE_TALK_RELEASE_LATENCY_MS + PAUSE_TALK_EXIT_CROSS_SEC * 1000 + PAUSE_TALK_SAFETY_MS;
  assert.equal(silenceDurationMs({ voiceWindowMs: -1, incomingCrossMs: 0 }), floor);
  assert.equal(silenceDurationMs({ voiceWindowMs: 0, incomingCrossMs: NaN }), floor);
});

test('the queue forecast counts only the pause time added to the music timeline', () => {
  // The incoming and exit crossfades overlap adjacent tracks; the remainder is
  // the real delay before the following song starts.
  assert.equal(pauseTimelineDelayMs({
    silenceMs: 46_250,
    incomingCrossMs: 10_000,
    exitCrossMs: 1_500,
  }), 34_750);
  assert.equal(pauseTimelineDelayMs({ silenceMs: 1_000, incomingCrossMs: 800, exitCrossMs: 800 }), 0);
});

test('a qualifying pause-and-talk break outranks ordinary between-track placement', () => {
  assert.equal(resolveTalkPlacement({ pauseTalk: true, talkAir: 'next-track' }), 'pause-talk');
  assert.equal(resolveTalkPlacement({ pauseTalk: false, talkAir: 'next-track' }), 'next-track');
  assert.equal(resolveTalkPlacement({ pauseTalk: false, talkAir: 'immediate' }), 'immediate');
});

// Measured from the silence's own start, so the marker poll that already
// elapsed is credited rather than paid for a second time.
test('the release delay credits the latency already spent spotting the marker', () => {
  assert.equal(releaseDelayMs({ incomingCrossMs: 10_000, elapsedSinceStartMs: 1_500 }), 8_500);
  assert.equal(releaseDelayMs({ incomingCrossMs: 10_000, elapsedSinceStartMs: 0 }), 10_000);
  // A slow tick that already outlived the crossfade opens the mic immediately.
  assert.equal(releaseDelayMs({ incomingCrossMs: 10_000, elapsedSinceStartMs: 12_000 }), 0);
  assert.equal(releaseDelayMs({ incomingCrossMs: 0, elapsedSinceStartMs: 0 }), 0);
  assert.equal(releaseDelayMs({ incomingCrossMs: NaN, elapsedSinceStartMs: NaN }), 0);
});

// A committed break holds the one pending-voice slot against every other
// path, so the bound on that commitment is what keeps a silence the mixer
// never played from wedging the station's scheduled speech.
test('a committed break expires so a lost silence cannot pin the pending slot', () => {
  const now = 1_000_000_000_000;
  assert.equal(pauseTalkArmExpired(now, now), false);
  assert.equal(pauseTalkArmExpired(now - PAUSE_TALK_ARM_MAX_AGE_MS, now), false);
  assert.equal(pauseTalkArmExpired(now - PAUSE_TALK_ARM_MAX_AGE_MS - 1, now), true);
  // An unstamped arm is treated as expired: it cannot be shown to be live.
  assert.equal(pauseTalkArmExpired(undefined, now), true);
  assert.equal(pauseTalkArmExpired(null, now), true);
});
