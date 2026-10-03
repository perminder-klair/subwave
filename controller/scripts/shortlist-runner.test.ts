import assert from 'node:assert/strict';
import test from 'node:test';
import { buildShortlist, executeShortlistPlan, planShortlistSources, replayFixtureTrace } from '../src/music/shortlist.js';
import { pickerScope } from '../src/llm/tools.js';
import { buildPickerContext } from '../src/llm/internal/tools/picker/scope.js';
import { cacheSourcePool } from '../src/llm/internal/tools/picker/source-pool-cache.js';
import { shortlistCandidateForPick, shortlistClauseSelectionReason, shortlistLeaningsSource, shortlistPickPrompt, shortlistPickSchema, shortlistReasonForLeanings, shortlistSelectionReason } from '../src/music/dj-pick.js';

test('makes a redacted, replayable trace with source arguments and candidate ids', () => {
  const trace = replayFixtureTrace({
    currentTrack: { id: 'current', title: 'Current Song', artist: 'Current Artist', album: 'Album' },
    show: { id: 'show-1', name: 'Night Shift', genres: ['ambient'], filtersStrict: true },
    scope: pickerScope({
      recentIds: new Set(['recent-b', 'recent-a']),
      playlistTracks: [{ id: 'playlist-track', title: 'Never logged' }],
      audioWaypoint: [0.1, 0.2],
    }),
    toolCalls: [{
      name: 'tracksLikeThis', args: { songId: 'current' }, round: 2,
      result: { tracks: [{ id: 'candidate-a', title: 'Only the id survives' }] },
    }],
  });

  assert.deepEqual(trace.sourceCalls, [{
    source: 'tracksLikeThis', args: { songId: 'current' }, round: 2, candidateIds: ['candidate-a'],
  }]);
  assert.deepEqual(trace.scope.recentIds, ['recent-a', 'recent-b']);
  assert.deepEqual(trace.scope.playlistTrackIds, ['playlist-track']);
  assert.equal(trace.currentTrack.title, 'Current Song');
  assert.equal('title' in trace.sourceCalls[0], false);
});

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
  assert.deepEqual(balanced.map((call) => call.family), ['context', 'continuity', 'diversity']);
  assert.equal(balanced[2].source, 'deepCuts');
  assert.ok(!balanced.some((call) => ['searchLibrary', 'identifyRequestedTrack'].includes(call.source)));
});

test('native builder plans from source-owned availability before execution', async () => {
  // A no-index scope still keeps its usable mood source and an available
  // exploration source, without logging unavailable similarity probes.
  const result = await buildShortlist({
    scope: pickerScope(), currentTrackId: 'seed', discoveryPasses: 1,
    moods: ['calm'], energies: ['low'],
  });
  assert.ok(result.sourceRuns.length > 0);
  assert.ok(result.sourceRuns.every((run) => run.source === 'tracksByMood'));
});

test('DJ shortlist selection accepts only supplied ids and keeps provenance out of its reason', () => {
  const schema = shortlistPickSchema(['candidate-a', 'candidate-b']);
  const parsed = schema.parse({
    id: 'candidate-a', musicalReason: 'its warmer texture opens the arrangement without breaking the sequence', usedMusicalLeanings: true, say: null, transition: null,
  });
  assert.equal('usedMusicalLeanings' in parsed, false, 'the model cannot self-report Leanings provenance');
  assert.equal(schema.safeParse({
    id: 'invented', musicalReason: 'its warmer texture opens the arrangement without breaking the sequence', say: null, transition: null,
  }).success, false);
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
  });
  const prompt = shortlistPickPrompt([candidate]);
  const payload = JSON.parse(prompt.slice(0, prompt.indexOf('\n\nChoose one id'))) as { shortlist: Array<Record<string, unknown>> };
  assert.equal(payload.shortlist.length, 1);
  assert.equal('shortlistSources' in payload.shortlist[0], false);
  assert.equal('duration_sec' in payload.shortlist[0], false);
  assert.equal('intro_ms' in payload.shortlist[0], false);
  assert.doesNotMatch(prompt.slice(0, prompt.indexOf('\n\nChoose one id')), /\n\s+"/,
    'candidate JSON is compact rather than indentation-heavy');
});

test('shortlist presentation never attaches one track\'s note to another track', () => {
  const selected = { id: 'sam', title: 'How Do You Sleep?', artist: 'Sam Smith' };
  assert.equal(
    shortlistSelectionReason(selected, 'Porcupine Tree — Of the New Day keeps the atmosphere moving.'),
    'Selected "How Do You Sleep? by Sam Smith" from the eligible shortlist.',
  );
  assert.equal(
    shortlistSelectionReason(selected, 'Sam Smith — How Do You Sleep? keeps the atmosphere moving.'),
    'Sam Smith — How Do You Sleep? keeps the atmosphere moving.',
  );
  assert.equal(
    shortlistSelectionReason(
      { id: 'gabriel', title: 'Digging in the Dirt', artist: 'Peter Gabriel' },
      'Peter Gabriel fits well with the current flow, and',
    ),
    '“Digging in the Dirt” by Peter Gabriel — fits well with the current flow.',
  );
  assert.equal(
    shortlistSelectionReason(
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
  const context = {
    host: 'Favour patient dub.',
    guest: { musicalLeanings: 'Warm voices and strong melodies.' },
  };
  assert.equal(shortlistLeaningsSource(context, 'patient dub'), 'host');
  assert.equal(shortlistLeaningsSource(context, 'Warm voices'), 'guest');
  assert.equal(shortlistLeaningsSource(context, 'invented taste'), null);
});

test('Shortlist keeps natural claimed Leanings reasons and removes unclaimed ones', () => {
  const song = { artist: 'Prince', title: '1999' };
  assert.equal(
    shortlistReasonForLeanings('Prince - 1999 fits because the DJ has a broad alternative taste.', false, song),
    'Prince — 1999: selected for its fit with the current musical flow.',
  );
  assert.equal(
    shortlistReasonForLeanings('Prince - 1999 fits because the DJ has a broad alternative taste.', true, song),
    'Prince - 1999 fits because the DJ has a broad alternative taste.',
  );
  assert.equal(
    shortlistReasonForLeanings('Blood Orange - Charcoal Baby matches Carol’s preference for atmospheric tracks.', false, { artist: 'Blood Orange', title: 'Charcoal Baby' }),
    'Blood Orange — Charcoal Baby: selected for its fit with the current musical flow.',
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
      execute: async ({ mood, energy }: { mood: string; energy: string | null }) =>
        ctx.collect(moodPool(mood).filter((track) => !energy || track.energy === energy), 2),
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
