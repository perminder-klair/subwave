import assert from 'node:assert/strict';
import test from 'node:test';
import { buildShortlist, executeShortlistPlan, orderByTransitionFit, planShortlistSources } from '../src/music/shortlist.js';
import { agenticSelectionReason } from '../src/broadcast/dj-agent/leanings-review.js';
import { pickerScope } from '../src/llm/tools.js';
import { buildPickerContext } from '../src/llm/internal/tools/picker/scope.js';
import { cacheSourcePool } from '../src/llm/internal/tools/picker/source-pool-cache.js';
import { shortlistCandidateForPick, shortlistClauseSelectionReason, shortlistPickPrompt, shortlistPickSchema, shortlistReasonForLeanings } from '../src/broadcast/dj-agent/shortlist-pick.js';

test('balances context, continuity and diversity lanes without inventing intent-driven sources', () => {
  const journey = planShortlistSources({
    scope: pickerScope({ audioWaypoint: [0.1] }),
    currentTrackId: 'seed', discoveryPasses: 3,
    moods: ['celebratory'], energies: ['high'],
  }, new Set(['tracksTowardJourney', 'tracksByMood', 'tracksThatSoundLikeThis', 'tracksLikeThis']));
  assert.deepEqual(journey, [
    { source: 'tracksTowardJourney', args: {}, family: 'context' },
    { source: 'tracksThatSoundLikeThis', args: { songId: 'seed' }, family: 'continuity' },
    { source: 'tracksByMood', args: { mood: 'celebratory', energy: 'high' }, family: 'context' },
  ]);

  const strictPlaylist = planShortlistSources({
    scope: pickerScope({ playlistTracks: [{ id: 'in-show' }], playlistLock: new Set(['in-show']) }),
    currentTrackId: 'seed', discoveryPasses: 5,
    moods: ['reflective'], energies: ['low'], explore: true,
  }, new Set(['showPlaylistTracks', 'tracksByMood', 'deepCuts']));
  assert.deepEqual(strictPlaylist.map((call) => call.source), [
    'showPlaylistTracks', 'tracksByMood', 'showPlaylistTracks', 'tracksByMood', 'showPlaylistTracks',
  ]);

  const empty = planShortlistSources({
    scope: pickerScope(), currentTrackId: 'seed', discoveryPasses: 3,
    moods: ['calm'], energies: ['low'],
  }, new Set(['tracksByMood']));
  assert.deepEqual(empty, [
    { source: 'tracksByMood', args: { mood: 'calm', energy: 'low' }, family: 'context' },
    { source: 'tracksByMood', args: { mood: 'calm', energy: 'low' }, family: 'context' },
    { source: 'tracksByMood', args: { mood: 'calm', energy: 'low' }, family: 'context' },
  ]);

  const balanced = planShortlistSources({
    scope: pickerScope(), currentTrackId: 'seed', discoveryPasses: 3,
    moods: ['calm'], energies: ['low'], genres: ['ambient'], explore: true,
  }, new Set([
    'tracksByMood', 'songsByGenre', 'tracksThatSoundLikeThis', 'tracksLikeThis', 'similarSongs',
    'deepCuts', 'starredSongs', 'recentlyAdded', 'randomSongs',
  ]));
  assert.deepEqual(new Set(balanced.map((call) => call.family)), new Set(['context', 'continuity', 'diversity']));
  assert.equal(balanced[0].source, 'deepCuts', 'an exploration nudge gets a pass even on narrow shortlists');
  assert.ok(!balanced.some((call) => ['searchLibrary', 'identifyRequestedTrack'].includes(call.source)));
});

test('native builder plans from source-owned availability before execution', async () => {
  // A no-index scope still keeps its usable mood source and an available
  // exploration source, without logging unavailable similarity probes.
  const result = await buildShortlist({
    scope: pickerScope(), currentTrackId: null, discoveryPasses: 1,
    moods: ['calm'], energies: ['low'],
  });
  assert.ok(result.sourceRuns.length > 0);
  assert.equal(result.sourceRuns[0].source, 'tracksByMood');
  assert.ok(result.sourceRuns.slice(1).every(run => ['starredSongs', 'randomSongs'].includes(run.source)),
    'thin results may use only the bounded recovery sources');
});

