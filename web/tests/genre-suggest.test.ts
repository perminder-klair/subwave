import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as genreSuggest from '../components/admin/GenreSuggest';

type GenreSelectionKey = (value: string) => string;

function selectionKey(): GenreSelectionKey {
  const key = (genreSuggest as { genreSelectionKey?: GenreSelectionKey }).genreSelectionKey;
  if (typeof key !== 'function') {
    throw new TypeError('GenreSuggest must expose its selected-value identity');
  }
  return key;
}

test('selected genre identity preserves distinct non-Latin tags', () => {
  const key = selectionKey();

  assert.notEqual(key('演歌'), key('歌謡曲'));
});

test('selected genre identity ignores surrounding whitespace and case', () => {
  const key = selectionKey();

  assert.equal(key(' Trance '), key('trance'));
});
