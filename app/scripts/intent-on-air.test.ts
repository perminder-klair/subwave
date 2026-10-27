// "What's playing" and "like this song" from Siri: which track a tuned-in
// listener is hearing (src/lib/heard-track.ts, the rule useStationFeed
// promotes tracks by), and what Siri says about it
// (src/intents/on-air-reply.ts).

import assert from 'node:assert/strict';
import test from 'node:test';
import { audibleAt, heardTrack, leadMsFrom } from '../src/lib/heard-track.ts';
import {
  likeReply,
  likeTarget,
  whatsPlayingReply,
  type OnAirSnapshot,
} from '../src/intents/on-air-reply.ts';

const live = { title: 'Teardrop', artist: 'Massive Attack', subsonic_id: 'tear' };
const previous = { title: 'Unfinished Sympathy', artist: 'Massive Attack', subsonic_id: 'unfin' };

test('the stream buffer is clamped to 0–60 s, and absent when the station sent none', () => {
  assert.equal(leadMsFrom(22), 22_000);
  assert.equal(leadMsFrom(-5), 0);
  assert.equal(leadMsFrom(600), 60_000);
  assert.equal(leadMsFrom(undefined), null);
  assert.equal(leadMsFrom(Number.NaN), null);
  assert.equal(audibleAt(1_000, 22_000), 23_000);
});

test('for the buffer’s length after a change, the listener still hears the previous track', () => {
  const at = (now: number) => heardTrack({ live, previous, liveStartMs: 100_000, leadMs: 22_000, now });
  assert.equal(at(110_000), previous);
  assert.equal(at(121_999), previous);
  assert.equal(at(122_000), live);
});

test('with no live-edge stamp, or nothing before it, the live track is the answer', () => {
  assert.equal(heardTrack({ live, previous, liveStartMs: null, leadMs: 22_000, now: 0 }), live);
  assert.equal(heardTrack({ live, previous: null, liveStartMs: 100_000, leadMs: 22_000, now: 110_000 }), live);
});

const snap = (over: Partial<OnAirSnapshot> = {}): OnAirSnapshot => ({
  reachable: true,
  online: true,
  track: live,
  ...over,
});

test('what’s playing names the track, or says why there is none', () => {
  assert.deepEqual(whatsPlayingReply('SUB/WAVE', snap()), {
    ok: true,
    message: 'On SUB/WAVE: Teardrop by Massive Attack.',
  });
  assert.deepEqual(whatsPlayingReply('SUB/WAVE', snap({ track: { title: 'Teardrop' } })), {
    ok: true,
    message: 'On SUB/WAVE: Teardrop.',
  });
  assert.equal(whatsPlayingReply('SUB/WAVE', snap({ online: false })).message, 'SUB/WAVE is off air right now.');
  assert.equal(
    whatsPlayingReply('SUB/WAVE', snap({ track: null })).message,
    "Nothing's playing on SUB/WAVE right now.",
  );
  assert.equal(whatsPlayingReply('SUB/WAVE', snap({ reachable: false })).ok, false);
});

test('a like needs a song id: a jingle or a spoken link never reaches POST /like', () => {
  assert.deepEqual(likeTarget('SUB/WAVE', snap()), { songId: 'tear' });
  assert.deepEqual(likeTarget('SUB/WAVE', snap({ track: { title: 'Station ID' } })), {
    ok: false,
    message: 'Nothing likeable on air right now.',
  });
  assert.equal((likeTarget('SUB/WAVE', snap({ reachable: false })) as { ok: boolean }).ok, false);
});

test('POST /like’s answer is said back, refusals in the station’s own words', () => {
  assert.deepEqual(likeReply('SUB/WAVE', live, { ok: true, count: 3 }), {
    ok: true,
    message: 'Liked Teardrop by Massive Attack.',
  });
  assert.deepEqual(likeReply('SUB/WAVE', live, { ok: true, alreadyLiked: true }), {
    ok: true,
    message: "You've already liked Teardrop by Massive Attack.",
  });
  assert.deepEqual(likeReply('SUB/WAVE', live, { error: 'That track just ended' }), {
    ok: false,
    message: 'That track just ended.',
  });
  assert.deepEqual(likeReply('SUB/WAVE', live, { error: 'Likes are disabled on this station.' }), {
    ok: false,
    message: 'Likes are disabled on this station.',
  });
  assert.equal(likeReply('SUB/WAVE', live, {}).ok, false);
  assert.equal(likeReply('SUB/WAVE', live, null).ok, false);
});
