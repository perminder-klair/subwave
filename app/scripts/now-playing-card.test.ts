// The lock-screen card goes out when a new track item was loaded, that item
// first plays or something the card carries changes, and never on a later
// status flip (#2143): a load resets the native card to the item's
// placeholders. Its cover waits for the first `playing`, so the one fetch each
// item gets runs on a link the stream has proved (#2162).

import assert from 'node:assert/strict';
import test from 'node:test';
import { cardArtwork, hasPlayed, sendsCard, type SentCard } from '../src/lib/now-playing-card.ts';

const SONG: SentCard = {
  title: 'Windowlicker',
  artist: 'Aphex Twin',
  album: 'Windowlicker',
  artwork: 'https://radio.example/api/cover/song-1',
  item: 1,
  played: true,
};
const NEXT_SONG = { title: 'Flim', artwork: 'https://radio.example/api/cover/song-2' };

type Refresh = Omit<SentCard, 'played'> & { playing: boolean };
interface Costs { cards: number; iosCovers: number; androidCovers: number }

const connecting = (item: number): Refresh => ({ ...SONG, item, playing: false });
const playing = (item: number): Refresh => ({ ...SONG, item, playing: true });

/** Replay refreshes the way useNowPlayingInfo makes them, and count what each
 *  platform does with them. iOS downloads the cover of every card that has
 *  one (Metadata.swift). Android refuses a card until an item is loaded
 *  (MusicModule, item 0 here) and drops one matching the last since the load
 *  (MusicService); only the rest reach Coil. */
function costs(refreshes: Refresh[]): Costs {
  const total: Costs = { cards: 0, iosCovers: 0, androidCovers: 0 };
  let last: SentCard | null = null;
  let onAndroid: string | null = null;
  for (const { playing: isPlaying, ...card } of refreshes) {
    const next: SentCard = { ...card, played: hasPlayed(last, card.item, isPlaying) };
    if (last?.item !== next.item) onAndroid = null;
    if (sendsCard(last, next)) {
      const artwork = cardArtwork(next);
      const sent = JSON.stringify([next.title, next.artist, next.album, artwork]);
      total.cards++;
      if (artwork) total.iosCovers++;
      if (next.item > 0 && sent !== onAndroid) {
        if (artwork) total.androidCovers++;
        onAndroid = sent;
      }
    }
    last = next;
  }
  return total;
}

// The card that goes out before the load, the load's, and the first `playing`.
const TUNE_IN = [connecting(0), connecting(1), playing(1)];

test('the first refresh after tune-in sends the card', () => {
  assert.equal(sendsCard(null, SONG), true);
});

test('a card carries no cover until its item has played, and then only the one it has', () => {
  assert.equal(cardArtwork({ ...SONG, played: false }), '');
  assert.equal(cardArtwork(SONG), SONG.artwork);
  assert.equal(cardArtwork({ ...SONG, artwork: undefined }), '');
});

test('a tune-in sends the strings before the load and on it, and the cover once', () => {
  assert.deepEqual(costs(TUNE_IN), { cards: 3, iosCovers: 1, androidCovers: 1 });
});

test('a reconnect sends the strings on the load and the cover once, on the first playing', () => {
  assert.equal(sendsCard(SONG, { ...SONG, item: 2 }), true);
  const stallThenReload = [connecting(1), connecting(2), playing(2)];
  assert.deepEqual(costs([...TUNE_IN, ...stallThenReload]), {
    cards: 3 + 2, iosCovers: 1 + 1, androidCovers: 1 + 1,
  });
  // The cover is spent: stalls on the new item send nothing.
  assert.deepEqual(costs([...TUNE_IN, ...stallThenReload, connecting(2), playing(2)]), {
    cards: 3 + 2, iosCovers: 1 + 1, androidCovers: 1 + 1,
  });
});

