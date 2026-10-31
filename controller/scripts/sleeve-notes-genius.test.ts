import assert from 'node:assert/strict';
import test from 'node:test';
import { GeniusProvider, projectGeniusSong, projectGeniusAlbumBiography, selectGeniusSearchHit } from '../src/sleeve-notes/genius.js';
import { clearProviderCallsForTest, recentProviderCalls } from '../src/sleeve-notes/telemetry.js';

const search = { response: { hits: [
  { result: { id: 9, title: 'Different Song', url: 'https://genius.com/x', primary_artist: { name: 'Band' } } },
  { result: { id: 10, title: 'The Song', url: 'https://genius.com/y', primary_artist: { name: 'The Band' } } },
] } };

test('Genius search requires an exact title and artist match', () => {
  assert.equal(selectGeniusSearchHit(search, { kind: 'track', title: 'The Song', artist: 'The Band' }), '10');
  assert.equal(selectGeniusSearchHit(search, { kind: 'track', title: 'The Song', artist: 'Someone Else' }), null);
});

test('Genius projection retains only approved credits and relationships', () => {
  const result = projectGeniusSong({ response: { song: {
    id: 10, title: 'The Song', url: 'https://genius.com/y', primary_artist: { name: 'The Band' },
    lyrics: 'must not be used', description: { plain: 'nor this' },
    custom_performances: [
      { label: 'Producer', artists: [{ name: 'A Producer' }] },
      { label: 'Guitar', artists: [{ name: 'A Guitarist' }] },
    ],
    producer_artists: [{ name: 'A Producer' }],
    writer_artists: [{ name: 'A Writer' }],
    song_relationships: [
      { relationship_type: 'samples', songs: [{ id: 11, title: 'Source', url: 'https://genius.com/source', primary_artist: { name: 'Source Artist' } }] },
      { relationship_type: 'remixed_by', songs: [{ id: 12, title: 'Ignore', url: 'https://genius.com/ignore' }] },
    ],
  } } });
  assert.deepEqual(result?.credits, [
    { role: 'Producer', names: ['A Producer'] },
    { role: 'Writer', names: ['A Writer'] },
  ]);
  assert.deepEqual(result?.relationships, [{ type: 'samples', target: { providerId: '11', canonicalUrl: 'https://genius.com/source', title: 'Source', artist: 'Source Artist' } }]);
});

test('Genius provider uses only search then song endpoints', async () => {
  clearProviderCallsForTest();
  const calls: string[] = [];
  const provider = new GeniusProvider('not-a-real-token', async (url) => {
    calls.push(url);
    return new Response(JSON.stringify(calls.length === 1 ? search : { response: { song: {
      id: 10, title: 'The Song', url: 'https://genius.com/y', primary_artist: { name: 'The Band' }, custom_performances: [], song_relationships: [],
    } } }), { status: 200 });
  }, async () => {});
  await provider.fetch({ kind: 'track', title: 'The Song', artist: 'The Band' }, new AbortController().signal);
  assert.deepEqual(calls.map((url) => new URL(url).pathname), ['/search', '/songs/10']);
  assert.deepEqual(recentProviderCalls().map((call) => [call.endpoint, call.ok, call.status]), [
    ['song', true, 200], ['search', true, 200],
  ]);
  assert.ok(recentProviderCalls().every((call) => Number.isFinite(call.ms) && call.ms >= 0));
});

test('known Genius song IDs skip search and send an identifiable User-Agent', async () => {
  const calls: string[] = [];
  const provider = new GeniusProvider('test', async (url, init) => {
    calls.push(new URL(url).pathname);
    assert.match(new Headers(init?.headers).get('User-Agent') ?? '', /Subwave/);
    return Response.json({ response: { song: {
      id: 10, title: 'The Song', url: 'https://genius.com/y', primary_artist: { name: 'The Band' },
    } } });
  }, async () => { throw new Error('Direct fetch should not schedule a search delay'); });
  const entity = { kind: 'track' as const, title: 'The Song', artist: 'The Band' };
  assert.equal((await provider.fetchSong('10', entity, new AbortController().signal))?.identity.providerId, '10');
  assert.deepEqual(calls, ['/songs/10']);
  await assert.rejects(provider.fetchSong('../search', entity, new AbortController().signal), /Invalid Genius song ID/);
  assert.equal(calls.length, 1);
});

test('song detail refuses mismatched identity without searching for a replacement', async () => {
  let calls = 0;
  for (const song of [
    { id: 11, title: 'The Song', artist: 'The Band' },
    { id: 10, title: 'The Song (Live)', artist: 'The Band' },
    { id: 10, title: 'The Song', artist: 'Another Band' },
  ]) {
    const provider = new GeniusProvider('test', async () => {
      calls++;
      return Response.json({ response: { song: {
        ...song, primary_artist: { name: song.artist }, url: 'https://genius.com/y',
      } } });
    });
    assert.equal(await provider.fetchSong('10', { kind: 'track', title: 'The Song', artist: 'The Band' },
      new AbortController().signal), null);
  }
  assert.equal(calls, 3);
});

