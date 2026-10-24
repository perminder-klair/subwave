import assert from 'node:assert/strict';
import test from 'node:test';
import { englishWikipediaTitleFromWikidata, projectWikipediaArtistDocument, wikidataIdFromMusicBrainzArtist } from '../src/sleeve-notes/wikipedia.js';

test('Wikipedia artist documents retain a bounded revisioned plain-text source', () => {
  const document = projectWikipediaArtistDocument({ query: { pages: {
    '123': {
      title: 'Example Band', fullurl: 'https://en.wikipedia.org/wiki/Example_Band',
      extract: `Example Band formed in Liverpool. ${'History. '.repeat(50_000)}`,
      revisions: [{ revid: 456 }],
    },
  } } });
  assert.ok(document);
  assert.equal(document.revisionId, '456');
  assert.equal(document.url, 'https://en.wikipedia.org/wiki/Example_Band');
  assert.equal(document.text.length, 250_000);
  assert.match(document.attribution, /Wikipedia contributors/);
});

test('Wikipedia identity comes from the MusicBrainz artist relation, not a loose name search', () => {
  assert.equal(wikidataIdFromMusicBrainzArtist({ relations: [{ type: 'wikidata', url: { resource: 'https://www.wikidata.org/wiki/Q123' } }] }), 'Q123');
  assert.equal(wikidataIdFromMusicBrainzArtist({ relations: [{ type: 'official homepage', url: { resource: 'https://example.test' } }] }), null);
  assert.equal(englishWikipediaTitleFromWikidata({ entities: { Q123: { sitelinks: { enwiki: { title: 'Example Band' } } } } }, 'Q123'), 'Example Band');
  assert.equal(englishWikipediaTitleFromWikidata({ entities: { Q123: { sitelinks: {} } } }, 'Q123'), null);
});

test('Wikipedia projection refuses an unrevisioned or empty result', () => {
  assert.equal(projectWikipediaArtistDocument({ query: { pages: {
    '123': { title: 'Example', fullurl: 'https://example.test', extract: 'Text', revisions: [] },
  } } }), null);
});
