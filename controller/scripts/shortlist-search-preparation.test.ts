import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const root = await mkdtemp(join(tmpdir(), 'subwave-search-preparation-'));
process.env.STATE_DIR = root;
const { createShortlistSearchPreparation: createPreparation } = await import('../src/broadcast/shortlist-search-preparation.js');
// The synthetic verifier approves only the structurally grounded proposals.
// Semantic rejection and deadline behavior have dedicated cases below.
function createShortlistSearchPreparation(deps: Omit<Parameters<typeof createPreparation>[0], 'verify'>
  & Partial<Pick<Parameters<typeof createPreparation>[0], 'verify'>>) {
  return createPreparation({ ...deps, verify: deps.verify ?? (async prompt => ({
    accepted: JSON.parse(prompt).proposals.map((proposal: { index: number }) => proposal.index),
  })) });
}
const { groundShortlistSearches, shortlistSearchCalls } = await import('../src/music/shortlist-search.js');
const { planShortlistSources } = await import('../src/music/shortlist.js');
const { pickerScope } = await import('../src/llm/tools.js');
after(() => rm(root, { recursive: true, force: true }));
const base = Date.now();
const brief = { occurrenceId: 'show:one', expiresAt: base + 3600_000, topic: 'Songs about coming home' };
const response = { searches: [{ kind: 'theme', intent: 'theme', query: 'coming home', evidence: brief.topic }] };
const presenterBrief = await readFile(new URL('./fixtures/shortlist-search/presenter-show-brief.md', import.meta.url), 'utf8');
const bobBrief = await readFile(new URL('./fixtures/shortlist-search/bob-show-brief.md', import.meta.url), 'utf8');
const sentence = (text: string, subject: string) => [...new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(text)]
  .find(part => part.segment.includes(subject))!.segment.trim();

test('a presenter biography rejects invented subjects and caches the successful empty classification', async () => {
  let calls = 0;
  const file = join(root, 'presenter.json');
  const deps = { file, now: () => base, generate: async () => {
    calls++;
    return { searches: [
      { kind: 'theme', intent: 'theme', query: 'everyday life', evidence: sentence(presenterBrief, 'working day') },
      { kind: 'artist', intent: 'presenter', query: 'Taylor Example', evidence: sentence(presenterBrief, 'Taylor Example') },
      { kind: 'library', intent: 'general', query: 'overlooked album track', evidence: sentence(presenterBrief, 'overlooked') },
    ] };
  } };
  const input = { ...brief, topic: presenterBrief, presenterNames: ['Taylor Example'] };
  assert.deepEqual(await createShortlistSearchPreparation(deps).ensure(input), []);
  assert.deepEqual(await createShortlistSearchPreparation(deps).ensure(input), []);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).records[0].status, 'ready');
});

test('grounding rejects invented subjects, partial prohibition quotes and presenter names regardless of intent', () => {
  assert.deepEqual(groundShortlistSearches([
    { kind: 'theme', intent: 'theme', query: 'everyday life', evidence: 'Songs about coming home' },
    { kind: 'library', intent: 'artist', query: 'Radiohead', evidence: 'Radiohead tracks' },
    { kind: 'artist', intent: 'artist', query: 'Taylor', evidence: 'Music from Taylor Example' },
  ], [brief.topic, 'Avoid Radiohead tracks.', 'Music from Taylor Example'], ['Taylor Example']), []);
  assert.deepEqual(groundShortlistSearches([
    { kind: 'artist', intent: 'artist', query: 'Bob Dylan', evidence: 'Play songs by Bob Dylan' },
  ], ['Play songs by Bob Dylan'], ['Bob']), [{ kind: 'artist', query: 'Bob Dylan' }],
  'a shared first name does not make an explicitly named recording artist a host');
});

test('explicit music subjects in the supplied brief survive without fixture-specific word lists', async () => {
  const searches = [
    { kind: 'artist' as const, intent: 'artist' as const, query: 'R.E.M.', evidence: sentence(bobBrief, 'R.E.M.') },
    { kind: 'library' as const, intent: 'genre' as const, query: 'Britpop', evidence: sentence(bobBrief, 'Britpop') },
    { kind: 'sound' as const, intent: 'sound' as const, query: 'melodic guitars, acoustic tracks, strong basslines', evidence: sentence(bobBrief, 'melodic guitars') },
  ];
  const expected = searches.map(({ kind, query }) => ({ kind, query }));
  const owner = createShortlistSearchPreparation({ file: join(root, 'bob.json'), now: () => base,
    generate: async prompt => {
      assert.equal(JSON.parse(prompt).topic, bobBrief.trim());
      return { searches };
    } });
  assert.deepEqual(await owner.ensure({ ...brief, topic: bobBrief, presenterNames: ['Bob'] }), expected);
  assert.deepEqual(shortlistSearchCalls(expected, new Set(['topSongsByArtist', 'searchLibrary', 'searchBySound']))
    .map(call => call.source), ['topSongsByArtist', 'searchLibrary', 'searchBySound']);
  assert.deepEqual(groundShortlistSearches([
    { kind: 'library', intent: 'general', query: 'forgotten favourites', evidence: sentence(bobBrief, 'forgotten favourites') },
    { kind: 'library', intent: 'exclude', query: 'manufactured pop', evidence: sentence(bobBrief, 'manufactured pop') },
  ], [bobBrief], ['Bob']), []);
});

