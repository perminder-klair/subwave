// Saved stations for Siri, Shortcuts and Spotlight (src/lib/station-store.ts):
// the list they are given, finding a station by the id they hand back, and
// usePlayer keeping a stream a switch from Siri already started.

import assert from 'node:assert/strict';
import test from 'node:test';
import { findSavedStation, stationsForSiri, streamBelongsTo } from '../src/lib/station-store.ts';

const recents = [
  { url: 'https://radio.example.com', name: 'Night Shift', lastUsed: 2 },
  { url: 'https://www.getsubwave.com', name: 'SUB/WAVE', lastUsed: 1 },
];

test('Siri gets names and credential-free bases, never a login', () => {
  const list = stationsForSiri([
    ...recents,
    { url: 'https://dj:secret@private.example.com/', name: 'Private' },
  ]);
  assert.deepEqual(list, [
    { id: 'https://radio.example.com', name: 'Night Shift' },
    { id: 'https://www.getsubwave.com', name: 'SUB/WAVE' },
    { id: 'https://private.example.com', name: 'Private' },
  ]);
  assert.ok(!JSON.stringify(list).includes('secret'));
});

test('a station saved without a name goes by its host, and a repeat is listed once', () => {
  assert.deepEqual(
    stationsForSiri([
      { url: 'https://radio.example.com', name: '  ' },
      { url: 'https://radio.example.com/', name: 'Night Shift' },
    ]),
    [{ id: 'https://radio.example.com', name: 'radio.example.com' }],
  );
});

test('a station is found by the id Siri hands back, trailing slash or not', () => {
  assert.equal(findSavedStation(recents, 'https://radio.example.com')?.name, 'Night Shift');
  assert.equal(findSavedStation(recents, 'https://radio.example.com/')?.name, 'Night Shift');
  assert.equal(findSavedStation(recents, 'https://elsewhere.example.com'), null);
});

test('a stream belongs to the station whose base it is built on', () => {
  const base = 'https://radio.example.com';
  assert.ok(streamBelongsTo('https://radio.example.com/stream.mp3', base));
  assert.ok(streamBelongsTo('https://radio.example.com/stream.aac?auth=pw', base));
  assert.ok(streamBelongsTo('https://radio.example.com/stream.mp3', 'https://dj:pw@radio.example.com/'));
  assert.ok(!streamBelongsTo('https://www.getsubwave.com/stream.mp3', base));
  // A host that merely starts the same is a different station.
  assert.ok(!streamBelongsTo('https://radio.example.com.evil.net/stream.mp3', base));
});
