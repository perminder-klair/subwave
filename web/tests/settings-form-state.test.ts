import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settingsForm } from '../components/admin/settings/form-state';
import { archivesSavePayload, dangerSavePayload, stemsSavePayload } from '../components/admin/settings/save-payload';
import { countLeafDiffs, dirtyPaths, restorePaths, ownsErrorPath, mergePatchErrors } from '../components/admin/settings/form-diff';
import { RESTART_PATHS, sectionById } from '../components/admin/settings/registry';
import { samePath } from '../components/admin/settings/form-diff';

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
  assert.equal(form.llm.shortlistSearchPreparation, false);
  assert.equal(form.llm.guestMusicalLeanings, false);
  assert.equal(form.llm.requestMatching, 'agentic');
  assert.equal(form.llm.segmentRuntime, 'agentic');
  assert.equal(form.llm.fallback.discoverySteps, 4);
  assert.deepEqual(form.llm.headers, [{ name: 'X-Route', value: 'set' }]);
  assert.deepEqual(form.llm.fallback.headers, [{ name: 'X-Other', value: 'set' }]);

  // Tool choice is per leg: neither leg's value leaks into the other, so a
  // swap that moves an 'auto' onto the backup shows up on the backup's control.
  assert.equal(form.llm.fallback.toolChoice, 'required');
  const auto = settingsForm({ llm: { toolChoice: 'required', fallback: { toolChoice: 'auto' } } });
  assert.equal(auto.llm.toolChoice, 'required');
  assert.equal(auto.llm.fallback.toolChoice, 'auto');
  assert.equal(settingsForm({ llm: { toolChoice: 'auto' } }).llm.fallback.toolChoice, 'required');

  const shortlist = settingsForm({ llm: {
    trackSelection: 'shortlist', shortlistPasses: 5, shortlistSearchPreparation: true, guestMusicalLeanings: true,
    requestMatching: 'direct', segmentRuntime: 'direct',
  } });
  assert.equal(shortlist.llm.trackSelection, 'shortlist');
  assert.equal(shortlist.llm.shortlistPasses, 5);
  assert.equal(shortlist.llm.shortlistSearchPreparation, true);
  assert.equal(shortlist.llm.guestMusicalLeanings, true);
  assert.equal(shortlist.llm.requestMatching, 'direct');
  assert.equal(shortlist.llm.segmentRuntime, 'direct');
});

test('voice levelling hydrates OFF for older stations and preserves the explicit operator choice', () => {
  const baseline = settingsForm({});
  assert.equal(baseline.tts.voiceLevelling, false);
  assert.equal(settingsForm({ tts: { voiceLevelling: false } }).tts.voiceLevelling, false);
  const enabled = settingsForm({ tts: { voiceLevelling: true } });
  assert.equal(enabled.tts.voiceLevelling, true);
  assert.deepEqual(dirtyPaths(enabled, baseline, ['tts']), ['tts']);
  assert.equal(restorePaths(enabled, baseline, ['tts']).tts.voiceLevelling, false);
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
  assert.equal(stemsSavePayload(form).patch.audio.stemCacheGb, 1.5);
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

test('Broadcast & mixer and Stems split transitions at the leaf: each page sees and saves only its own fields', () => {
  const broadcast = sectionById('broadcast')!.formKeys;
  const stems = sectionById('stems')!.formKeys;
  const baseline = settingsForm({});
  // The crossfade curve lives on Broadcast & mixer: its save bar comes up,
  // with the restart warning, and the Stems page stays clean.
  const curve = structuredClone(baseline);
  curve.transitions.equalPowerCrossfade = !baseline.transitions.equalPowerCrossfade;
  assert.deepEqual(dirtyPaths(curve, baseline, broadcast), ['transitions.equalPowerCrossfade']);
  assert.deepEqual(dirtyPaths(curve, baseline, stems), []);
  const restartWarn = (keys: readonly string[]) => RESTART_PATHS.some(path =>
    keys.some(key => path === key || path.startsWith(`${key}.`)) && !samePath(curve, baseline, path));
  assert.equal(restartWarn(broadcast), true);
  assert.equal(restartWarn(stems), false);
  // An effect toggle is Broadcast's too.
  const fx = structuredClone(baseline);
  fx.transitions.effects.sweep = !baseline.transitions.effects.sweep;
  assert.deepEqual(dirtyPaths(fx, baseline, broadcast), ['transitions.effects']);
  assert.deepEqual(dirtyPaths(fx, baseline, stems), []);
  // The stem budget is the Stems page's, and its errors route there.
  const budget = structuredClone(baseline);
  budget.transitions.stemCacheGb = '7';
  assert.deepEqual(dirtyPaths(budget, baseline, stems), ['transitions.stemCacheGb']);
  assert.deepEqual(dirtyPaths(budget, baseline, broadcast), []);
  assert.equal(ownsErrorPath(stems, 'audio.stemCacheGb'), true);
  assert.equal(ownsErrorPath(broadcast, 'audio.stemCacheGb'), false);
});

test('the Stems save and the Broadcast save post disjoint fields, so neither commits the other page\'s edit', () => {
  const form = settingsForm({});
  const stems = stemsSavePayload(form).patch;
  const danger = dangerSavePayload(form).patch;
  assert.deepEqual(Object.keys(stems.transitions).sort(), ['pairDrain', 'stemBlends']);
  assert.deepEqual(Object.keys(stems.audio).sort(), ['stemCache', 'stemCacheGb']);
  assert.deepEqual(Object.keys(danger.transitions).sort(), ['effects', 'equalPowerCrossfade']);
  assert.equal('audio' in danger, false);
  assert.deepEqual(Object.keys(stems).sort(), ['audio', 'transitions']);
});
