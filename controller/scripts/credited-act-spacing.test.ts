// The spacing guards keyed every credit on its LEAD act alone, so a shared
// act in second position walked past them. Seen live: "B Mohit & Karan Aujla",
// "Karan Aujla & Jay Trak", "Daljit Chahal & Karan Aujla" inside 13 minutes,
// the last two back to back. A credit's tail act now counts when the library
// knows it as an act of its own, which keeps "&" band names whole.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { artistRootKey, creditedActKeys, creditedActNames, creditInRoots, setKnownActsProvider } from '../src/music/recency.js';
import { alternativeCandidates, artistGuardCause } from '../src/broadcast/dj-agent/artist-guard.js';
import { queue } from '../src/broadcast/queue.js';

// The library's act index: the lead of every credit it holds.
const LIBRARY = ['Karan Aujla', 'Amantej Hundal & Karan Aujla', 'AP Dhillon', 'Karan Aujla & Jay Trak', 'Daljit Chahal & Karan Aujla', 'B Mohit & Karan Aujla',
  'Sly & the Family Stone', 'Earth, Wind & Fire', 'Hall & Oates', 'Shubh', 'Jazzy B'];
const known = new Set(LIBRARY.map(c => artistRootKey(c)));
const useLibrary = () => setKnownActsProvider(() => known);
afterEach(() => setKnownActsProvider(null));

test('a known tail act is credited; an unknown one is not', () => {
  useLibrary();
  assert.deepEqual(creditedActKeys('Daljit Chahal & Karan Aujla'), ['daljit chahal', 'karan aujla']);
  assert.deepEqual(creditedActKeys('Intense (feat. Karan Aujla)'), ['intense', 'karan aujla'], 'a featured act too');
  assert.deepEqual(creditedActKeys('Hall & Oates'), ['hall'], '"oates" leads nothing here, so the duo stays one key');
  assert.deepEqual(creditedActKeys('Sly & the Family Stone'), ['sly & the family stone'], '"& the" never splits');
  assert.deepEqual(creditedActKeys('Earth, Wind & Fire'), ['earth, wind'],
    'no tail of a band name leads a credit, so nothing extra is counted');
});

test('with no act index the guards are lead-only, exactly as before', () => {
  assert.deepEqual(creditedActKeys('Daljit Chahal & Karan Aujla'), ['daljit chahal']);
  assert.equal(creditInRoots('Daljit Chahal & Karan Aujla', new Set(['karan aujla'])), false);
});

test('the live repeat: a second-position act is caught from either side', () => {
  useLibrary();
  // Pick side: the window holds Karan Aujla's own credit.
  assert.equal(artistGuardCause('daljit chahal', '', new Set(['karan aujla']), 'Daljit Chahal & Karan Aujla'), 'recent');
  // Window side: the window was built from a credit he only appears second on.
  (queue as any).upcoming = [];
  (queue as any).current = { track: { id: 'CUR', title: 'Thaa Karke', artist: 'B Mohit & Karan Aujla' } };
  (queue as any)._recentPlays = [];
  const window = queue.neighbourArtistRoots(5);
  assert.ok(window.has('karan aujla'), 'the window carries the tail act');
  assert.equal(artistGuardCause('karan aujla', '', window, 'Karan Aujla & Jay Trak'), 'recent');
  assert.equal(artistGuardCause('shubh', '', window, 'Shubh'), null, 'an unrelated act still passes');
});

test('a guard re-pick steps around a tail-act repeat too', () => {
  useLibrary();
  const seen: [string, any][] = [
    ['a', { id: 'a', title: 'Math', artist: 'Daljit Chahal & Karan Aujla' }],
    ['b', { id: 'b', title: 'Buckle Up', artist: 'Shubh' }],
  ];
  const { alt, dropped } = alternativeCandidates(seen, 'jazzy b', new Set(['karan aujla']));
  assert.deepEqual([...alt.keys()], ['b']);
  assert.equal(dropped, 1);
});

// The Agentic pick event names these, so the model steps around an act the
// guard will refuse instead of proposing it for a re-pick (seen live: Karan
// Aujla proposed twice more after "Amantej Hundal & Karan Aujla" aired).
test('the pick event names each act the guard counts, in display form', () => {
  useLibrary();
  assert.deepEqual(creditedActNames('Amantej Hundal & Karan Aujla'), ['Amantej Hundal', 'Karan Aujla']);
  assert.deepEqual(creditedActNames('Intense (feat. Karan Aujla)'), ['Intense', 'Karan Aujla']);
  assert.deepEqual(creditedActNames('AP Dhillon, Shinda Kahlon & Gminxr'), ['AP Dhillon, Shinda Kahlon'],
    'the lead group stays whole; an unknown tail act is not named');
  assert.deepEqual(creditedActNames('Sly & the Family Stone'), ['Sly & the Family Stone']);
  assert.deepEqual(creditedActNames('Hall & Oates'), ['Hall']);
  setKnownActsProvider(null);
  assert.deepEqual(creditedActNames('Amantej Hundal & Karan Aujla'), ['Amantej Hundal & Karan Aujla'],
    'no act index: the whole credit, as before');
});

test('the named window agrees with the guard window and dedupes across credits', () => {
  useLibrary();
  (queue as any).upcoming = [];
  (queue as any).current = { track: { id: 'CUR', title: 'Few Days', artist: 'Amantej Hundal & Karan Aujla' } };
  (queue as any)._recentPlays = [
    { id: 'P1', title: 'Wavy', artist: 'Karan Aujla & Jay Trak', endedAt: '2026-10-14T13:40:00.000Z' },
    { id: 'P2', title: 'Old Town', artist: 'Shubh', endedAt: '2026-10-14T13:37:00.000Z' },
  ];
  const named = queue.neighbourArtistActs(5);
  assert.deepEqual(named, ['Amantej Hundal', 'Karan Aujla', 'Shubh'], 'Karan Aujla once; Jay Trak leads nothing');
  const window = queue.neighbourArtistRoots(5);
  for (const name of named) assert.ok(window.has(artistRootKey(name)), `${name} is in the guard window`);
});