test('grounding works in the brief language rather than matching English musical cues', () => {
  for (const [kind, intent, query, evidence] of [
    ['artist', 'artist', 'Björk', 'Spiele Musik von Björk.'],
    ['theme', 'theme', 'retour à la maison', 'Des chansons sur le retour à la maison.'],
    ['sound', 'sound', 'گیتار آکوستیک', 'موسیقی با گیتار آکوستیک پخش کن.'],
    ['theme', 'theme', '回家', '播放关于回家的歌曲。'],
    ['library', 'title', 'Everyday Life', 'Play the track “Everyday Life”.'],
    ['recentArtist', 'recentArtist', 'Portishead', 'Spiele die neuesten Veröffentlichungen von Portishead.'],
  ] as const) {
    assert.deepEqual(groundShortlistSearches([{ kind, intent, query, evidence }], [evidence]), [{ kind, query }]);
  }
  assert.deepEqual(groundShortlistSearches([
    { kind: 'recentArtist', intent: 'artist', query: 'Portishead', evidence: 'Explore Portishead tracks.' },
    { kind: 'library', intent: 'exclude', query: 'Radiohead', evidence: 'Ne joue pas Radiohead.' },
  ], ['Explore Portishead tracks.', 'Ne joue pas Radiohead.']), []);
});

test('pre-grounding cache records are discarded even when their identity matches', async () => {
  const file = join(root, 'upgrade.json');
  const deps = { file, now: () => base, generate: async () => response };
  await createShortlistSearchPreparation(deps).ensure(brief);
  const previous = JSON.parse(await readFile(file, 'utf8'));
  previous.version = 1;
  previous.records[0].searches = [{ kind: 'artist', query: 'Taylor Example' }];
  await writeFile(file, JSON.stringify(previous));
  let calls = 0;
  assert.deepEqual(await createShortlistSearchPreparation({ ...deps,
    generate: async () => { calls++; return { searches: [] }; },
  }).ensure(brief), []);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 4);
});

test('concurrent calls, later picks and a restarted owner reuse one durable preparation', async () => {
  let calls = 0;
  const deps = { file: join(root, 'reuse.json'), now: () => base, generate: async () => { calls++; return response; } };
  const owner = createShortlistSearchPreparation(deps);
  const results = await Promise.all(Array.from({ length: 8 }, () => owner.ensure(brief)));
  assert.equal(calls, 1);
  assert.ok(results.every(searches => searches[0]?.query === 'coming home'));
  await owner.ensure(brief);
  await createShortlistSearchPreparation(deps).ensure(brief);
  assert.equal(calls, 1, 'restart must not repeat the model call');
});

test('a new airing or edited brief prepares independently, while an empty result is cached', async () => {
  let calls = 0;
  const owner = createShortlistSearchPreparation({ file: join(root, 'identity.json'), now: () => base,
    generate: async () => { calls++; return { searches: [] }; } });
  await owner.ensure(brief); await owner.ensure(brief);
  assert.equal(calls, 1);
  await owner.ensure({ ...brief, topic: 'Songs about leaving home' });
  await owner.ensure({ ...brief, occurrenceId: 'show:two' });
  assert.equal(calls, 3);
});