test('narrow shortlists rotate all discovery families and continuity sources across seeds', () => {
  const available = new Set([
    'tracksByMood', 'songsByGenre', 'tracksThatSoundLikeThis', 'tracksLikeThis', 'similarSongs',
    'deepCuts', 'starredSongs', 'recentlyAdded', 'randomSongs',
  ]);
  const families = new Set<string>();
  const continuity = new Set<string>();
  const narrowContinuity = new Set<string>();
  for (const currentTrackId of Array.from({ length: 30 }, (_, index) => `seed-${index}`)) {
    const context = { scope: pickerScope(), currentTrackId, moods: ['calm'], energies: ['low'], genres: ['ambient'] };
    const narrow = planShortlistSources({ ...context, discoveryPasses: 1 }, available);
    assert.equal(narrow.length, 1);
    families.add(narrow[0].family);
    if (narrow[0].family === 'continuity') narrowContinuity.add(narrow[0].source);
    const balanced = planShortlistSources({ ...context, discoveryPasses: 3 }, available);
    assert.equal(new Set(balanced.map(call => call.family)).size, 3);
    for (const call of balanced) if (call.family === 'continuity') continuity.add(call.source);
    assert.deepEqual(planShortlistSources({ ...context, discoveryPasses: 3 }, available), balanced);
  }
  assert.deepEqual(families, new Set(['context', 'continuity', 'diversity']));
  assert.deepEqual(continuity, new Set(['tracksThatSoundLikeThis', 'tracksLikeThis', 'similarSongs']));
  assert.deepEqual(narrowContinuity, new Set(['tracksThatSoundLikeThis', 'tracksLikeThis', 'similarSongs']));
});

test('a per-pick rotation seed varies the plan for one anchor and stays reproducible', () => {
  const available = new Set([
    'tracksByMood', 'songsByGenre', 'tracksThatSoundLikeThis', 'tracksLikeThis', 'similarSongs',
    'deepCuts', 'starredSongs', 'recentlyAdded', 'randomSongs',
  ]);
  for (const currentTrackId of ['same-anchor', null]) {
    const context = { scope: pickerScope(), currentTrackId, moods: ['calm'], genres: ['ambient'], discoveryPasses: 1 };
    const firstSources = new Set(
      Array.from({ length: 24 }, (_, seed) => planShortlistSources({ ...context, rotationSeed: seed }, available)[0].source),
    );
    assert.ok(firstSources.size > 1, `seeds must vary the plan for ${currentTrackId ?? 'a cold start'}`);
    assert.deepEqual(
      planShortlistSources({ ...context, rotationSeed: 7 }, available),
      planShortlistSources({ ...context, rotationSeed: 7 }, available),
    );
  }
});

test('DJ shortlist selection leaves id membership to the call site and keeps provenance out of its reason', () => {
  const schema = shortlistPickSchema(['candidate-a', 'candidate-b']);
  const parsed = schema.parse({
    id: 'candidate-a', musicalReason: 'its warmer texture opens the arrangement without breaking the sequence', usedMusicalLeanings: true, say: null, transition: null,
  });
  assert.equal('usedMusicalLeanings' in parsed, false, 'the model cannot self-report Leanings provenance');
  // #939: a schema-level enum turned a small model's id slip into a hard
  // reject before the near-miss repair could run. The id must parse so
  // pickViaSelectionRoute can repair or re-pick it.
  assert.equal(schema.parse({
    id: 'candidate-ax', musicalReason: 'its warmer texture opens the arrangement without breaking the sequence', say: null, transition: null,
  }).id, 'candidate-ax');
  assert.throws(() => shortlistPickSchema([]), /empty Track Shortlist/);
  const prompt = shortlistPickPrompt([{ id: 'candidate-a', title: 'One', shortlistSources: ['tracksByMood'] }]);
  assert.match(prompt, /candidate-a/);
  assert.match(prompt, /Track Shortlist/);
  const leaningsBlindPrompt = shortlistPickPrompt(
    [{ id: 'candidate-a', title: 'One', shortlistSources: ['tracksByMood'] }],
    {},
  );
  assert.doesNotMatch(leaningsBlindPrompt, /Favour patient dub|"musicalLeanings"/i);
  assert.match(leaningsBlindPrompt, /ordinary musical flow only/i);
});

