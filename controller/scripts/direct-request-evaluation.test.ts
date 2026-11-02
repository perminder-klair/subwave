import assert from 'node:assert/strict';
import test from 'node:test';
import { directRequestCases, runDirectRequestCase, checkDirectRequestCase } from './llm-bench/direct-request.js';

// Validate the evaluation's verdicts independently of any available model.
// Live runs use the same cases with the production matchRequest call.
test('evaluation detects a dropped language requirement even if selection reports matched', async () => {
  const c = directRequestCases.find(c => c.name === 'named-song-language')!;
  const out = await runDirectRequestCase(c, async () => ({ title: 'Bohemian Rhapsody', artist: 'Queen' }));
  assert.equal(out.selection.outcome, 'matched');
  assert.ok(checkDirectRequestCase(c, out).includes('selection:wrong-track'));
  assert.ok(checkDirectRequestCase(c, out).includes('interpretation:language'));
});

test('evaluation keeps unmet moods diagnostic without mislabelling identity', async () => {
  const c = directRequestCases.find(c => c.name === 'mood-compromise')!;
  const out = await runDirectRequestCase(c, async () => ({ artist: 'Fixture Band', mood: 'calm' }));
  assert.deepEqual(checkDirectRequestCase(c, out), []);
  assert.deepEqual(out.selection.unmetPreferences, ['mood']);
  assert.ok(checkDirectRequestCase(c, { ...out, selection: { ...out.selection, outcome: 'substituted' } }).length);
});

test('evaluation exercises the exclusion backstop when a model drops the condition', async () => {
  const c = directRequestCases.find(c => c.name === 'exclusion')!;
  const out = await runDirectRequestCase(c, async () => ({ artist: 'Queen' }));
  assert.deepEqual(checkDirectRequestCase(c, out), []);
  assert.equal(out.selection.track, null);
});

test('evaluation blocks film identification even when the model guesses a named song', async () => {
  const c = directRequestCases.find(c => c.name === 'film-identification')!;
  const out = await runDirectRequestCase(c, async () => ({ title: 'Something', artist: 'The Beatles' }));
  assert.equal(out.selection.outcome, 'unsupported');
  assert.equal(out.selection.track, null);
});

test('evaluation requires both artist-only interpretation and a library-backed pick', async () => {
  const c = directRequestCases.find(c => c.name === 'artist-only')!;
  assert.deepEqual(checkDirectRequestCase(c, await runDirectRequestCase(c, async () => ({ artist: 'Queen' }))), []);
  const out = await runDirectRequestCase(c, async () => ({ title: 'Something', artist: 'Queen' }));
  assert.ok(checkDirectRequestCase(c, out).includes('interpretation:title'));
});

test('evaluation enforces translated language and canonical genre constraints', async () => {
  const language = directRequestCases.find(c => c.name === 'translated-language')!;
  assert.deepEqual(checkDirectRequestCase(language, await runDirectRequestCase(language, async () =>
    ({ title: 'Bohemian Rhapsody', language: 'French', artist: 'Queen' }))), []);
  const genre = directRequestCases.find(c => c.name === 'canonical-genre')!;
  assert.deepEqual(checkDirectRequestCase(genre, await runDirectRequestCase(genre, async () =>
    ({ genre: 'Hip Hop', title: null }))), []);
});

test('evaluation shares the resolver protection for exclusions disguised as names', async () => {
  const c = directRequestCases.find(c => c.name === 'exclusion')!;
  const out = await runDirectRequestCase(c, async () => ({ title: 'anything except Queen' }));
  assert.equal(out.selection.outcome, 'unsupported');
  assert.equal(out.selection.track, null);
});

test('first-attempt interpretation errors remain distinct from a successful catalogue pick', async () => {
  const c = directRequestCases.find(c => c.name === 'named-song')!;
  const out = await runDirectRequestCase(c, async () => ({ artist: 'Queen', search_terms: ['Queen'] }));
  assert.equal(out.selection.outcome, 'matched');
  assert.deepEqual(checkDirectRequestCase(c, out), ['interpretation:title']);
});

test('evaluation reports interpreter failure without claiming the route recovery was tested', async () => {
  const c = directRequestCases.find(c => c.name === 'named-song')!;
  let calls = 0;
  await assert.rejects(runDirectRequestCase(c, async () => { calls++; throw Error('fixture interpreter failed'); }),
    /fixture interpreter failed/);
  assert.equal(calls, 1);
});
