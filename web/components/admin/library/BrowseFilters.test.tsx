import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrowseFilters } from './BrowseFilters';

const noop = () => {};
const render = (over: Partial<Parameters<typeof BrowseFilters>[0]> = {}) => renderToStaticMarkup(createElement(BrowseFilters, {
  moodVocab: [], moodCounts: {}, energyCounts: {}, genreList: [],
  moods: [], setMoods: noop, energy: '' as never, setEnergy: noop, vocal: '' as never, setVocal: noop,
  genre: '', setGenre: noop, yearFrom: '', setYearFrom: noop, yearTo: '', setYearTo: noop,
  q: 'AC/DC', setQ: noop,
  queryError: { message: '"/" is not query syntax here', offset: 2, kind: 'syntax' },
  readsAs: '',
  reindexing: false,
  sort: 'artist', setSort: noop,
  ...over,
}));

test('the search box is described by the live region that reads its query back', () => {
  const html = render();
  const describedBy = /aria-label="Search tracks"[^>]*aria-describedby="([^"]+)"/.exec(html)?.[1];
  assert.ok(describedBy, 'the box names a description');
  assert.match(html, new RegExp(`<div id="${describedBy}"[^>]*aria-live="polite"`), 'and it is the live region');
  assert.match(html, /is not query syntax here/, 'which carries the error');
});

test('only text that is no query at all is offered as a quoted search', () => {
  assert.match(render(), /To search for this text as written/, 'AC/DC');
  for (const kind of ['incomplete', 'meaning'] as const) {
    const html = render({ q: 'title:live OR', queryError: { message: 'The query ends early', offset: 13, kind } });
    assert.match(html, /The query ends early/);
    assert.doesNotMatch(html, /To search for this text as written/, kind);
  }
});

test('a search answered while the keys are rebuilt says it may be missing tracks', () => {
  const note = /may be missing tracks/;
  assert.match(render({ q: 'live', queryError: null, readsAs: 'anywhere "live"', reindexing: true }), note);
  assert.doesNotMatch(render({ q: 'live', queryError: null, readsAs: 'anywhere "live"' }), note);
  assert.doesNotMatch(render({ q: '', queryError: null, reindexing: true }), note, 'not for an empty box');
});