test('artist punctuation variants match canonical names without relaxing recording titles or choosing ambiguous hits',()=>{
 const hit=(id:number,title='Walk This Way')=>({result:{id,title,url:`https://genius.com/${id}`,primary_artist:{name:'Run-DMC'}}});
 const entity={kind:'track' as const,title:'Walk This Way',artist:'Run‐D.M.C.'};
 assert.equal(selectGeniusSearchHit({response:{hits:[hit(100)]}},entity),'100');
 assert.equal(selectGeniusSearchHit({response:{hits:[hit(100,'Walk This Way (Live)')]}},entity),null);
 assert.equal(selectGeniusSearchHit({response:{hits:[hit(100),hit(101)]}},entity),null);
});

test('Unicode identity distinguishes scripts, marks and versions through search and direct detail', async () => {
  for (const [title, artist, otherTitle, otherArtist] of [
    ['春', '東京', '夏', '大阪'],
    ['バンド', '日本', 'ハンド', '日本'],
    ['Мир', 'Кино', 'Мир (Live)', 'Кино'],
    ['سلام', 'فنان', 'سلام (Remix)', 'آخر'],
    ['Café', 'Beyoncé', 'Cafe (Acoustic)', 'Adele'],
  ]) {
    const song = (id: number, name: string, performer: string) => ({id,title:name,url:`https://genius.test/${id}`,primary_artist:{name:performer}});
    const entity = {kind:'track' as const,title,artist};
    const expected = song(10,title,artist);
    const near = song(11,otherTitle,artist);
    const namesake = song(12,title,otherArtist);
    const hits = [near, expected, ...(artist===otherArtist?[]:[namesake])].map(result=>({result}));
    assert.equal(selectGeniusSearchHit({response:{hits}},entity),'10');
    assert.equal(selectGeniusSearchHit({response:{hits:[{result:near}]}},entity),null);
    for (const candidate of [expected,near,...(artist===otherArtist?[]:[namesake])]) {
      const provider = new GeniusProvider('fixture',async()=>Response.json({response:{song:candidate}}));
      const result = await provider.fetchSong(String(candidate.id),entity,new AbortController().signal);
      assert.equal(result?.identity.providerId??null,candidate===expected?'10':null);
    }
  }
  for (const title of ['', '---', '🎵']) {
    assert.equal(selectGeniusSearchHit({response:{hits:[{result:{id:10,title,url:'https://genius.test/10',primary_artist:{name:'Band'}}}]}},{kind:'track',title,artist:'Band'}),null);
  }
  const accented = {result:{id:10,title:'Cafe',url:'https://genius.test/10',primary_artist:{name:'Beyonce'}}};
  assert.equal(selectGeniusSearchHit({response:{hits:[accented]}},{kind:'track',title:'Café',artist:'Beyoncé'}),'10');
});


test('album biographies retain non-Latin identity and refuse unrelated titles and empty keys',()=>{
 const album={id:10,name:'春',artist:{name:'東京'},url:'https://genius.test/album',description:{plain:'An album recorded with the band and their producer in a converted studio, documenting the sessions and the creation of its songs.'}};
 const expected={title:'春',artist:'東京'};
 assert.equal(projectGeniusAlbumBiography({response:{album}},expected)?.title,'春');
 assert.equal(projectGeniusAlbumBiography({response:{album:{...album,name:'夏'}}},expected),null);
 assert.equal(projectGeniusAlbumBiography({response:{album:{...album,artist:{name:'大阪'}}}},expected),null);
 assert.equal(projectGeniusAlbumBiography({response:{album:{...album,name:'---'}}},{...expected,title:'---'}),null);
});

test('optional leading The matches artist identity across search, detail and album lookup without relaxing titles',async()=>{
 const bare='Incredible Bongo Band',prefixed='The Incredible Bongo Band';
 const song=(id:number,artist:string,title='Apache')=>({id,title,url:`https://genius.test/${id}`,primary_artist:{name:artist}});
 for(const [canonical,providerName] of [[bare,prefixed],[prefixed,bare]]) {
  const entity={kind:'track' as const,title:'Apache',artist:canonical};
  const candidate=song(10,providerName);
  assert.equal(selectGeniusSearchHit({response:{hits:[{result:candidate}]}},entity),'10');
  assert.equal(selectGeniusSearchHit({response:{hits:[{result:candidate},{result:song(11,providerName)}]}},entity),null);
  assert.equal(selectGeniusSearchHit({response:{hits:[{result:candidate},{result:song(12,canonical)}]}},entity),'12','exact artist spelling retains preference');
  for(const title of ['Apache (Live)','The Apache']) {
   assert.equal(selectGeniusSearchHit({response:{hits:[{result:song(10,providerName,title)}]}},entity),null);
  }
  const provider=new GeniusProvider('fixture',async()=>Response.json({response:{song:candidate}}));
  assert.equal((await provider.fetchSong('10',entity,new AbortController().signal))?.identity.artist,providerName);
  const album={id:20,name:'Bongo Rock',artist:{name:providerName},url:'https://genius.test/album',description:{plain:'The band recorded this album with their producer in a converted studio, documenting the sessions and the creation of its songs.'}};
  assert.ok(projectGeniusAlbumBiography({response:{album}},{title:'Bongo Rock',artist:canonical}));
  assert.equal(projectGeniusAlbumBiography({response:{album:{...album,name:'The Bongo Rock'}}},{title:'Bongo Rock',artist:canonical}),null);
 }
 assert.equal(selectGeniusSearchHit({response:{hits:[{result:song(10,'Another Incredible Bongo Band')}]}},{kind:'track',title:'Apache',artist:bare}),null);
});
