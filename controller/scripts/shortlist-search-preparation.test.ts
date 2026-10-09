import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const root = await mkdtemp(join(tmpdir(), 'subwave-search-preparation-'));
process.env.STATE_DIR = root;
const { createShortlistSearchPreparation, shortlistSearchPrompt } = await import('../src/broadcast/shortlist-search-preparation.js');
const { groundShortlistSearches, shortlistSearchCalls } = await import('../src/music/shortlist-search.js');
const { planShortlistSources } = await import('../src/music/shortlist.js');
const { pickerScope } = await import('../src/llm/tools.js');
after(() => rm(root, { recursive: true, force: true }));
const base = Date.now();
const brief = { occurrenceId: 'show:one', expiresAt: base + 3600_000, topic: 'Songs about coming home' };
const response = '```json\n{"searches":[{"kind":"theme","query":"songs about coming home","evidence":"Songs about coming home"}]}\n```';
const chrisBrief = await readFile(new URL('./fixtures/shortlist-search/chris-show-brief.md', import.meta.url), 'utf8');
const bobBrief = await readFile(new URL('./fixtures/shortlist-search/bob-show-brief.md', import.meta.url), 'utf8');

test('the reported presenter biography rejects all three invented searches and caches the empty result', async () => {
  let calls = 0;
  const file = join(root, 'chris.json');
  const deps = { file, now: () => base, generate: async () => {
    calls++;
    return JSON.stringify({ searches: [
      { kind: 'theme', query: 'songs about everyday life' },
      { kind: 'artist', query: 'Chris Sittins songs' },
      { kind: 'library', query: 'forgotten album tracks' },
    ] });
  } };
  const input = { ...brief, topic: chrisBrief, presenterNames: ['Chris Sittins'] };
  assert.deepEqual(await createShortlistSearchPreparation(deps).ensure(input), []);
  assert.deepEqual(await createShortlistSearchPreparation(deps).ensure(input), []);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).records[0].status, 'ready');
});

test('evidence cannot fabricate a theme or turn biography and generic discovery prose into search terms', () => {
  assert.deepEqual(groundShortlistSearches([
    { kind: 'theme', query: 'songs about everyday life', evidence: "The working day has settled in, the kettle's probably been on once already" },
    { kind: 'artist', query: 'Chris Sittins', evidence: 'Chris Sittins is here to keep you company with two hours of great music and good conversation.' },
    { kind: 'library', query: 'overlooked album track', evidence: "the next he'll quietly champion an overlooked album track" },
    { kind: 'theme', query: 'songs about everyday life', evidence: 'Songs about everyday life' },
  ], [chrisBrief], ['Chris Sittins']), []);
  // Even a recording credit in the supplied text cannot search for a known host.
  assert.deepEqual(groundShortlistSearches([
    { kind: 'artist', query: 'Chris', evidence: 'Music from Chris Sittins' },
  ], ['Music from Chris Sittins'], ['Chris Sittins']), []);
  assert.deepEqual(groundShortlistSearches([
    { kind: 'theme', query: 'songs about everyday life', evidence: 'Songs about coming home' },
  ], [brief.topic]), []);
  // Live Carrie preparation copied the old prompt example and attached a
  // real, unrelated excerpt. A genuine quote alone must not validate a theme.
  assert.deepEqual(groundShortlistSearches([
    { kind: 'theme', query: 'songs about coming home', evidence: 'She has a knack for making old favourites feel fresh' },
  ], ['She has a knack for making old favourites feel fresh and introducing newer artists and the legends that inspired them.'], ['Carrie Marshall']), []);
  assert.deepEqual(groundShortlistSearches([
    { kind: 'artist', query: 'Bob Dylan', evidence: 'Play songs by Bob Dylan' },
  ], ['Play songs by Bob Dylan'], ['Bob']), [{ kind: 'artist', query: 'Bob Dylan' }],
  'sharing a first name with a host must not exclude an explicitly named artist');
});

