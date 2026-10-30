// Saved stations for Siri, Shortcuts and Spotlight (src/lib/station-store.ts):
// the list they are given, finding a station by the id they hand back, and
// usePlayer keeping a stream a switch from Siri already started.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findSavedStation,
  matchStations,
  stationsForSiri,
  streamBelongsTo,
} from '../src/lib/station-store.ts';

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

test('a spoken station name matches however speech spells it', () => {
  const stations = [
    { id: 'https://radio.example.com', name: 'ChillWave Radio' },
    { id: 'https://night.example.com', name: 'Night Shift' },
    { id: 'https://cafe.example.com', name: 'Café Ñandú' },
  ];
  const ids = (term: string) => matchStations(stations, term).map((s) => s.id);
  assert.deepEqual(ids('chill wave radio'), ['https://radio.example.com']);
  assert.deepEqual(ids('chillwave'), ['https://radio.example.com']);
  assert.deepEqual(ids('the night shift station'), ['https://night.example.com']);
  assert.deepEqual(ids('night shift'), ['https://night.example.com']);
  assert.deepEqual(ids('cafe nandu'), ['https://cafe.example.com']);
});

test('a generic or too-short term names no station', () => {
  const stations = [{ id: 'https://radio.example.com', name: 'ChillWave Radio' }];
  for (const term of ['', 'radio', 'Radio!', 'some music', 'SUB/WAVE', 'ch']) {
    assert.deepEqual(matchStations(stations, term), [], term);
  }
});

test('an exact name wins over one that only contains the term', () => {
  const stations = [
    { id: 'https://a.example.com', name: 'Night Shift Radio' },
    { id: 'https://b.example.com', name: 'Night Shift' },
  ];
  assert.deepEqual(
    matchStations(stations, 'night shift').map((s) => s.id),
    ['https://b.example.com'],
  );
});
