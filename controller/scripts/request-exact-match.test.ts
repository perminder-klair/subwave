// Exact title + artist is a listener promise, not an editorial pool. This
// pins the narrow deterministic match that runs before broad request search.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exactTitleByArtist } from '../src/music/request-match.js';
import { normaliseRequestSort } from '../src/llm/internal/prompts/request.js';

const candidates = [
  { id: 'other-grace', title: 'Private Life', artist: 'Grace Jones' },
  { id: 'wanted', title: 'Slave to the Rhythm', artist: 'Grace Jones' },
  { id: 'cover', title: 'Slave to the Rhythm', artist: 'A Different Artist' },
];

assert.equal(
  exactTitleByArtist(candidates, { titles: ['Slave to the Rhythm'], artist: 'Grace Jones' })?.id,
  'wanted',
);
assert.equal(
  exactTitleByArtist(candidates, { titles: ['SLAVE TO THE RHYTHM!'], artist: 'grace-jones' })?.id,
  'wanted',
  'case, punctuation, and accents should not turn an exact listener request into a broad pick',
);
assert.equal(
  exactTitleByArtist(candidates, { titles: ['Slave to the Rhythm'], artist: 'Unknown Artist' }),
  null,
  'a title-only hit must not override an explicitly named different artist',
);
assert.equal(exactTitleByArtist(candidates, { titles: [], artist: 'Grace Jones' }), null);

assert.equal(normaliseRequestSort('none'), null);
assert.equal(normaliseRequestSort('LATEST'), 'latest');
assert.equal(normaliseRequestSort('something else'), null);

const routeSource = readFileSync(new URL('../src/routes/request.ts', import.meta.url), 'utf8');
const exactPass = routeSource.indexOf('exactTitleByArtist(exactCandidates');
const broadPool = routeSource.indexOf('const songOffset = Math.floor(Math.random() * 3) * 25;');
assert.ok(exactPass >= 0 && broadPool > exactPass,
  'the deterministic title + artist pass must run before the random broad search pool');

console.log('request exact match: all assertions passed');