test('the supplied Bob show brief retains explicit artist, genre and instrumentation requests', async () => {
  const searches = [
    { kind: 'artist' as const, query: 'R.E.M.', evidence: "Play plenty of Bob's favourite artists such as R.E.M., The Cure, The Smiths, Radiohead, Oasis, Blur and The Stone Roses" },
    { kind: 'library' as const, query: 'Britpop', evidence: "Bob's Alternative Afternoon is packed with great guitar music from the 80s, 90s and 2000s, mixing alternative rock, indie, Britpop and classic rock." },
    { kind: 'sound' as const, query: 'melodic guitars, acoustic tracks, strong basslines', evidence: 'Bob loves melodic guitars, acoustic tracks, strong basslines and interesting production, so favour songs with those qualities.' },
  ];
  const expected = searches.map(({ kind, query }) => ({ kind, query }));
  const owner = createShortlistSearchPreparation({ file: join(root, 'bob.json'), now: () => base,
    generate: async prompt => {
      assert.equal(JSON.parse(prompt).topic, bobBrief.trim());
      return JSON.stringify({ searches });
    } });
  assert.deepEqual(await owner.ensure({ ...brief, topic: bobBrief, presenterNames: ['Bob'] }), expected);
  assert.deepEqual(shortlistSearchCalls(expected, new Set(['topSongsByArtist', 'searchLibrary', 'searchBySound']))
    .map(call => call.source), ['topSongsByArtist', 'searchLibrary', 'searchBySound']);
  assert.deepEqual(groundShortlistSearches([
    { kind: 'library', query: 'forgotten favourites', evidence: 'find forgotten favourites, overlooked gems and tracks listeners might not have heard for years.' },
    { kind: 'theme', query: 'songs about the afternoon', evidence: 'with a thoughtful, knowledgeable feel and enough energy for the afternoon.' },
    { kind: 'library', query: 'manufactured pop', evidence: 'Avoid manufactured pop, repetitive dance music and novelty records.' },
    { kind: 'library', query: 'novelty records', evidence: 'repetitive dance music and novelty records' },
  ], [bobBrief], ['Bob']), []);
});

test('literal titles and explicit recent releases work, while a general artist request does not invent recency', () => {
  const fields = ['Play the track "Everyday Life"', 'Explore Portishead tracks', 'Latest releases from Portishead'];
  assert.deepEqual(groundShortlistSearches([
    { kind: 'library', query: 'Everyday Life', evidence: fields[0] },
    { kind: 'recentArtist', query: 'Portishead', evidence: fields[2] },
    { kind: 'recentArtist', query: 'Portishead', evidence: fields[1] },
  ], fields), [ { kind: 'library', query: 'Everyday Life' }, { kind: 'recentArtist', query: 'Portishead' } ]);
});

test('pre-grounding cache records are discarded even when their identity matches', async () => {
  const file = join(root, 'upgrade.json');
  const deps = { file, now: () => base, generate: async () => response };
  await createShortlistSearchPreparation(deps).ensure(brief);
  const previous = JSON.parse(await readFile(file, 'utf8'));
  previous.version = 1;
  previous.records[0].searches = [{ kind: 'artist', query: 'Chris Sittins' }];
  await writeFile(file, JSON.stringify(previous));
  let calls = 0;
  assert.deepEqual(await createShortlistSearchPreparation({ ...deps,
    generate: async () => { calls++; return '{"searches":[]}'; },
  }).ensure(brief), []);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 2);
});

test('concurrent calls, later picks and a restarted owner reuse one durable preparation', async () => {
  let calls = 0;
  const deps = { file: join(root, 'reuse.json'), now: () => base, generate: async () => { calls++; return response; } };
  const owner = createShortlistSearchPreparation(deps);
  const results = await Promise.all(Array.from({ length: 8 }, () => owner.ensure(brief)));
  assert.equal(calls, 1);
  assert.ok(results.every(searches => searches[0]?.query === 'songs about coming home'));
  await owner.ensure(brief);
  await createShortlistSearchPreparation(deps).ensure(brief);
  assert.equal(calls, 1, 'restart must not repeat the model call');
});

test('a new airing or edited brief prepares independently, while an empty result is cached', async () => {
  let calls = 0;
  const owner = createShortlistSearchPreparation({ file: join(root, 'identity.json'), now: () => base,
    generate: async () => { calls++; return '{"searches":[]}'; } });
  await owner.ensure(brief); await owner.ensure(brief);
  assert.equal(calls, 1);
  await owner.ensure({ ...brief, topic: 'Songs about leaving home' });
  await owner.ensure({ ...brief, occurrenceId: 'show:two' });
  assert.equal(calls, 3);
});

test('unusable output falls back immediately with a durable cooldown and at most two attempts', async () => {
  let clock = base; let calls = 0;
  const deps = { file: join(root, 'failure.json'), now: () => clock,
    generate: async () => { calls++; return '{"searches":[{"kind":"executeShell","query":"bad"}]}'; } };
  const owner = createShortlistSearchPreparation(deps);
  assert.deepEqual(await owner.ensure(brief), []);
  await owner.ensure(brief);
  await createShortlistSearchPreparation(deps).ensure(brief);
  assert.equal(calls, 1);
  clock += 5 * 60_000;
  await owner.ensure(brief);
  clock += 5 * 60_000;
  await createShortlistSearchPreparation(deps).ensure(brief);
  assert.equal(calls, 2);
});

test('blank or expired input makes no call, and a late result cannot revive an expired airing', async () => {
  let clock = base; let calls = 0;
  const owner = createShortlistSearchPreparation({ file: join(root, 'expiry.json'), now: () => clock,
    generate: async () => { calls++; clock = brief.expiresAt; return response; } });
  assert.deepEqual(await owner.ensure({ ...brief, topic: '' }), []);
  assert.deepEqual(await owner.ensure({ ...brief, expiresAt: base }), []);
  assert.deepEqual(await owner.ensure(brief), []);
  assert.equal(calls, 1);
});