test('Shortlist sees predecessor audio facts and applies the vanilla-neutral transition policy', () => {
  const prompt = shortlistPickPrompt(
    [{ id: 'candidate-a', title: 'One', bpm: 124, key: '8A' }],
    {
      currentTrack: {
        id: 'current', title: 'Current Song', artist: 'Current Artist', album: 'Album',
        bpm: 122, key: '7A', pace: 0.63,
      },
      recentTransitions: ['normal', 'washout', 'normal', 'washout'],
    },
  );
  const payload = JSON.parse(prompt.slice(0, prompt.indexOf('\n\nChoose one id'))) as {
    context: { currentTrack: Record<string, unknown>; recentTransitions: string[] };
  };
  assert.deepEqual(payload.context.currentTrack, {
    id: 'current', title: 'Current Song', artist: 'Current Artist', album: 'Album',
    bpm: 122, key: '7A', pace: 0.63,
  });
  assert.deepEqual(payload.context.recentTransitions, ['normal', 'washout', 'normal', 'washout']);
  assert.match(prompt, /oldest first/);
  assert.match(prompt, /strips a third identical effect/);
  assert.match(prompt, /Never use the same transition three picks running/);
  assert.match(prompt, /lean "normal" now unless this moment clearly calls for another/);
  assert.doesNotMatch(prompt, /default to (?:washout|sweep|blend|dissolve|chop|loop)/i,
    'the parity reminder must not bias the model away from one named effect');

  const effectsOff = shortlistPickPrompt([{ id: 'candidate-a', title: 'One' }], {});
  assert.doesNotMatch(effectsOff, /Never use the same transition three picks running/);
});

test('Shortlist sends a compact selection-only candidate payload', () => {
  const candidate = {
    id: 'candidate-a', title: 'One', artist: 'Artist', album: 'Album', year: 2001,
    genre: 'Rock', moods: ['driving'], energy: 'high', instrumental: false,
    bpm: 120, key: '8A', pace: 0.7, sections: 4, unaired: true,
    play_count: 2, last_played_days_ago: 30, artist_play_count: 5,
    artist_last_played_days_ago: 10, duration_sec: 240, intro_ms: 12_000,
    shortlistSources: ['deepCuts'], controllerOnly: 'never send',
  };
  assert.deepEqual(shortlistCandidateForPick(candidate), {
    id: 'candidate-a', title: 'One', artist: 'Artist', album: 'Album', year: 2001,
    genre: 'Rock', moods: ['driving'], energy: 'high', instrumental: false,
    bpm: 120, key: '8A', pace: 0.7, sections: 4, unaired: true,
    play_count: 2, last_played_days_ago: 30, artist_play_count: 5,
    artist_last_played_days_ago: 10,
    duration_sec: 240, intro_ms: 12_000, source: 'deepCuts',
  });
  const prompt = shortlistPickPrompt([candidate]);
  const payload = JSON.parse(prompt.slice(0, prompt.indexOf('\n\nChoose one id'))) as { shortlist: Array<Record<string, unknown>> };
  assert.equal(payload.shortlist.length, 1);
  assert.equal('shortlistSources' in payload.shortlist[0], false);
  assert.equal(payload.shortlist[0].duration_sec, 240);
  assert.equal(payload.shortlist[0].source, 'deepCuts');
  assert.equal(payload.shortlist[0].intro_ms, 12_000);
  assert.equal(shortlistCandidateForPick({ id: 'immediate', intro_ms: 0 }).intro_ms, 0,
    'a measured immediate start is distinct from an unknown intro');
  for (const intro_ms of [undefined, null, -1, NaN, Infinity, '12000']) {
    assert.equal('intro_ms' in shortlistCandidateForPick({ id: 'unknown', intro_ms }), false,
      'unknown or invalid intro measurements must not become facts for the model');
  }
  assert.doesNotMatch(prompt.slice(0, prompt.indexOf('\n\nChoose one id')), /\n\s+"/,
    'candidate JSON is compact rather than indentation-heavy');
});

