import assert from 'node:assert/strict';
import test from 'node:test';
import { buildShortlist, executeShortlistPlan, planShortlistSources, replayFixtureTrace } from '../src/music/shortlist.js';
import { pickerScope } from '../src/llm/tools.js';
import { shortlistPickPrompt, shortlistPickSchema, shortlistRepickPrompt, usableSelectionReason } from '../src/music/dj-pick.js';

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

test('cycles context, continuity, and exploration source lanes without adding sources', () => {
  const journey = planShortlistSources({
    scope: pickerScope({ audioWaypoint: [0.1] }),
    currentTrackId: 'seed', discoveryPasses: 3,
    moods: ['celebratory'], energies: ['high'],
  }, new Set(['tracksTowardJourney', 'tracksByMood', 'tracksThatSoundLikeThis', 'tracksLikeThis']));
  // No exploration source is registered in this fixture, so pass three falls
  // back to the next context source instead of wasting the pass.
  assert.deepEqual(journey, [
    { source: 'tracksByMood', args: { mood: 'celebratory', energy: 'high' } },
    { source: 'tracksThatSoundLikeThis', args: { songId: 'seed' } },
    { source: 'tracksTowardJourney', args: {} },
  ]);

  const rotating = planShortlistSources({
    scope: pickerScope({ audioWaypoint: [0.1] }),
    currentTrackId: 'seed', discoveryPasses: 5,
    moods: ['celebratory'], energies: ['high'],
  }, new Set([
    'tracksTowardJourney', 'tracksByMood',
    'tracksThatSoundLikeThis', 'tracksLikeThis', 'similarSongs',
    'deepCuts', 'recentlyAdded', 'starredSongs', 'randomSongs',
  ]));
  assert.equal(rotating.length, 5);
  assert.ok(['tracksTowardJourney', 'tracksByMood'].includes(rotating[0].source));
  assert.ok(['tracksThatSoundLikeThis', 'tracksLikeThis', 'similarSongs'].includes(rotating[1].source));
  assert.ok(['deepCuts', 'recentlyAdded', 'starredSongs', 'randomSongs'].includes(rotating[2].source));
  assert.ok(['tracksTowardJourney', 'tracksByMood'].includes(rotating[3].source));
  assert.ok(['tracksThatSoundLikeThis', 'tracksLikeThis', 'similarSongs'].includes(rotating[4].source));
  assert.notEqual(rotating[0].source, rotating[3].source);
  assert.notEqual(rotating[1].source, rotating[4].source);

  const strictPlaylist = planShortlistSources({
    scope: pickerScope({ playlistTracks: [{ id: 'in-show' }], playlistLock: new Set(['in-show']) }),
    currentTrackId: 'seed', discoveryPasses: 5,
    moods: ['reflective'], energies: ['low'], explore: true,
  }, new Set(['showPlaylistTracks', 'tracksByMood', 'deepCuts']));
  assert.deepEqual(strictPlaylist.map((call) => call.source), [
    'showPlaylistTracks', 'deepCuts', 'deepCuts', 'showPlaylistTracks', 'deepCuts',
  ]);

  const empty = planShortlistSources({
    scope: pickerScope(), currentTrackId: 'seed', discoveryPasses: 3,
    moods: ['calm'], energies: ['low'],
  }, new Set(['tracksByMood']));
  assert.deepEqual(empty, [
    { source: 'tracksByMood', args: { mood: 'calm', energy: 'low' } },
    { source: 'tracksByMood', args: { mood: 'calm', energy: 'low' } },
    { source: 'tracksByMood', args: { mood: 'calm', energy: 'low' } },
  ]);
});

