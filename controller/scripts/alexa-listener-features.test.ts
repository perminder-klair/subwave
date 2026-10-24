import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AlexaListenerFeatureService,
  rankAlexaCandidates,
  type AlexaListenerTrack,
} from '../src/alexa/listener-features.js';

const current: AlexaListenerTrack = {
  id: 'current', title: 'Current Song', artist: 'The Artist', album: 'Current Album',
};

test('similarity selection excludes the current and recent tracks and breaks ties by id', async () => {
  const service = new AlexaListenerFeatureService({
    nowPlaying: () => current,
    recentTracks: () => [{ id: 'recent', title: 'Recent', artist: 'Other', album: null }],
    similarCandidates: () => [
      { id: 'current', title: 'Current Song', artist: 'The Artist' },
      { id: 'recent', title: 'Recent', artist: 'Other', similarity: 0.99 },
      { id: 'track-z', title: 'Zed', artist: 'Other', similarity: 0.8 },
      { id: 'track-a', title: 'Able', artist: 'Other', similarity: 0.8 },
    ],
  });

  const result = await service.moreLikeThis();
  assert.equal(result.kind, 'ok');
  assert.equal(result.kind === 'ok' ? result.value.id : null, 'track-a');
});

test('another-by-artist filters non-artist candidates and recent history', async () => {
  const service = new AlexaListenerFeatureService({
    nowPlaying: () => current,
    recentTracks: () => [{ id: 'recent', title: 'Recent', artist: 'The Artist', album: null }],
    artistCandidates: () => [
      { id: 'different', title: 'Different', artist: 'Other Artist' },
      { id: 'recent', title: 'Recent', artist: 'The Artist' },
      { id: 'track-b', title: 'Bravo', artist: 'The Artist' },
    ],
  });

  const result = await service.anotherByArtist();
  assert.equal(result.kind, 'ok');
  assert.equal(result.kind === 'ok' ? result.value.id : null, 'track-b');
});

test('recent tracks preserve newest-first order and honor the requested limit', async () => {
  const service = new AlexaListenerFeatureService({
    recentTracks: () => [
      { id: 'one', title: 'One', artist: 'A', album: null },
      { id: 'two', title: 'Two', artist: 'B', album: null },
      { id: 'three', title: 'Three', artist: 'C', album: null },
    ],
  });

  assert.deepEqual((await service.recentTracks(2)).map(track => track.id), ['one', 'two']);
});

test('selection reports no current track instead of searching blindly', async () => {
  const service = new AlexaListenerFeatureService({ nowPlaying: () => null });
  assert.deepEqual(await service.moreLikeThis(), { kind: 'no-current' });
  assert.deepEqual(await service.anotherByArtist(), { kind: 'no-current' });
  assert.deepEqual(await service.trackDetails(), { kind: 'no-current' });
});

test('track details report missing metadata as null rather than inventing values', async () => {
  const service = new AlexaListenerFeatureService({
    nowPlaying: () => ({ id: 'details', title: 'Details', artist: 'Artist', album: null }),
    trackMetadata: () => ({ year: 0, genre: '', language: '' }),
  });

  const result = await service.trackDetails();
  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') return;
  assert.equal(result.value.album, null);
  assert.equal(result.value.year, null);
  assert.equal(result.value.genre, null);
  assert.equal(result.value.language, null);
});

test('the exported candidate ranker is deterministic for equal scores', () => {
  const ranked = rankAlexaCandidates([
    { id: 'b', title: 'B', artist: 'Artist', similarity: 1 },
    { id: 'a', title: 'A', artist: 'Artist', similarity: 1 },
  ]);
  assert.deepEqual(ranked.map(track => track.id), ['a', 'b']);
});
