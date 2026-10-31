import assert from 'node:assert/strict';
import test from 'node:test';
import type { TrackRecord } from '../src/music/library-db/types.js';
import {
  resolveWebLanguageEvidence,
  verifyLanguageSearchResult,
} from '../src/music/language-evidence.js';

const track = {
  title: 'Mere Wala Sardar',
  artist: 'Jugraj Sandhu',
  album: 'Single',
} as TrackRecord;

test('web evidence requires the exact local title and artist', async () => {
  assert.equal(
    verifyLanguageSearchResult(track, {
      title: 'Mere Wala Sardar lyrics by Jugraj Sandhu',
      content: 'Mere Wala Sardar lyrics and song details',
    }),
    true,
  );
  assert.equal(
    verifyLanguageSearchResult(track, {
      title: 'Mere Wala Sardar lyrics by Another Artist',
      content: 'Mere Wala Sardar lyrics and song details',
    }),
    false,
  );
  assert.equal(
    verifyLanguageSearchResult({ ...track, title: 'One' }, {
      title: 'Someone Like Me lyrics by U2',
      content: 'Someone Like Me lyrics and song details',
    }),
    false,
  );
});

test('web evidence extracts explicit language only after identity verification', async () => {
  const queries: string[] = [];
  const evidence = await resolveWebLanguageEvidence(track, async query => {
    queries.push(query);
    return {
      answer: '',
      results: [{
        title: 'Mere Wala Sardar lyrics by Jugraj Sandhu',
        content: 'Language: Punjabi. ' + 'main tenu pyaar karda dil mera nachda '.repeat(20),
      }],
    };
  });
  assert.equal(queries.length, 2, 'the resolver keeps the provider bounded to two queries');
  assert.deepEqual(evidence.languages, ['pan']);
  assert.equal(evidence.instrumental, false);
  assert.match(evidence.text ?? '', /main tenu/);
});

test('same-title and incompatible-version search hits produce no evidence', async () => {
  const wrongArtist = await resolveWebLanguageEvidence(track, async () => ({
    answer: '',
    results: [{
      title: 'Mere Wala Sardar lyrics by Another Artist',
      content: 'Language: Punjabi. ' + 'main tenu pyaar karda '.repeat(30),
    }],
  }));
  assert.deepEqual(wrongArtist, { text: null, languages: [], instrumental: false });

  const incompatibleVersion = await resolveWebLanguageEvidence(track, async () => ({
    answer: '',
    results: [{
      title: 'Mere Wala Sardar (Instrumental) lyrics by Jugraj Sandhu',
      content: 'Language: Punjabi. ' + 'main tenu pyaar karda '.repeat(30),
    }],
  }));
  assert.deepEqual(incompatibleVersion, { text: null, languages: [], instrumental: false });
});
