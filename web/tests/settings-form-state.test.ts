import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settingsForm } from '../components/admin/settings/form-state';
import { archivesSavePayload, dangerSavePayload } from '../components/admin/settings/save-payload';
import { countLeafDiffs, dirtyPaths, ownsErrorPath, mergePatchErrors } from '../components/admin/settings/form-diff';

test('cold hydration preserves defaults and independent primary/fallback fields', () => {
  const form = settingsForm({
    tts: { cloud: { model: 'tts-1', voice: 'alloy' } },
    llm: { headers: { 'X-Route': 'set' }, fallback: { headers: { 'X-Other': 'set' }, discoverySteps: 4 } },
  });
  assert.equal(form.tts.enabled, true);
  assert.equal(form.tts.fallback.enabled, false);
  assert.equal(form.tts.cloud.model, 'tts-1');
  assert.equal(form.tts.cloud.voice, 'alloy');
  assert.equal(form.picker.albumHours, '0');
  assert.equal(form.picker.minTrackLengthSeconds, '0');
  assert.equal(form.llm.noRepeatWindow, '250');
  assert.equal(form.llm.discoverySteps, 0);
  assert.equal(form.llm.fallback.discoverySteps, 4);
  assert.deepEqual(form.llm.headers, [{ name: 'X-Route', value: 'set' }]);
  assert.deepEqual(form.llm.fallback.headers, [{ name: 'X-Other', value: 'set' }]);
});

test('whole-block saves refuse blank numbers and preserve explicit zero and decimal coercion', () => {
  const form = settingsForm({ crossfadeDuration: 10 });
  form.stream.bufferSeconds = ' ';
  form.maxTrackSeconds = '0';
  form.ducking.voice = '0.22';
  form.transitions.stemCacheGb = '1.5';
  const danger = dangerSavePayload(form);
  assert.deepEqual(danger.fieldErrors, { 'stream.bufferSeconds': 'enter a number' });
  assert.equal(danger.patch.maxTrackSeconds, 0);
  assert.equal(danger.patch.ducking.voice, 0.22);
  assert.equal(danger.patch.audio.stemCacheGb, 1.5);
  form.archive.retentionDays = '';
  const archive = archivesSavePayload(form);
  assert.deepEqual(archive.fieldErrors, { 'archive.retentionDays': 'enter a number' });
});

test('dirty counts and patch errors remain scoped to the edited section', () => {
  const baseline = settingsForm({});
  const form = structuredClone(baseline);
  form.tts.cloud.model = 'new-model';
  form.tts.cloud.voice = 'new-voice';
  form.station = 'unsaved station';
  assert.deepEqual(dirtyPaths(form, baseline, ['tts']), ['tts']);
  assert.equal(countLeafDiffs(form.tts, baseline.tts), 2);
  assert.equal(countLeafDiffs(['a', 'b'], ['a']), 1);
  assert.equal(ownsErrorPath(['transitions'], 'audio.stemCacheGb'), true);
  assert.equal(ownsErrorPath(['tts'], 'audio.stemCacheGb'), false);
  assert.deepEqual(mergePatchErrors(
    { 'tts.cloud.model': 'old', station: 'keep' }, { tts: {} }, { 'tts.cloud.voice': 'new' },
  ), { station: 'keep', 'tts.cloud.voice': 'new' });
});
