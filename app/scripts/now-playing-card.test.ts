// The lock-screen card goes out when its strings change or a new track item
// was loaded, and never on a plain status flip (#2143): each card re-downloads
// the artwork, and a load resets the native card to the item's placeholders.

import assert from 'node:assert/strict';
import test from 'node:test';
import { sendsCard, type SentCard } from '../src/lib/now-playing-card.ts';

const SONG: SentCard = {
  title: 'Windowlicker',
  artist: 'Aphex Twin',
  album: 'Windowlicker',
  artwork: 'https://radio.example/api/cover/song-1',
  item: 1,
};

/** Replay refreshes the way useNowPlayingInfo makes them, counting cards. */
function cardsSent(refreshes: SentCard[]): number {
  let last: SentCard | null = null;
  let cards = 0;
  for (const next of refreshes) {
    if (sendsCard(last, next)) cards++;
    last = next;
  }
  return cards;
}

test('the first refresh after tune-in sends the card', () => {
  assert.equal(sendsCard(null, SONG), true);
});

test('a status flip, a foreground flip or the 30s re-anchor sends progress only', () => {
  assert.equal(sendsCard(SONG, { ...SONG }), false);
  // connecting → playing → connecting → playing on one item: one card.
  assert.equal(cardsSent([SONG, { ...SONG }, { ...SONG }, { ...SONG }]), 1);
});

test('a reload sends the card again with the strings unchanged, since the load reset it', () => {
  assert.equal(sendsCard(SONG, { ...SONG, item: 2 }), true);
  // Tune in, a buffering stall, then a watchdog reload and its status flips.
  assert.equal(cardsSent([
    SONG, { ...SONG }, { ...SONG },
    { ...SONG, item: 2 }, { ...SONG, item: 2 }, { ...SONG, item: 2 },
  ]), 2);
});

test('a new song, or the persona swap while the DJ talks, sends the card', () => {
  assert.equal(sendsCard(SONG, { ...SONG, title: 'Flim' }), true);
  assert.equal(sendsCard(SONG, { ...SONG, album: 'Come to Daddy' }), true);
  assert.equal(sendsCard(SONG, {
    ...SONG, artist: 'Nova', artwork: 'https://radio.example/api/personas/nova.png',
  }), true);
  assert.equal(sendsCard(SONG, { ...SONG, artwork: undefined }), true);
});
