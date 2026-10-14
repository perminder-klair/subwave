import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PREVIEW_VALID_MS, previewKey, previewState, startSentence, type SteerPreview } from './steer-start';

const now = 1_700_000_000_000;
const key = previewKey('pl-1', 'more 2020s pop');
const picks = [1, 2, 3].map(n => ({ id: `t${n}`, title: `Track ${n}`, artist: 'Artist' }));
const preview: SteerPreview = { key, at: now - 60_000, picks };

test('with a preview for what is in the form, Start plays exactly those and says no model call is needed', () => {
  assert.equal(previewState(preview, key, now), 'valid');
  assert.equal(startSentence(preview, key, now, false),
    'Start plays these 3 tracks first. No model call is needed for them; picking continues after.');
  assert.match(startSentence({ ...preview, picks: picks.slice(0, 1) }, key, now, true), /^Start queues this track\. No model call/);
});

test('without a preview, Start says it will work the list out itself with one model call', () => {
  assert.equal(previewState(null, key, now), 'none');
  assert.match(startSentence(null, key, now, false), /works out up to five opening tracks with one model call, shows them here and plays them/);
  assert.match(startSentence(null, key, now, true), /works out one track with one model call and queues it/);
});

test('a preview for other inputs, or one the controller has forgotten, is called out of date', () => {
  const stale = 'These tracks are out of date; Start will work out a new list.';
  assert.equal(startSentence(preview, previewKey('pl-1', 'something calm'), now, false), stale);
  assert.equal(startSentence(preview, previewKey('pl-2', 'more 2020s pop'), now, false), stale);
  assert.equal(startSentence({ ...preview, at: now - PREVIEW_VALID_MS }, key, now, false), stale);
});

test('the key ignores whitespace the controller would collapse anyway', () => {
  assert.equal(previewKey('pl-1', '  more   2020s\n pop '), key);
  assert.equal(previewKey(null, 'x'), previewKey(undefined, 'x'));
  assert.notEqual(previewKey('pl-1', 'more 2020s pop', true), key, 'one track is not the first of five');
});