test('unusable output falls back immediately with a durable cooldown and at most two attempts', async () => {
  let clock = base; let calls = 0;
  const deps = { file: join(root, 'failure.json'), now: () => clock,
    generate: async () => { calls++; return { searches: [{ kind: 'executeShell', query: 'bad' }] }; } };
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


test('two passes with a soft playlist retain the playlist and rotate targeted intent with ordinary discovery', () => {
  const scope = pickerScope({ hasPlaylistAnchor: true, playlistTracks: [{ id: 'curated' }] });
  const available = new Set(['showPlaylistTracks', 'searchLibrary', 'randomSongs']);
  const seen = new Set<string>();
  for (let rotationSeed = 0; rotationSeed < 36; rotationSeed++) {
    const plan = planShortlistSources({ scope, currentTrackId: null, discoveryPasses: 2, rotationSeed,
      searches: [{ kind: 'library', query: 'Portishead' }] }, available);
    assert.equal(plan.length, 2);
    assert.equal(plan[0].source, 'showPlaylistTracks');
    seen.add(plan[1].source);
  }
  assert.ok(seen.has('searchLibrary') && seen.has('randomSongs'));
});


test('grounding and cache identity use the exact input snapshot sent to the model', async () => {
  let finish!: (value: unknown) => void;
  let begin!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  const owner = createShortlistSearchPreparation({ file: join(root, 'snapshot.json'), now: () => base,
    generate: async () => { begin(); return new Promise(resolve => { finish = resolve; }); } });
  const input = { ...brief };
  const running = owner.ensure(input);
  await started;
  input.topic = 'A different request';
  input.expiresAt = base;
  finish(response);
  assert.deepEqual(await running, [{ kind: 'theme', query: 'coming home' }]);
  assert.deepEqual(await owner.ensure(brief), [{ kind: 'theme', query: 'coming home' }]);
});

test('an independent verifier rejects whole biography sentences despite title, genre and theme labels', async () => {
  const evidence = sentence(presenterBrief, 'overlooked');
  let verifications = 0;
  const file = join(root, 'mislabelled-biography.json');
  const deps = {
    file, now: () => base,
    generate: async () => ({ searches: [
      { kind: 'library', intent: 'title', query: 'overlooked album track', evidence },
      { kind: 'library', intent: 'genre', query: 'overlooked album track', evidence },
      { kind: 'theme', intent: 'theme', query: 'overlooked album track', evidence },
    ] }),
    verify: async (prompt: string) => {
      verifications++;
      const input = JSON.parse(prompt);
      assert.equal(input.brief.topic, presenterBrief.trim());
      assert.equal(input.proposals.length, 3, 'full quoted sentences pass the literal check');
      assert.doesNotMatch(prompt, /"intent"/, 'verification cannot inherit the proposed labels');
      return { accepted: [] };
    },
  };
  const input = { ...brief, topic: presenterBrief, presenterNames: ['Taylor Example'] };
  assert.deepEqual(await createPreparation(deps).ensure(input), []);
  assert.deepEqual(await createPreparation(deps).ensure(input), []);
  assert.equal(verifications, 1, 'verified empty results survive a restart');
});

test('verification fails closed on an invalid verdict and shares the preparation cooldown', async () => {
  for (const [i, verdict] of [{ accepted: [2] }, { accepted: [0], extra: true }, null].entries()) {
    const file = join(root, `bad-verdict-${i}.json`);
    const owner = createPreparation({ file, now: () => base, generate: async () => response, verify: async () => verdict });
    assert.deepEqual(await owner.ensure(brief), []);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).records[0].status, 'failed');
  }
});

test('verification has its own deadline and a late verdict cannot publish searches', async () => {
  let generationSignal: AbortSignal | undefined;
  let verificationSignal: AbortSignal | undefined;
  let finish!: (verdict: unknown) => void;
  const file = join(root, 'verification-deadline.json');
  const owner = createPreparation({ file, now: () => base, timeoutMs: 40,
    generate: async (_prompt, signal) => { generationSignal = signal; return response; },
    verify: (_prompt, signal) => { verificationSignal = signal; return new Promise(resolve => { finish = resolve; }); },
  });
  assert.deepEqual(await owner.ensure(brief), []);
  assert.notEqual(generationSignal, verificationSignal);
  assert.equal(generationSignal?.aborted, false, 'a finished generation is not cancelled by the verification deadline');
  assert.equal(verificationSignal?.aborted, true);
  finish({ accepted: [0] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.parse(await readFile(file, 'utf8')).records[0].status, 'failed');
  assert.deepEqual(await owner.ensure(brief), []);
});

test('a slow generation does not spend the verification deadline', async () => {
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const owner = createPreparation({ file: join(root, 'separate-deadlines.json'), now: () => base, timeoutMs: 200,
    generate: async () => { await wait(120); return response; },
    verify: async () => { await wait(120); return { accepted: [0] }; },
  });
  assert.deepEqual(await owner.ensure(brief), [{ kind: 'theme', query: 'coming home' }],
    'each call fits its own deadline though together they exceed one');
});

test('empty preparation skips verification and older unverified records are discarded', async () => {
  const file = join(root, 'unverified-upgrade.json');
  let calls = 0;
  const deps = { file, now: () => base, generate: async () => { calls++; return { searches: [] }; },
    verify: async () => { throw new Error('empty proposals must never be verified'); } };
  await createPreparation(deps).ensure(brief);
  const previous = JSON.parse(await readFile(file, 'utf8'));
  previous.version = 3;
  previous.records[0].searches = [{ kind: 'theme', query: 'biography' }];
  await writeFile(file, JSON.stringify(previous));
  assert.deepEqual(await createPreparation(deps).ensure(brief), []);
  assert.equal(calls, 2);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 4);
});