test('Agentic presentation never attaches one track\'s note to another track', () => {
  const selected = { id: 'sam', title: 'How Do You Sleep?', artist: 'Sam Smith' };
  assert.equal(
    agenticSelectionReason(selected, 'Porcupine Tree — Of the New Day keeps the atmosphere moving.'),
    '“How Do You Sleep?” by Sam Smith offers a strong musical fit with the current flow.',
  );
  assert.equal(
    agenticSelectionReason(selected, 'Sam Smith — How Do You Sleep? keeps the atmosphere moving.'),
    'Sam Smith — How Do You Sleep? keeps the atmosphere moving.',
  );
  assert.equal(
    agenticSelectionReason(
      { id: 'gabriel', title: 'Digging in the Dirt', artist: 'Peter Gabriel' },
      'Peter Gabriel fits well with the current flow, and',
    ),
    '“Digging in the Dirt” by Peter Gabriel — fits well with the current flow.',
  );
  assert.equal(
    agenticSelectionReason(
      { id: 'qualls', title: 'Black Qualls', artist: 'Thundercat feat. Steve Lacy, Steve Arrington & Childish Gambino' },
      "Thundercat featuring Steve Lacy, Steve Arrington & Childish Gambino with Black Qualls fits the current low-energy vibe.",
    ),
    "Thundercat featuring Steve Lacy, Steve Arrington & Childish Gambino with Black Qualls fits the current low-energy vibe.",
  );
});

test('Shortlist reasons use verified identity and reject model backstage language', () => {
  const song = { artist: 'Prince', title: '1999' };
  assert.equal(
    shortlistClauseSelectionReason(song, 'its bright synth pulse gives the sequence a clean lift'),
    '“1999” by Prince — its bright synth pulse gives the sequence a clean lift.',
  );
  assert.equal(
    shortlistClauseSelectionReason(song, 'I chose this candidate from the shortlist for the queue'),
    '“1999” by Prince — its musical character fits the surrounding sequence naturally.',
  );
});

