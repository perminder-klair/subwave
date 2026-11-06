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

// Exercise the production client, replacing HTTP only at the network boundary.
test('explicit article fallback works for artists and albums while Wikidata stays preferred', async t => {
  const { fetchWikipediaArtistDocument, fetchWikipediaReleaseGroupDocument } = await import('../src/sleeve-notes/wikipedia.js');
  for (const entity of ['artist', 'release-group'] as const) {
    for (const route of ['no-wikidata', 'missing-sitelink', 'missing-item', 'wikidata-preferred'] as const) {
      await t.test(`${entity}: ${route}`, async t => {
        const requests: URL[] = [];
        t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
          const url = new URL(String(input)); requests.push(url);
          if (url.hostname === 'musicbrainz.org') {
            assert.equal(url.pathname, `/ws/2/${entity}/fixture-id`);
            assert.equal(url.searchParams.get('inc'), 'url-rels');
            return Response.json({ relations: [
              { type: 'wikipedia', url: { resource: 'https://en.wikipedia.org/wiki/Example_Stage_Name' } },
              ...(route === 'no-wikidata' ? [] : [{ type: 'wikidata', url: { resource: 'https://www.wikidata.org/wiki/Q123' } }]),
            ] });
          }
          if (url.hostname === 'www.wikidata.org') {
            if (route === 'missing-item') return new Response(null, { status: 404 });
            return Response.json({ entities: { Q123: { sitelinks: route === 'wikidata-preferred'
              ? { enwiki: { title: 'Example Musician' } } : {} } } });
          }
          assert.equal(url.hostname, 'en.wikipedia.org');
          if (url.pathname === '/w/api.php') {
            assert.equal(url.searchParams.get('titles'), route === 'wikidata-preferred' ? 'Example Musician' : 'Example Stage Name');
            assert.equal(url.searchParams.get('redirects'), '1');
            return Response.json({ query: { pages: { '123': {
              title: 'Example Musician', fullurl: 'https://en.wikipedia.org/wiki/Example_Musician',
              extract: 'Example Musician releases music under a stage name.', revisions: [{ revid: 456 }],
            } } } });
          }
          assert.equal(url.pathname, '/w/rest.php/v1/revision/456/html');
          return new Response('<p>Example Musician releases music under a stage name.</p>');
        });
        const document = await (entity === 'artist' ? fetchWikipediaArtistDocument : fetchWikipediaReleaseGroupDocument)('fixture-id');
        assert.ok(document);
        assert.equal(document.title, 'Example Musician');
        assert.equal(document.url, 'https://en.wikipedia.org/wiki/Example_Musician');
        assert.equal(document.revisionId, '456');
        assert.equal(document.sourceFormatVersion, 2);
        assert.match(document.text, /Example Musician releases music/);
        assert.equal(requests.length, route === 'no-wikidata' ? 3 : 4);
      });
    }
  }
});

test('missing, unrelated, non-English and malformed article relations are clean misses', async t => {
  const { fetchWikipediaArtistDocument } = await import('../src/sleeve-notes/wikipedia.js');
  const invalid = [
    null, {}, { type: 'official homepage', url: { resource: 'https://en.wikipedia.org/wiki/Example' } },
    ...[
      'not a URL', 'https://de.wikipedia.org/wiki/Example', 'https://en.wikipedia.org.evil.test/wiki/Example',
      'https://en.wikipedia.org@evil.test/wiki/Example', 'ftp://en.wikipedia.org/wiki/Example',
      'https://en.wikipedia.org/wiki/', 'https://en.wikipedia.org/w/index.php?title=Example',
      'https://en.wikipedia.org/wiki/Example#History', 'https://en.wikipedia.org/wiki/Example?oldid=123',
      'https://en.wikipedia.org/wiki/%ZZ', 'https://en.wikipedia.org/wiki/One%7CTwo',
      'https://en.wikipedia.org/wiki/Example%0AOther',
    ].map(resource => ({ type: 'wikipedia', url: { resource } })),
  ];
  for (const relation of invalid) {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      assert.equal(++calls, 1, 'invalid links must not cause a Wikipedia request');
      return Response.json({ relations: relation === null ? [] : [relation] });
    });
    assert.equal(await fetchWikipediaArtistDocument('fixture-id'), null);
    t.mock.restoreAll();
  }
});

