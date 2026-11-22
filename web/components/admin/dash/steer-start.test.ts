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
    'Opens with these 3. No model call.');
});

test('when the steer has time for only some of the list, Start says it plays those', () => {
  assert.equal(startSentence({ ...preview, fit: 2 }, inputs, now),
    'Opens with the first 2; the rest would start after it ends. No model call.');
});

test('a new length keeps the remembered tracks but sizes them again, with no model call', () => {
  for (const changed of [{ ...inputs, minutes: 15 }, { ...inputs, until: 'schedule-change' as const, minutes: undefined }]) {
    assert.equal(previewState(preview, changed, now), 'resized');
    assert.match(startSentence(preview, changed, now), /^Opens with as many of these as fit the new length\. No model call\./);
  }
});

test('without a preview, Start says it will work the list out itself with one model call', () => {
  assert.equal(previewState(null, inputs, now), 'none');
  assert.match(startSentence(null, inputs, now), /^Picks up to 5 opening tracks \(one model call\)/);
});

test('a single track says what start now does to the DJ\'s queued picks, and that no steer is stored', () => {
  assert.equal(startSentence(oncePreview, once, now), 'Queues this track. No model call.');
  const onceNow = { ...once, startNow: true };
  assert.equal(startSentence({ ...oncePreview, key: previewKeyOf(onceNow) }, onceNow, now),
    'Queues this track next. No model call.');
  assert.equal(startSentence(null, once, now), 'Picks one track (one model call).');
  assert.equal(startSentence(null, { ...once, startNow: true }, now),
    'Picks one track next (one model call).');
  assert.doesNotMatch(startSentence(null, { ...once, startNow: true }, now), /Nothing else changes/);
});

test('a preview for another playlist or direction, or one the controller has forgotten, is called out of date', () => {
  const stale = 'Out of date. Start picks a fresh list.';
  assert.equal(startSentence(preview, { ...inputs, prompt: 'something calm' }, now), stale);
  assert.equal(startSentence(preview, { ...inputs, playlistId: 'pl-2' }, now), stale);
  // "Start now" changes the track the list follows, so it is another list.
  assert.equal(previewState(preview, { ...inputs, startNow: true }, now), 'stale');
  assert.equal(startSentence(preview, { ...inputs, startNow: true }, now), stale);
  assert.equal(startSentence({ ...preview, at: now - STEER_PREVIEW_MS }, inputs, now), stale);
});

test('the card keys a preview exactly as the controller remembers it, whitespace included', () => {
  assert.equal(previewKeyOf({ ...inputs, prompt: '  more   2020s\n pop ' }), preview.key);
  assert.equal(previewKeyOf(inputs), steerPreviewKey('pl-1', 'more 2020s pop', false, false));
  assert.equal(previewKeyOf({ ...inputs, startNow: true }), steerPreviewKey('pl-1', 'more 2020s pop', false, true));
  assert.equal(previewKeyOf({ ...inputs, playlistId: null }), previewKeyOf({ ...inputs, playlistId: undefined }));
  assert.notEqual(previewKeyOf(once), preview.key, 'one track is not the first of five');
});
