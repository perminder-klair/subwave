import assert from 'node:assert/strict';
import test from 'node:test';
import { directRequestCases, runDirectRequestCase, checkDirectRequestCase } from './llm-bench/direct-request.js';

// Validate the evaluation's verdicts independently of any available model.
// Live runs use the same cases with the production matchRequest call.
test('evaluation detects a dropped language requirement even if selection reports matched', async () => {
  const c = directRequestCases.find(c => c.name === 'named-song-language')!;
  const out = await runDirectRequestCase(c, async () => ({ title: 'Bohemian Rhapsody', artist: 'Queen' }));
  assert.equal(out.selection.outcome, 'matched');
  assert.ok(checkDirectRequestCase(c, out).includes('wrong-track'));
  assert.ok(checkDirectRequestCase(c, out).includes('interpretation:language'));
});

test('evaluation distinguishes mood compromises from satisfied preferences', async () => {
  const c = directRequestCases.find(c => c.name === 'mood-compromise')!;
  const out = await runDirectRequestCase(c, async () => ({ artist: 'Fixture Band', mood: 'calm' }));
  assert.deepEqual(checkDirectRequestCase(c, out), []);
  assert.deepEqual(out.selection.unmetPreferences, ['mood']);
  assert.ok(checkDirectRequestCase(c, { ...out, selection: { ...out.selection, outcome: 'matched' } }).length);
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