test('a transient Wikidata failure remains retryable rather than using the fallback', async t => {
  const { fetchWikipediaArtistDocument } = await import('../src/sleeve-notes/wikipedia.js');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (++calls === 1) return Response.json({ relations: [
      { type: 'wikidata', url: { resource: 'https://www.wikidata.org/wiki/Q123' } },
      { type: 'wikipedia', url: { resource: 'https://en.wikipedia.org/wiki/Example' } },
    ] });
    assert.equal(calls, 2);
    return new Response(null, { status: 503 });
  });
  await assert.rejects(fetchWikipediaArtistDocument('fixture-id'), /HTTP 503/);
  assert.equal(calls, 2);
});

test('operator article override bypasses name guessing and MusicBrainz but still validates redirects and disambiguation',async t=>{
  const {fetchWikipediaArtistDocument}=await import('../src/sleeve-notes/wikipedia.js');
  for (const disambiguation of [false,true]) {
    let calls=0;
    t.mock.method(globalThis,'fetch',async(input:string|URL|Request)=>{
      const url=new URL(String(input));calls++;assert.equal(url.hostname,'en.wikipedia.org');
      if(url.pathname==='/w/api.php') {
        assert.equal(url.searchParams.get('titles'),'Stage Name');assert.equal(url.searchParams.get('redirects'),'1');
        assert.equal(url.searchParams.get('ppprop'),'disambiguation');
        return Response.json({query:{pages:{'123':{ns:0,title:'Personal Name',fullurl:'https://en.wikipedia.org/wiki/Personal_Name',extract:'Biography',revisions:[{revid:456}],...(disambiguation?{pageprops:{disambiguation:''}}:{})}}}});
      }
      return new Response('<p>Biography of the musician.</p>');
    });
    const document=await fetchWikipediaArtistDocument('ignored','https://en.wikipedia.org/wiki/Stage_Name');
    assert.equal(document?.title??null,disambiguation?null:'Personal Name');assert.equal(calls,disambiguation?1:2);t.mock.restoreAll();
  }
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({});});
  assert.throws(()=>fetchWikipediaArtistDocument('ignored','https://localhost/wiki/Artist'));assert.equal(calls,0);
});

test('source-only verification fetches metadata without article prose or HTML and treats service errors as failures',async t=>{
  const {fetchWikipediaArtistDocument}=await import('../src/sleeve-notes/wikipedia.js');let calls=0;
  t.mock.method(globalThis,'fetch',async(input:string|URL|Request)=>{
    calls++;const url=new URL(String(input));assert.equal(url.pathname,'/w/api.php');assert.equal(url.searchParams.get('prop'),'info|revisions|pageprops');
    return Response.json({query:{pages:{'123':{ns:0,title:'Example',fullurl:'https://en.wikipedia.org/wiki/Example',revisions:[{revid:456}]}}}});
  });
  const result=await fetchWikipediaArtistDocument('ignored','https://en.wikipedia.org/wiki/Example',{metadataOnly:true});assert.equal(result?.text,'');assert.equal(calls,1);
  t.mock.restoreAll();
  t.mock.method(globalThis,'fetch',async()=>Response.json({error:{code:'maxlag'}}));await assert.rejects(fetchWikipediaArtistDocument('ignored','https://en.wikipedia.org/wiki/Example',{metadataOnly:true}),/maxlag/);
  t.mock.restoreAll();
  t.mock.method(globalThis,'fetch',async()=>new Response(null,{status:403}));await assert.rejects(fetchWikipediaArtistDocument('ignored','https://en.wikipedia.org/wiki/Example',{metadataOnly:true}),/HTTP 403/);
});
