import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  geminiLibraryKeys,
  normalizeLibraryInput,
  type LibraryInput,
} from '../components/admin/tts/geminiLibraryQueries';

// The browser has three distinct language states and the wire has to be able to
// tell them apart:
//
//   station default  -> ABSENT language   (route applies the saved default)
//   every language   -> language=any     (explicitly overrides the default)
//   explicit tag     -> language=en-AU
//
// These were two states, and the merge produced a request that matched nothing:
// the Radix placeholder `__any__` was truthy, so `normalizeLibraryInput` kept it,
// and `?language=__any__` went on the wire — which the route forwarded upstream as
// `language_code=__any__`. The library returned empty and read as "no voices",
// not as a bug. Source-text and save-builder assertions had missed it because
// neither one builds a request.

/** Build the query string the request helper would send. Mirrors the loop in
 *  `fetchLibraryPage`, which is the only place a param reaches the URL. */
function queryFor(input: LibraryInput): URLSearchParams {
  const normalised = normalizeLibraryInput(input);
  const q = new URLSearchParams({ provider: 'gemini' });
  for (const [k, v] of Object.entries(normalised)) {
    if (k === 'pageSize') { q.set('pageSize', String(v)); continue; }
    if (v) q.set(k, String(v));
  }
  return q;
}

test('the station default OMITS language so the route applies the saved one', () => {
  const q = queryFor({});
  assert.equal(q.has('language'), false,
    'an absent language is what tells the route to use tts.gemini.libraryLanguage');
  assert.equal(q.get('provider'), 'gemini');
});

test('"every language" is sent EXPLICITLY, so it overrides the saved default', () => {
  // With `en-AU` saved, an omitted language returns only Australian voices, so a
  // control labelled "Every language" would return one region and read as broken.
  const q = queryFor({ language: 'any' });
  assert.equal(q.get('language'), 'any');
});

test('a UI placeholder never becomes a language on the wire', () => {
  // The regression. `__any__` and `__station_default__` are Radix Select
  // requirements, not server values, and both used to reach the query.
  for (const placeholder of ['__any__', '__station_default__', '', '   ']) {
    const q = queryFor({ language: placeholder });
    assert.equal(q.has('language'), false,
      `placeholder ${JSON.stringify(placeholder)} must not be sent as a language`);
  }
});

test('an explicit tag is sent verbatim', () => {
  assert.equal(queryFor({ language: 'en-AU' }).get('language'), 'en-AU');
  assert.equal(queryFor({ language: ' en-GB ' }).get('language'), 'en-GB', 'and is trimmed');
});

test('the three states are three DISTINCT cache entries', () => {
  // If they collided, switching between them would serve the previous one's
  // results from cache — which is the same class of bug as the mixed cursor.
  const keys = new Set([
    JSON.stringify(geminiLibraryKeys.catalogue(normalizeLibraryInput({}))),
    JSON.stringify(geminiLibraryKeys.catalogue(normalizeLibraryInput({ language: 'any' }))),
    JSON.stringify(geminiLibraryKeys.catalogue(normalizeLibraryInput({ language: 'en-AU' }))),
  ]);
  assert.equal(keys.size, 3, 'station default, every language and an explicit tag must not share a key');
});

test('unset filters collapse so two controls holding the same choice share an entry', () => {
  // Without this, `undefined` and an absent key would key differently and defeat
  // the de-duplication the query exists for.
  const a = normalizeLibraryInput({ gender: undefined, accent: undefined });
  const b = normalizeLibraryInput({});
  assert.deepEqual(a, b);
  assert.deepEqual(Object.keys(a).sort(), ['language'].filter(k => k in a));
});