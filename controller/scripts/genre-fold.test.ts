// music/genre-fold: genreRuns(tag) is tagCoversGenre stored as data. A target
// covers a tag exactly when it is one of the tag's word runs, so the query
// language can test a refinement with a plain LIKE over the stored runs.

import assert from 'node:assert/strict';
import test from 'node:test';
import { genreRuns, normGenre, tagCoversGenre } from '../src/music/genre-fold.js';

const TAGS = ['Punk Rock', 'Pop Punk', 'Hip-Hop', 'Contemporary R&B', 'R&B', 'Trap', 'Rap',
  'Drum & Bass', 'Synth-pop / New Wave', '80s Pop', 'K-Pop', 'Lo-Fi Hip Hop', 'Rock', '', '!!', 'Åsa Folk'];

test('genreRuns agrees with tagCoversGenre on every target', () => {
  for (const tag of TAGS) {
    const norm = normGenre(tag);
    // Every substring of every tag's fold, so both answers get exercised.
    const targets = new Set<string>(TAGS.map(normGenre));
    for (let i = 0; i < norm.length; i++) for (let j = i + 1; j <= norm.length; j++) targets.add(norm.slice(i, j));
    const runs = new Set(genreRuns(tag));
    for (const target of targets) {
      assert.equal(runs.has(target), tagCoversGenre(tag, target), `${JSON.stringify(tag)} / ${target}`);
    }
  }
});

test('the runs a reader expects', () => {
  assert.deepEqual(genreRuns('Punk Rock'), ['punk', 'punkrock', 'rock']);
  assert.deepEqual(genreRuns('Hip-Hop'), ['hip', 'hiphop', 'hop']);
  assert.deepEqual(genreRuns(''), []);
  assert.equal(normGenre(null), '');
  assert.equal(tagCoversGenre(undefined as never, 'pop'), false);
});
