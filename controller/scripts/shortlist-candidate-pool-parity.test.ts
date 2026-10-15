import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const stateRoot = mkdtempSync(join(tmpdir(), 'subwave-shortlist-discovery-'));
process.env.STATE_DIR = stateRoot;
process.env.NAVIDROME_URL = 'http://shortlist-library.invalid';
const { pickerScope, buildPickerTools } = await import('../src/llm/tools.js');
const { planShortlistSources, executeShortlistPlan, balanceShortlist, buildShortlist, orderByTransitionFit } = await import('../src/music/shortlist.js');
const { CandidateOffers } = await import('../src/music/shortlist-offers.js');
const { shortlistSituation, shortlistPickPrompt } = await import('../src/broadcast/dj-agent/shortlist-pick.js');
const library = await import('../src/music/library.js');
const db = await import('../src/music/library-db.js');
const blocklist = await import('../src/music/blocklist.js');
await library.load();
await blocklist.load();

const realFetch = globalThis.fetch;
const endpoints: string[] = [];
let serverSongs: Array<Record<string, any>> = [];
globalThis.fetch = async input => {
  const url = new URL(String(input));
  assert.equal(url.hostname, 'shortlist-library.invalid', 'tests must not contact a live station');
  const endpoint = url.pathname.split('/').at(-1)!;
  endpoints.push(endpoint);
  const data = endpoint === 'getSonicSimilarTracks'
    ? { sonicSimilarTracks: { sonicMatch: serverSongs.map(entry => ({ entry })) } }
    : endpoint === 'getRandomSongs' ? { randomSongs: { song: serverSongs } }
      : { starred: { song: [] } };
  return Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...data } });
};
after(() => {
  globalThis.fetch = realFetch;
  library.shutdown();
  rmSync(stateRoot, { recursive: true, force: true });
});

test('autonomous mood guides discovery, and show moods retain precedence', () => {
  const available = new Set(['tracksByMood']);
  const context = { scope: pickerScope(), currentTrackId: null, discoveryPasses: 1, dominantMood: 'rainy' };
  assert.deepEqual(planShortlistSources(context, available)[0].args, { mood: 'rainy', energy: null });
  assert.equal(planShortlistSources({ ...context, moods: ['calm'] }, available)[0].args.mood, 'calm');
  const snapshot = {
    dominantMood: 'rainy', time: { period: 'evening', vibe: 'wind down' },
    weather: { condition: 'rainy', temp: 0, tempUnit: 'C', isDay: false, location: 'private' },
    festival: { name: 'Festival', description: 'Celebration', mood: 'celebratory' },
    activeShow: { persona: { musicalLeanings: 'Do not leak' } },
  };
  const signals = shortlistSituation(snapshot);
  const prompt = shortlistPickPrompt([{ id: 'a' }], signals);
  assert.match(prompt, /wind down/);
  assert.match(prompt, /Celebration/);
  assert.match(prompt, /"temp":0/);
  assert.match(prompt, /"isDay":false/);
  assert.doesNotMatch(prompt, /Do not leak|private/);
  assert.deepEqual(shortlistSituation(null), {});
});

test('all configured moods, energies, genres and eras participate within the pass budget', () => {
  const available = new Set(['tracksByMood', 'songsByGenre', 'songsByEra']);
  const found = new Set<string>();
  for (let rotationSeed = 0; rotationSeed < 90; rotationSeed++) {
    const plan = planShortlistSources({
      scope: pickerScope(), currentTrackId: null, discoveryPasses: 3, rotationSeed,
      moods: ['calm', 'driving'], energies: ['low', 'high'], genres: ['Jazz', 'Rock'],
      eras: [{ fromYear: 1960, toYear: 1969 }, { fromYear: 1990, toYear: 1999 }],
    }, available);
    assert.equal(plan.length, 3);
    for (const call of plan) found.add(JSON.stringify(call.args));
  }
  for (const mood of ['calm', 'driving']) for (const energy of ['low', 'high']) {
    assert.ok(found.has(JSON.stringify({ mood, energy })));
  }
  for (const genre of ['Jazz', 'Rock']) assert.ok(found.has(JSON.stringify({ genre })));
  assert.ok(found.has(JSON.stringify({ fromYear: 1960, toYear: 1969 })));
  assert.ok(found.has(JSON.stringify({ fromYear: 1990, toYear: 1999 })));
});

test('a soft playlist is sampled even with one pass, while journey priority remains', () => {
  const scope = pickerScope({ playlistTracks: [{ id: 'p' }] });
  const available = new Set(['showPlaylistTracks', 'tracksByMood', 'randomSongs', 'tracksTowardJourney']);
  for (let rotationSeed = 0; rotationSeed < 30; rotationSeed++) {
    const plan = planShortlistSources({ scope, currentTrackId: 'seed', moods: ['calm'], discoveryPasses: 1, rotationSeed }, available);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].source, 'showPlaylistTracks');
  }
  const journey = planShortlistSources({ scope: pickerScope({ ...scope, audioWaypoint: [1] }), currentTrackId: 'seed', discoveryPasses: 1 }, available);
  assert.equal(journey[0].source, 'tracksTowardJourney');
});