test('native builder plans from source-owned availability before execution', async () => {
  // A no-index scope exposes mood but not either similarity source. The builder
  // must keep its usable mood source and an available exploration source rather
  // than logging unavailable similarity probes just because a current track id
  // exists.
  const result = await buildShortlist({
    scope: pickerScope(), currentTrackId: 'seed', discoveryPasses: 3,
    moods: ['calm'], energies: ['low'],
  });
  assert.ok(result.sourceRuns.length > 0);
  assert.ok(result.sourceRuns.some((run) => run.source === 'tracksByMood'));
  assert.ok(result.sourceRuns.every((run) => run.status !== 'unavailable'));
});

test('DJ shortlist selection accepts only supplied ids and keeps provenance out of its reason', () => {
  const schema = shortlistPickSchema(['candidate-a', 'candidate-b']);
  assert.equal(schema.safeParse({
    id: 'candidate-a', selectionReason: 'One by Artist keeps the warmer texture after the opener.', say: null, transition: null,
  }).success, true);
  assert.equal(schema.safeParse({
    id: 'invented', selectionReason: 'not allowed', say: null, transition: null,
  }).success, false);
  const weakReason = schema.safeParse({
    id: 'candidate-a', selectionReason: 'I', say: null, transition: null,
  });
  assert.equal(weakReason.success, true);
  if (weakReason.success) assert.equal(weakReason.data.selectionReason, '[selection note unavailable]');
  const prompt = shortlistPickPrompt(
    [{ id: 'candidate-a', title: 'One', shortlistSources: ['tracksByMood'] }],
    {
      currentTrack: { id: 'seed' },
      link: 'Set say to null.',
      musicalLeanings: 'favour warm electronic edges',
      guestMusicalLeanings: {
        guest: { id: 'p_terry', name: 'Terry' },
        musicalLeanings: 'favour trip-hop classics',
      },
    },
  );
  assert.match(prompt, /candidate-a/);
  assert.match(prompt, /"seed"/);
  assert.match(prompt, /favour warm electronic edges/);
  assert.match(prompt, /Terry/);
  assert.match(prompt, /Guest Musical Leaning/);
  assert.match(prompt, /Track Shortlist/);
  assert.match(prompt, /Musical Leanings/);
  assert.match(prompt, /private Booth Log note/);
  assert.match(prompt, /next up/);
});

test('shortlist selection note cannot become on-air queue language', () => {
  const song = { artist: 'Artist', title: 'Track' };
  assert.equal(
    usableSelectionReason('Artist — Track holds the darker texture after the opener.', song),
    'Artist — Track holds the darker texture after the opener.',
  );
  assert.equal(
    usableSelectionReason('I', song),
    'Artist — Track: selected for its fit with the current musical flow.',
  );
  assert.equal(
    usableSelectionReason('Next up, Artist with Track.', song),
    'Artist — Track: selected for its fit with the current musical flow.',
  );
});

test('native artist repick receives only its alternate shortlist', () => {
  const schema = shortlistPickSchema(['other-artist']);
  assert.equal(schema.safeParse({
    id: 'other-artist', selectionReason: 'keeps the energy moving', say: null, transition: null,
  }).success, true);
  assert.equal(schema.safeParse({
    id: 'on-air-artist', selectionReason: 'must not be selectable', say: null, transition: null,
  }).success, false);

  const prompt = shortlistRepickPrompt(
    [{ id: 'other-artist', title: 'Fresh choice', shortlistSources: ['tracksByMood'] }],
    'The prior selection repeats the artist already on air.',
  );
  assert.match(prompt, /repeats the artist already on air/);
  assert.match(prompt, /other-artist/);
  assert.match(prompt, /do not discover or suggest another track/);
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
    { source: 'energy', args: { energy: 'high' } },
    { source: 'duplicate', args: {} },
    { source: 'unavailable', args: {} },
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
    { source: 'invalid', args: {} },
    { source: 'failed', args: {} },
  ]);

  assert.deepEqual(result.sourceRuns.map((run) => [run.status, run.error]), [
    ['invalid', 'query required'],
    ['error', 'library offline'],
  ]);
});