test('an unusable model reason never reaches the Booth as its placeholder', () => {
  const song = { artist: 'Massive Attack', title: 'Teardrop' };
  // A reason past the schema's 180-char ceiling is replaced by the fallback
  // placeholder during parsing; it must read as "no reason", not as prose.
  const parsed = shortlistPickSchema(['teardrop']).parse({ id: 'teardrop', musicalReason: 'x'.repeat(200), transition: null });
  const reason = shortlistClauseSelectionReason(song, parsed.musicalReason);
  assert.doesNotMatch(reason, /unavailable|\[/);
  assert.equal(reason, '“Teardrop” by Massive Attack — its musical character fits the surrounding sequence naturally.');
  assert.doesNotMatch(shortlistReasonForLeanings(reason.replace('its musical', '[musical reason unavailable] its'), true, song), /unavailable/);
});

test('Shortlist keeps natural claimed Leanings reasons and removes unclaimed ones', () => {
  const song = { artist: 'Prince', title: '1999' };
  assert.equal(
    shortlistReasonForLeanings('Prince - 1999 fits because the DJ has a broad alternative taste.', false, song),
    '“1999” by Prince — its musical character fits the surrounding sequence naturally.',
  );
  assert.equal(
    shortlistReasonForLeanings('Prince - 1999 fits because the DJ has a broad alternative taste.', true, song),
    'Prince - 1999 fits because the DJ has a broad alternative taste.',
  );
  assert.equal(
    shortlistReasonForLeanings('Blood Orange - Charcoal Baby matches Carol’s preference for atmospheric tracks.', false, { artist: 'Blood Orange', title: 'Charcoal Baby' }),
    '“Charcoal Baby” by Blood Orange — its musical character fits the surrounding sequence naturally.',
  );
});

test('replays a source plan, keeping the picker accumulator as the source of truth', async () => {
  const seen = new Map<string, any>();
  const tools = {
    energy: {
      inputSchema: { safeParse: (value: unknown) => ({ success: true, data: value }) },
      execute: async () => {
        seen.set('a', { id: 'a', title: 'One' });
        seen.set('b', { id: 'b', title: 'Two' });
        return [{ id: 'a' }, { id: 'b' }];
      },
    },
    duplicate: {
      inputSchema: { safeParse: (value: unknown) => ({ success: true, data: value }) },
      execute: async () => [{ id: 'a' }],
    },
  };

  const result = await executeShortlistPlan(tools, seen, [
    { source: 'energy', args: { energy: 'high' }, family: 'context' },
    { source: 'duplicate', args: {}, family: 'continuity' },
    { source: 'unavailable', args: {}, family: 'diversity' },
  ]);

  assert.equal(result.uniqueCandidates, 2);
  assert.deepEqual(result.candidates.map((candidate) => candidate.id), ['a', 'b']);
  assert.deepEqual(result.candidates[0].shortlistSources, ['energy']);
  assert.deepEqual(result.sourceRuns.map((run) => [run.source, run.status, run.returned, run.accepted]), [
    ['energy', 'ok', 2, 2],
    ['duplicate', 'ok', 1, 0],
    ['unavailable', 'unavailable', 0, 0],
  ]);
});

test('repeated mood passes reuse one library pool but still surface new candidates', async () => {
  const ctx = buildPickerContext(pickerScope());
  const pool = Array.from({ length: 5 }, (_, index) => ({
    id: `mood-${index}`, title: `Song ${index}`, artist: `Artist ${index}`,
    moods: ['calm'], energy: 'low',
  }));
  let reads = 0;
  const moodPool = cacheSourcePool((mood: string) => {
    reads++;
    assert.equal(mood, 'calm');
    return pool;
  });
  const tools = {
    tracksByMood: {
      inputSchema: { safeParse: (value: unknown) => ({ success: true, data: value }) },
      execute: async (args: unknown) => {
        const { mood, energy } = args as { mood: string; energy: string | null };
        return ctx.collect(moodPool(mood).filter((track) => !energy || track.energy === energy), 2);
      },
    },
  };

  const result = await executeShortlistPlan(tools, ctx.seen, [
    { source: 'tracksByMood', args: { mood: 'calm', energy: 'low' }, family: 'context' },
    { source: 'tracksByMood', args: { mood: 'calm', energy: 'low' }, family: 'context' },
  ]);

  assert.equal(reads, 1, 'the expensive source query runs only once for this pick');
  assert.deepEqual(result.sourceRuns.map((run) => run.accepted), [2, 2]);
  assert.equal(result.uniqueCandidates, 4, 'the second pass still broadens the shortlist');
  assert.equal(new Set(result.candidates.map((candidate) => candidate.id)).size, 4);
});

test('source-pool cache is keyed, retains empty results and retries failures', () => {
  let reads = 0;
  const pool = cacheSourcePool((key: string) => {
    reads++;
    if (key === 'broken') throw new Error('temporary read failure');
    return key === 'empty' ? [] : [key];
  });

  assert.deepEqual(pool('empty'), []);
  assert.deepEqual(pool('empty'), []);
  assert.deepEqual(pool('low'), ['low']);
  assert.deepEqual(pool('low'), ['low']);
  assert.deepEqual(pool('high'), ['high']);
  assert.throws(() => pool('broken'), /temporary read failure/);
  assert.throws(() => pool('broken'), /temporary read failure/);
  assert.equal(reads, 5);
});

test('records invalid input and source errors without abandoning later sources', async () => {
  const seen = new Map<string, any>();
  const tools = {
    invalid: {
      inputSchema: { safeParse: () => ({ success: false, error: { issues: [{ message: 'query required' }] } }) },
      execute: async () => { throw new Error('must not run'); },
    },
    failed: {
      execute: async () => { throw new Error('library offline'); },
    },
  };

  const result = await executeShortlistPlan(tools, seen, [
    { source: 'invalid', args: {}, family: 'context' },
    { source: 'failed', args: {}, family: 'diversity' },
  ]);

  assert.deepEqual(result.sourceRuns.map((run) => [run.status, run.error]), [
    ['invalid', 'query required'],
    ['error', 'library offline'],
  ]);
});

test('listener favourites join the context lane unless the show owns the direction', () => {
  const available = new Set(['tracksByMood', 'listenerFavourites', 'tracksLikeThis', 'deepCuts']);
  const general = { scope: pickerScope(), currentTrackId: 'seed', moods: ['calm'], discoveryPasses: 5 };
  let planned = 0;
  for (let rotationSeed = 0; rotationSeed < 12; rotationSeed++) {
    for (const call of planShortlistSources({ ...general, rotationSeed }, available)) {
      if (call.source !== 'listenerFavourites') continue;
      planned++;
      assert.equal(call.family, 'context');
      assert.deepEqual(call.args, {});
    }
  }
  assert.ok(planned > 0, 'an opted-in station draws its favourites');
  // The tool is only registered when likes influence the DJ and something is
  // liked, so an unavailable source is never planned.
  assert.ok(!planShortlistSources(general, new Set(['tracksByMood'])).some((call) => call.source === 'listenerFavourites'));
  for (const scope of [
    pickerScope({ playlistTracks: [{ id: 'in-show' }], playlistLock: new Set(['in-show']) }),
    pickerScope({ audioWaypoint: [0.1] }),
  ]) {
    const plan = planShortlistSources(
      { ...general, scope, rotationSeed: 1 },
      new Set([...available, 'showPlaylistTracks', 'tracksTowardJourney']),
    );
    assert.ok(!plan.some((call) => call.source === 'listenerFavourites'),
      'a strict playlist or journey does not spend a pass on a station-wide lean');
  }
});

test('the shortlist is ordered by transition fit, stably, and untouched without a target', () => {
  const analysis: Record<string, { bpm: number | null; key: string | null; keyStart?: string | null }> = {
    clash: { bpm: 90, key: '3B' },
    unknown: { bpm: null, key: null },
    locked: { bpm: 124, key: '8A' },
    close: { bpm: 121, key: '9A' },
  };
  const candidates = ['clash', 'unknown', 'locked', 'close'].map((id) => ({ id }));
  const of = (candidate: { id: string }) => analysis[candidate.id];
  assert.deepEqual(
    orderByTransitionFit(candidates, { bpm: 124, key: '8A' }, of).map((candidate) => candidate.id),
    ['locked', 'close', 'clash', 'unknown'],
    'locked tempo and key lead, an adjacent key follows, and the unscored keep their plan order',
  );
  assert.deepEqual(
    orderByTransitionFit(candidates, { bpm: null, key: '3B', keyEnd: '8A' }, of).map((candidate) => candidate.id),
    ['locked', 'close', 'clash', 'unknown'],
    'the seam meets the target at its ending key, not its dominant one',
  );
  assert.equal(orderByTransitionFit(candidates, null, of), candidates);
  assert.equal(orderByTransitionFit(candidates, { bpm: null, key: null }, of), candidates,
    'an unanalysed predecessor leaves the plan order alone');
});

test('the Shortlist prompt describes each selection signal only when it is present', () => {
  const bare = shortlistPickPrompt([{ id: 'a', title: 'One' }], {});
  for (const pattern of [/recentPlays/, /listenerFavourites/, /mix run/]) assert.doesNotMatch(bare, pattern);

  const context = {
    recentPlays: [{ title: 'Before', artist: 'Act', moods: ['calm'], energy: 'low' }],
    listenerFavourites: [{ title: 'Loved', artist: 'Crowd', likes: 3 }],
    mixRun: { bpm: 124, key: '8A' },
  };
  const prompt = shortlistPickPrompt([{ id: 'a', title: 'One' }], context);
  const payload = JSON.parse(prompt.slice(0, prompt.indexOf('\n\nChoose one id'))) as { context: typeof context };
  assert.deepEqual(payload.context, context);
  assert.match(prompt, /recentPlays holds tracks that have already aired, newest first/);
  assert.match(prompt, /currentTrack is the expected predecessor and may not be on air yet/);
  assert.match(prompt, /listenerFavourites are the tracks listeners have liked most/);
  assert.match(prompt, /never loop the same favourites back to back/);
  assert.match(prompt, /DJ-mode mix run is active/);
  assert.match(prompt, /ordinary musical flow only/i, 'the preliminary pick stays Leanings-blind');
});
