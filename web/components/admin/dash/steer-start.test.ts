import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STEER_PREVIEW_MS, steerPreviewKey } from '@/lib/schemas.generated';
import { previewKeyOf, previewSizeKey, previewState, startSentence, type SteerPreview, type SteerStartInputs } from './steer-start';

const now = 1_700_000_000_000;
const inputs: SteerStartInputs = { playlistId: 'pl-1', prompt: 'more 2020s pop', until: 'fixed', minutes: 60, startNow: false };
const picks = [1, 2, 3].map(n => ({ id: `t${n}`, title: `Track ${n}`, artist: 'Artist' }));
const preview: SteerPreview = { key: previewKeyOf(inputs), size: previewSizeKey(inputs), at: now - 60_000, picks, fit: 3 };
const once: SteerStartInputs = { ...inputs, until: 'once', minutes: undefined };
const oncePreview: SteerPreview = { key: previewKeyOf(once), size: previewSizeKey(once), at: now - 60_000, picks: picks.slice(0, 1), fit: 1 };

test('with a preview for what is in the form, Start plays exactly those and says no model call is needed', () => {
  assert.equal(previewState(preview, inputs, now), 'valid');
  assert.equal(startSentence(preview, inputs, now),
    'Start plays these 3 tracks first. No model call is needed for them; picking continues after.');
});

test('when the steer has time for only some of the list, Start says it plays those', () => {
  assert.equal(startSentence({ ...preview, fit: 2 }, inputs, now),
    'Start plays the first 2 of these, the ones that start before the steer ends. No model call is needed for them; picking continues after.');
});

test('a new length or "start now" keeps the remembered tracks but sizes them again, with no model call', () => {
  for (const changed of [{ ...inputs, minutes: 15 }, { ...inputs, startNow: true }, { ...inputs, until: 'schedule-change' as const, minutes: undefined }]) {
    assert.equal(previewState(preview, changed, now), 'resized');
    assert.match(startSentence(preview, changed, now), /^Start plays as many of these as start before the steer ends at this length, with no model call\./);
  }
});

test('without a preview, Start says it will work the list out itself with one model call', () => {
  assert.equal(previewState(null, inputs, now), 'none');
  assert.match(startSentence(null, inputs, now), /works out up to 5 opening tracks with one model call and plays the ones that start before the steer ends/);
});

test('a single track says what start now does to the DJ\'s queued picks, and that no steer is stored', () => {
  assert.equal(startSentence(oncePreview, once, now), 'Start queues this track. No model call is needed for it, and no steer is stored.');
  assert.equal(startSentence(oncePreview, { ...once, startNow: true }, now),
    'Start queues this track to play next, in place of the DJ\'s queued picks. No model call is needed for it, and no steer is stored.');
  assert.equal(startSentence(null, once, now), 'Start works out one track with one model call and queues it. No steer is stored.');
  assert.equal(startSentence(null, { ...once, startNow: true }, now),
    'Start works out one track with one model call and queues it to play next, in place of the DJ\'s queued picks. No steer is stored.');
  assert.doesNotMatch(startSentence(null, { ...once, startNow: true }, now), /Nothing else changes/);
});

test('a preview for another playlist or direction, or one the controller has forgotten, is called out of date', () => {
  const stale = 'These tracks are out of date; Start will work out a new list.';
  assert.equal(startSentence(preview, { ...inputs, prompt: 'something calm' }, now), stale);
  assert.equal(startSentence(preview, { ...inputs, playlistId: 'pl-2' }, now), stale);
  assert.equal(startSentence({ ...preview, at: now - STEER_PREVIEW_MS }, inputs, now), stale);
});

test('the card keys a preview exactly as the controller remembers it, whitespace included', () => {
  assert.equal(previewKeyOf({ ...inputs, prompt: '  more   2020s\n pop ' }), preview.key);
  assert.equal(previewKeyOf(inputs), steerPreviewKey('pl-1', 'more 2020s pop', false));
  assert.equal(previewKeyOf({ ...inputs, playlistId: null }), previewKeyOf({ ...inputs, playlistId: undefined }));
  assert.notEqual(previewKeyOf(once), preview.key, 'one track is not the first of five');
});
