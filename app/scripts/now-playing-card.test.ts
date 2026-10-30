// The lock-screen card goes out when its strings change, a new track item was
// loaded or that item first plays, and never on a later status flip (#2143,
// #2162): each card re-downloads the artwork, a load resets the native card to
// the item's placeholders, and a cover that failed on a bad link gets one more
// try once the stream proves the link.

import assert from 'node:assert/strict';
import test from 'node:test';
import { hasPlayed, sendsCard, type SentCard } from '../src/lib/now-playing-card.ts';

const SONG: SentCard = {
  title: 'Windowlicker',
  artist: 'Aphex Twin',
  album: 'Windowlicker',
  artwork: 'https://radio.example/api/cover/song-1',
  item: 1,
  played: true,
};

type Refresh = Omit<SentCard, 'played'> & { playing: boolean };

const connecting = (item: number): Refresh => ({ ...SONG, item, playing: false });
const playing = (item: number): Refresh => ({ ...SONG, item, playing: true });

/** Replay refreshes the way useNowPlayingInfo makes them, counting cards. */
function cardsSent(refreshes: Refresh[]): number {
  let last: SentCard | null = null;
  let cards = 0;
  for (const { playing: isPlaying, ...card } of refreshes) {
    const next: SentCard = { ...card, played: hasPlayed(last, card.item, isPlaying) };
    if (sendsCard(last, next)) cards++;
    last = next;
  }
  return cards;
}

// The card that goes out before the load, the load's, and the first `playing`.
const TUNE_IN = [connecting(0), connecting(1), playing(1)];

test('the first refresh after tune-in sends the card', () => {
  assert.equal(sendsCard(null, SONG), true);
});

test('a tune-in costs one card more than the two it already sent', () => {
  assert.equal(cardsSent(TUNE_IN), 3);
});

test('audio already playing at the first refresh needs no second card', () => {
  assert.equal(cardsSent([playing(1), connecting(1), playing(1)]), 1);
});

test('a status flip, a foreground flip or the 30s re-anchor sends progress only', () => {
  assert.equal(sendsCard(SONG, { ...SONG }), false);
  // A foreground flip re-runs the refresh with the status unchanged.
  assert.equal(cardsSent([...TUNE_IN, playing(1), playing(1)]), 3);
});

test('a plain stall with no reload sends no card', () => {
  assert.equal(cardsSent([
    ...TUNE_IN,
    connecting(1), playing(1),
    connecting(1), playing(1),
  ]), 3);
});

test('a reconnect sends the card on the load and once more on the first playing', () => {
  assert.equal(sendsCard(SONG, { ...SONG, item: 2 }), true);
  const stallThenReload = [connecting(1), connecting(2), playing(2)];
  assert.equal(cardsSent([...TUNE_IN, ...stallThenReload]), 3 + 2);
  // The retry is spent: stalls on the new item send nothing.
  assert.equal(cardsSent([
    ...TUNE_IN, ...stallThenReload,
    connecting(2), playing(2),
  ]), 3 + 2);
});

test('a foreground flip before the first playing neither sends the card nor spends the retry', () => {
  assert.equal(cardsSent([connecting(2), connecting(2), connecting(2)]), 1);
  assert.equal(cardsSent([connecting(2), connecting(2), playing(2)]), 2);
});

test('reloads that never play cost no retry until one does', () => {
  assert.equal(cardsSent([
    ...TUNE_IN,
    connecting(1), connecting(2), connecting(3), connecting(4), playing(4),
  ]), 3 + 3 + 1);
});

test('a load that first shows up already playing proved its link, so gets one card', () => {
  // React can batch the item event and the `playing` into one refresh.
  assert.equal(cardsSent([connecting(1), playing(2)]), 2);
  assert.equal(cardsSent([connecting(1), playing(2), connecting(2), playing(2)]), 2);
});

test('a song change before the first playing leaves the retry for the new cover', () => {
  const flim = { ...SONG, title: 'Flim', item: 2 };
  assert.equal(cardsSent([
    connecting(2),
    { ...flim, playing: false },
    { ...flim, playing: true },
  ]), 3);
});

test('hasPlayed holds through a stall and starts over with a new item or a tune-out', () => {
  assert.equal(hasPlayed(null, 1, false), false);
  assert.equal(hasPlayed(null, 1, true), true);
  assert.equal(hasPlayed({ ...SONG, played: false }, 1, true), true);
  assert.equal(hasPlayed({ ...SONG, played: false }, 1, false), false);
  assert.equal(hasPlayed(SONG, 1, false), true);
  assert.equal(hasPlayed(SONG, 2, false), false);
});

test('a new song, or the persona swap while the DJ talks, sends the card', () => {
  assert.equal(sendsCard(SONG, { ...SONG, title: 'Flim' }), true);
  assert.equal(sendsCard(SONG, { ...SONG, album: 'Come to Daddy' }), true);
  assert.equal(sendsCard(SONG, {
    ...SONG, artist: 'Nova', artwork: 'https://radio.example/api/personas/nova.png',
  }), true);
  assert.equal(sendsCard(SONG, { ...SONG, artwork: undefined }), true);
});
