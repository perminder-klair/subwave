// Strict listener request matching. Run: `npm test -- request-strict`.

import assert from 'node:assert/strict';
import {
  strictFailureMessage,
  strictRequestTarget,
  pickStrictCandidate,
  strictRequestSatisfied,
} from '../src/routes/request-strict.js';

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failures++;
    console.error(`  ✗ ${name}\n      ${err?.message || err}`);
  }
}

const midnight = { id: '1', title: 'Midnight City', artist: 'M83' };
const intro = { id: '2', title: 'Intro', artist: 'M83' };
const cover = { id: '3', title: 'Midnight City', artist: 'The Midnight' };

console.log('strict request matching:');

test('title and artist request only accepts the exact library hit', () => {
  const target = strictRequestTarget({
    search_terms: ['Midnight City', 'M83'],
    artist: 'M83',
  });

  assert.deepEqual(target, { title: 'Midnight City', artist: 'M83', specific: true });
  assert.equal(pickStrictCandidate(target, [intro, cover, midnight]), midnight);
  assert.equal(strictRequestSatisfied(target, intro), false);
  assert.equal(strictRequestSatisfied(target, cover), false);
  assert.equal(strictRequestSatisfied(target, midnight), true);
});

test('artist-only request is strict about the artist but not the song title', () => {
  const target = strictRequestTarget({
    search_terms: ['M83'],
    artist: 'M83',
  });

  assert.deepEqual(target, { title: null, artist: 'M83', specific: true });
  assert.equal(pickStrictCandidate(target, [cover, intro]), intro);
  assert.equal(strictRequestSatisfied(target, cover), false);
  assert.equal(strictRequestSatisfied(target, intro), true);
});

test('vibe request is not treated as an exact request', () => {
  const target = strictRequestTarget({
    search_terms: [],
    artist: null,
    mood: 'rainy',
  });

  assert.deepEqual(target, { title: null, artist: null, specific: false });
  assert.equal(pickStrictCandidate(target, [midnight]), null);
  assert.equal(strictRequestSatisfied(target, midnight), true);
});

test('strict failure message names the missing requested track', () => {
  assert.equal(
    strictFailureMessage({ title: 'Midnight City', artist: 'M83', specific: true }),
    `Couldn't find "Midnight City" by M83 in the library.`,
  );
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nall strict request tests passed');