test('server sonic discovery is gated and its real tool enforces the complete scope', async () => {
  assert.ok(!buildPickerTools().tools.sonicSimilarTracks);
  serverSongs = [
    { id: 'good', title: 'Good', artist: 'A', genres: [{ name: 'Jazz' }], duration: 240 },
    { id: 'wrong-genre', title: 'Wrong', artist: 'B', genres: [{ name: 'Rock' }], duration: 240 },
    { id: 'too-short', title: 'Short', artist: 'C', genres: [{ name: 'Jazz' }], duration: 20 },
    { id: 'too-long', title: 'Long', artist: 'D', genres: [{ name: 'Jazz' }], duration: 400 },
    { id: 'recent', title: 'Recent', artist: 'E', genres: [{ name: 'Jazz' }], duration: 240 },
    { id: 'excluded', title: 'Excluded', artist: 'F', genres: [{ name: 'Jazz' }], duration: 240 },
  ];
  const { tools, seen } = buildPickerTools(pickerScope({
    sonicSimilarity: true, genreLock: ['Jazz'], minTrackSec: 60, maxTrackSec: 300,
    hardRecentIds: new Set(['recent']), excludedIds: new Set(['excluded']),
  }));
  const result = await tools.sonicSimilarTracks.execute!({ songId: 'seed' }, { toolCallId: 'sonic-test', messages: [], context: undefined });
  assert.deepEqual((result as Array<{ id: string }>).map(track => track.id), ['good']);
  assert.deepEqual([...seen.keys()], ['good']);
  assert.ok(endpoints.includes('getSonicSimilarTracks'));
});

test('era discovery includes a reissue using its original year and excludes other eras', async () => {
  db.upsertTrackMeta('reissue', { title: 'Old music', artist: 'A', year: 2015, duration: 180 });
  db.upsertTrackTags('reissue', { moods: ['calm'], energy: 'low', source: 'manual' });
  db.setManualOriginalYear('reissue', 1964);
  db.upsertTrackMeta('modern', { title: 'Modern', artist: 'B', year: 2015, duration: 180 });
  db.upsertTrackTags('modern', { moods: ['calm'], energy: 'low', source: 'manual' });
  const { tools } = buildPickerTools();
  const result = await tools.songsByEra.execute!({ fromYear: 1960, toYear: 1969 }, { toolCallId: 'era-test', messages: [], context: undefined });
  assert.deepEqual((result as Array<{ id: string }>).map(track => track.id), ['reissue']);
  assert.equal((result as Array<{ year: number }>)[0].year, 1964);
});

test('merged artist caps and offered memory reduce concentration without excluding every track', () => {
  const candidates = Array.from({ length: 9 }, (_, i) => ({ id: `same-${i}`, artist: 'Same', title: String(i) }));
  const offers = new CandidateOffers();
  offers.record(['same-0', 'same-1', 'same-2']);
  const balanced = balanceShortlist(candidates, 3, offers);
  assert.equal(balanced.length, 3);
  assert.deepEqual(balanced.map(track => track.id), ['same-3', 'same-4', 'same-5']);
  assert.equal(balanceShortlist(candidates, Infinity, offers).length, 9, 'directed single-artist scopes can opt out');
  assert.equal(balanceShortlist(candidates.slice(0, 1), 3, offers).length, 1, 'offer memory never starves');
  const target = { bpm: 120, key: '8A' };
  const ranked = orderByTransitionFit(candidates, target, () => target, offers);
  assert.equal(ranked[0].id, 'same-3', 'the transition ordering must retain the offer penalty');
});

test('offer penalties expire, are capped, and clear for the actual final choice', () => {
  let now = 0;
  const offers = new CandidateOffers(() => now);
  for (let i = 0; i < 10; i++) offers.record(['rejected', 'chosen']);
  assert.equal(offers.penalty('rejected'), 0.45);
  offers.chosen('chosen');
  assert.equal(offers.penalty('chosen'), 0);
  now = 30 * 60_000;
  assert.equal(offers.penalty('rejected'), 0);
  offers.record(['rejected']);
  assert.equal(offers.penalty('rejected'), 0.15);
  offers.clear();
  assert.equal(offers.penalty('rejected'), 0);
  offers.record(Array.from({ length: 1001 }, (_, index) => `bounded-${index}`));
  assert.equal(offers.penalty('bounded-0'), 0, 'history retains at most 1,000 identities');
  assert.equal(offers.penalty('bounded-1000'), 0.15);
});

test('thin-list top-ups stop once enough balanced alternatives exist and retain provenance', async () => {
  const seen = new Map<string, any>();
  let randomCalls = 0;
  const tools = {
    mood: { execute: async () => { seen.set('a', { id: 'a', artist: 'A' }); return [{ id: 'a' }]; } },
    starredSongs: { execute: async () => {
      for (const id of ['b', 'c', 'd']) seen.set(id, { id, artist: id });
      return ['b', 'c', 'd'].map(id => ({ id }));
    } },
    randomSongs: { execute: async () => { randomCalls++; return []; } },
  };
  const result = await executeShortlistPlan(tools, seen, [{ source: 'mood', args: {}, family: 'context' }], {
    topUps: ['starredSongs', 'randomSongs'].map(source => ({ source, args: {}, family: 'diversity' })),
    minimumCandidates: 4, maxPerArtist: 3,
  });
  assert.equal(result.candidates.length, 4);
  assert.equal(randomCalls, 0);
  assert.deepEqual(result.sourceRuns.map(run => run.source), ['mood', 'starredSongs']);
  assert.deepEqual(result.candidates[1].shortlistSources, ['starredSongs']);
});

test('native thin-list recovery cannot restore an excluded track or override a strict playlist', async () => {
  serverSongs = [{ id: 'excluded', title: 'Excluded', artist: 'B', duration: 180 }];
  const result = await buildShortlist({
    scope: pickerScope({ playlistTracks: [{ id: 'only', title: 'Only', artist: 'A', duration: 180 }], playlistLock: new Set(['only']), excludedIds: new Set(['excluded']) }),
    currentTrackId: null, discoveryPasses: 1,
  }, new CandidateOffers());
  assert.deepEqual(result.candidates.map(track => track.id), ['only']);
  assert.ok(result.sourceRuns.length <= 3, 'one primary pass and at most two top-ups');
});