test('n reloads with only the last playing cost one cover', () => {
  assert.deepEqual(costs([
    ...TUNE_IN,
    connecting(1), connecting(2), connecting(3), connecting(4), playing(4),
  ]), { cards: 3 + 3 + 1, iosCovers: 1 + 1, androidCovers: 1 + 1 });
});

test('a stream that hangs fetches no cover at all', () => {
  assert.deepEqual(costs([connecting(0), connecting(1), connecting(2), connecting(3)]), {
    cards: 4, iosCovers: 0, androidCovers: 0,
  });
});

test('a plain stall with no reload sends no card', () => {
  assert.deepEqual(costs([
    ...TUNE_IN,
    connecting(1), playing(1),
    connecting(1), playing(1),
  ]), costs(TUNE_IN));
});

test('a status flip, a foreground flip or the 30s re-anchor sends progress only', () => {
  assert.equal(sendsCard(SONG, { ...SONG }), false);
  // A foreground flip re-runs the refresh with the status unchanged.
  assert.deepEqual(costs([...TUNE_IN, playing(1), playing(1)]), costs(TUNE_IN));
});

test('a foreground flip before the first playing neither sends a card nor spends the cover', () => {
  assert.deepEqual(costs([connecting(2), connecting(2), connecting(2)]), {
    cards: 1, iosCovers: 0, androidCovers: 0,
  });
  assert.deepEqual(costs([connecting(2), connecting(2), playing(2)]), {
    cards: 2, iosCovers: 1, androidCovers: 1,
  });
});

test('a song change before the first playing sends its strings, and only the new cover', () => {
  assert.deepEqual(costs([
    connecting(2),
    { ...connecting(2), ...NEXT_SONG },
    { ...playing(2), ...NEXT_SONG },
  ]), { cards: 3, iosCovers: 1, androidCovers: 1 });
});

test('a cover that changes before the first playing sends nothing, since no card carries it', () => {
  const persona = { artwork: 'https://radio.example/api/personas/nova.png' };
  assert.equal(sendsCard({ ...SONG, played: false }, { ...SONG, ...persona, played: false }), false);
  assert.deepEqual(costs([connecting(2), { ...connecting(2), ...persona }]), {
    cards: 1, iosCovers: 0, androidCovers: 0,
  });
});

test('a persona swap before the first playing sends the name, and the avatar waits', () => {
  const persona = { artist: 'Nova', artwork: 'https://radio.example/api/personas/nova.png' };
  assert.equal(sendsCard({ ...SONG, played: false }, { ...SONG, ...persona, played: false }), true);
  assert.deepEqual(costs([
    connecting(2),
    { ...connecting(2), ...persona },
    { ...playing(2), ...persona },
  ]), { cards: 3, iosCovers: 1, androidCovers: 1 });
});

test('a song change after the first playing sends the whole card, stalled or not', () => {
  assert.deepEqual(costs([...TUNE_IN, { ...playing(1), ...NEXT_SONG }]), {
    cards: 3 + 1, iosCovers: 1 + 1, androidCovers: 1 + 1,
  });
  assert.deepEqual(costs([...TUNE_IN, connecting(1), { ...connecting(1), ...NEXT_SONG }]), {
    cards: 3 + 1, iosCovers: 1 + 1, androidCovers: 1 + 1,
  });
});

test('the app opening on audio already playing sends the whole card once', () => {
  assert.deepEqual(costs([playing(1), connecting(1), playing(1)]), {
    cards: 1, iosCovers: 1, androidCovers: 1,
  });
});

test('a load that first shows up already playing sends the whole card once', () => {
  // React can batch the item event and the `playing` into one refresh.
  assert.deepEqual(costs([connecting(1), playing(2), connecting(2), playing(2)]), {
    cards: 2, iosCovers: 1, androidCovers: 1,
  });
});

test('a song with no cover fetches nothing', () => {
  const none = { artwork: undefined };
  assert.deepEqual(costs([{ ...connecting(1), ...none }, { ...playing(1), ...none }]), {
    cards: 2, iosCovers: 0, androidCovers: 0,
  });
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
