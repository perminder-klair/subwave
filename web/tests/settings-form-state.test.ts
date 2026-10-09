import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settingsForm } from '../components/admin/settings/form-state';
import { archivesSavePayload, dangerSavePayload } from '../components/admin/settings/save-payload';
import { countLeafDiffs, dirtyPaths, restorePaths, ownsErrorPath, mergePatchErrors } from '../components/admin/settings/form-diff';
import { sectionById } from '../components/admin/settings/registry';

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
  assert.equal(form.llm.trackSelection, 'agentic');
  assert.equal(form.llm.shortlistPasses, 3);
  assert.equal(form.llm.guestMusicalLeanings, false);
  assert.equal(form.llm.requestMatching, 'agentic');
  assert.equal(form.llm.segmentRuntime, 'agentic');
  assert.equal(form.llm.fallback.discoverySteps, 4);
  assert.deepEqual(form.llm.headers, [{ name: 'X-Route', value: 'set' }]);
  assert.deepEqual(form.llm.fallback.headers, [{ name: 'X-Other', value: 'set' }]);

  const shortlist = settingsForm({ llm: {
    trackSelection: 'shortlist', shortlistPasses: 5, guestMusicalLeanings: true,
    requestMatching: 'direct', segmentRuntime: 'direct',
  } });
  assert.equal(shortlist.llm.trackSelection, 'shortlist');
  assert.equal(shortlist.llm.shortlistPasses, 5);
  assert.equal(shortlist.llm.guestMusicalLeanings, true);
  assert.equal(shortlist.llm.requestMatching, 'direct');
  assert.equal(shortlist.llm.segmentRuntime, 'direct');
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

test('discard restores nested selection fields while retaining behaviour and provider edits', () => {
  const baseline = settingsForm({});
  const form = structuredClone(baseline);
  form.llm.trackSelection = 'shortlist';
  form.llm.requestWebResolve = !baseline.llm.requestWebResolve;
  form.llm.segmentRuntime = 'direct';
  form.llm.model = 'new-model';
  const restored = restorePaths(form, baseline, sectionById('selection')!.formKeys);
  assert.equal(restored.llm.trackSelection, baseline.llm.trackSelection);
  assert.equal(restored.llm.requestWebResolve, baseline.llm.requestWebResolve);
  assert.equal(restored.llm.segmentRuntime, 'direct');
  assert.equal(restored.llm.model, 'new-model');
  assert.equal(form.llm.trackSelection, 'shortlist', 'the original editor state remains intact');
});

test('provider dirtiness and discard do not own selection or segment runtime', () => {
  const baseline = settingsForm({});
  const form = structuredClone(baseline);
  form.llm.trackSelection = 'shortlist';
  form.llm.segmentRuntime = 'direct';
  const keys = sectionById('llm')!.formKeys;
  assert.deepEqual(dirtyPaths(form, baseline, keys), []);
  form.llm.model = 'new-model';
  assert.deepEqual(dirtyPaths(form, baseline, keys), ['llm.model']);
  const restored = restorePaths(form, baseline, keys);
  assert.equal(restored.llm.model, baseline.llm.model);
  assert.equal(restored.llm.trackSelection, 'shortlist');
  assert.equal(restored.llm.segmentRuntime, 'direct');
});