test('preparation input is bounded factual data and cannot inherit persona or listener context', () => {
  const prompt = shortlistSearchPrompt({ ...brief, topic: 't'.repeat(3000), editorial: 'e'.repeat(3000),
    persona: { musicalLeanings: 'PRIVATE_LEANINGS' }, conversation: 'RAW_LISTENER' } as any);
  assert.equal(JSON.parse(prompt).topic.length, 2000);
  assert.equal(JSON.parse(prompt).editorial.length, 2000);
  assert.doesNotMatch(prompt, /PRIVATE_LEANINGS|RAW_LISTENER/);
});

test('persisted preparation stays bounded as show identities change', async () => {
  const file = join(root, 'bounded.json');
  const owner = createShortlistSearchPreparation({ file, now: () => base, generate: async () => response });
  for (let i = 0; i < 70; i++) await owner.ensure({ ...brief, occurrenceId: `show:${i}` });
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(stored.records.length, 64);
});

test('only controller-owned search mappings produce executable source arguments', () => {
  const searches = [
    { kind: 'library' as const, query: 'Portishead' }, { kind: 'artist' as const, query: 'Portishead' },
    { kind: 'recentArtist' as const, query: 'Portishead' },
  ];
  const available = new Set(['searchLibrary', 'topSongsByArtist', 'recentByArtist']);
  const calls = shortlistSearchCalls(searches, available);
  assert.deepEqual(calls.map(call => [call.source, call.args]), [
    ['searchLibrary', { query: 'Portishead' }], ['topSongsByArtist', { artist: 'Portishead' }], ['recentByArtist', { artist: 'Portishead' }],
  ]);
  assert.deepEqual(shortlistSearchCalls([{ kind: 'sound', query: 'brushed drums' }], new Set()), []);
  assert.deepEqual(shortlistSearchCalls([{ kind: 'library', query: 'Portishead', tool: 'randomSongs' } as any], available), []);
  assert.deepEqual(shortlistSearchCalls([{ kind: 'theme', query: 'home' }, { kind: 'sound', query: 'brushed drums' }],
    new Set(['searchByLyrics', 'searchBySound'])).map(call => call.source), ['searchByLyrics', 'searchBySound']);
});

test('targeted intent rotates within the existing budget and keeps other discovery sources', () => {
  const searches = [{ kind: 'library' as const, query: 'Portishead' }, { kind: 'theme' as const, query: 'coming home' }];
  const available = new Set(['searchLibrary', 'searchByLyrics', 'randomSongs', 'deepCuts', 'tracksByMood', 'tracksLikeThis']);
  const targets = new Set(['searchLibrary', 'searchByLyrics']);
  const context = { scope: pickerScope(), currentTrackId: 'anchor', moods: ['calm'], searches, discoveryPasses: 2 };
  const seen = new Set<string>();
  for (let rotationSeed = 0; rotationSeed < 48; rotationSeed++) {
    const plan = planShortlistSources({ ...context, rotationSeed }, available);
    assert.equal(plan.length, 2);
    assert.equal(plan.filter(call => targets.has(call.source)).length, 1);
    plan.forEach(call => seen.add(call.source));
  }
  assert.ok(seen.has('searchLibrary') && seen.has('searchByLyrics') && seen.has('tracksLikeThis') && seen.has('randomSongs'));
  const narrow = new Set<string>();
  for (let rotationSeed = 0; rotationSeed < 48; rotationSeed++) {
    const plan = planShortlistSources({ ...context, discoveryPasses: 1, rotationSeed }, available);
    assert.equal(plan.length, 1); narrow.add(plan[0].source);
  }
  assert.ok(narrow.has('searchLibrary') && narrow.has('randomSongs'));
});

test('directed sources keep priority and unavailable searches preserve the ordinary plan', () => {
  const searches = [{ kind: 'theme' as const, query: 'homecoming' }];
  const available = new Set(['searchByLyrics', 'tracksTowardJourney', 'showPlaylistTracks', 'randomSongs']);
  for (const scope of [pickerScope({ audioWaypoint: [1] }), pickerScope({ playlistLock: new Set(['one']), playlistTracks: [{ id: 'one' }] })]) {
    const plan = planShortlistSources({ scope, currentTrackId: null, searches, discoveryPasses: 1 }, available);
    assert.equal(plan[0].source, scope.audioWaypoint ? 'tracksTowardJourney' : 'showPlaylistTracks');
  }
  assert.equal(planShortlistSources({ scope: pickerScope(), currentTrackId: null, searches, discoveryPasses: 1 }, new Set(['randomSongs']))[0].source, 'randomSongs');
});
