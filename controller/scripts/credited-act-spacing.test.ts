// The spacing guards keyed every credit on its LEAD act alone, so a shared
// act in second position walked past them. Seen live: "B Mohit & Karan Aujla",
// "Karan Aujla & Jay Trak", "Daljit Chahal & Karan Aujla" inside 13 minutes,
// the last two back to back. A credit's tail act now counts when the library
// knows it as an act of its own, which keeps "&" band names whole.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { artistRootKey, creditedActKeys, creditInRoots, setKnownActsProvider } from '../src/music/recency.js';
import { alternativeCandidates, artistGuardCause } from '../src/broadcast/dj-agent/artist-guard.js';
import { queue } from '../src/broadcast/queue.js';

// The library's act index: the lead of every credit it holds.
const LIBRARY = ['Karan Aujla', 'Karan Aujla & Jay Trak', 'Daljit Chahal & Karan Aujla', 'B Mohit & Karan Aujla',
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
