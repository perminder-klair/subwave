// Which mixer channel a spoken clip takes (queue/pure.voiceChannelFor).
//
//   'intro' → intro.txt → intro_queue → LIGHT duck (p=0.30)
//   'say'   → say.txt   → voice_queue → HEAVY duck (p=0.22)
//
// The rule is what the clip plays OVER, not what kind it is. It lived inline in
// two places (announce, airIntro) that already disagreed once #1465 gave beds a
// third input, so it is pure and pinned here instead.
//
// The load-bearing case is the LAST one. `overBed` is the caller's observation
// that a bed is on air — onBedStarted saw the marker — and NOT `item.bedded`,
// which only means a bed URI reached next.txt. A pushed item is handed over,
// never playable: an unresolvable URI is dropped in silence and a marker missed
// by more than BED_MARKER_FRESH_MS never fires the event. Both leave the SONG
// starting with the line still to air, over its opening — which is a song to
// talk over, and must take the heavy duck like any other request intro.
// Inferring the channel from the flag would hand that failure, the one #1465
// exists to prevent, a LIGHTER duck than it had before the feature landed.

import assert from 'node:assert/strict';
import test from 'node:test';

import { voiceChannelFor } from '../src/broadcast/queue/pure.js';

test('a link talks up the song that just started, so the song stays up', () => {
  assert.equal(voiceChannelFor('link'), 'intro');
});

test('everything else is meant to dominate', () => {
  for (const kind of ['dj-speak', 'announcement', 'ident', 'weather', 'hourly']) {
    assert.equal(voiceChannelFor(kind), 'say', kind);
  }
  // An absent kind is airIntro's `item.introKind || 'dj-speak'` fallback shape.
  assert.equal(voiceChannelFor(null), 'say');
  assert.equal(voiceChannelFor(undefined), 'say');
});

test('a clip airing ON a bed takes the light duck whatever its kind (#1465)', () => {
  // The heavy duck would push the bed — an instrumental put there for exactly
  // this purpose — down to a hiss.
  assert.equal(voiceChannelFor('dj-speak', { overBed: true }), 'intro');
  assert.equal(voiceChannelFor('link', { overBed: true }), 'intro');
});

test('omitting overBed means no bed — the pre-#1465 answer for every kind', () => {
  for (const kind of ['link', 'dj-speak', 'announcement']) {
    assert.equal(voiceChannelFor(kind), voiceChannelFor(kind, { overBed: false }), kind);
  }
});

test('a bed that was QUEUED but never aired keeps the heavy duck', () => {
  // The regression this signature exists to prevent: item.bedded is true here
  // and the caller still says false, because onBedStarted never fired. The line
  // is airing over the song itself, so it gets the song-dominating duck.
  const item = { introKind: 'dj-speak', bedded: true, requestedBy: 'alex' };
  assert.equal(voiceChannelFor(item.introKind, { overBed: false }), 'say');
});
