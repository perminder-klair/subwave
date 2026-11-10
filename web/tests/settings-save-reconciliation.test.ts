import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FormState } from '../components/admin/settings/shared';
import { decideCloudSave } from '../components/admin/settings/cloudSavePayload';
import {
  cloudSaveSnapshot, cloudSaveReadReady, rebaselineSavedPatch, reconcileSavedCloud,
} from '../components/admin/settings/form-reconciliation';

function fixture(): FormState {
  // Only the fields this save touches; other sections must survive unchanged.
  return {
    station: 'Station', llm: { model: 'original-llm' },
    tts: { defaultEngine: 'cloud', cloud: { provider: 'openai', model: 'tts-1', voice: 'alloy' } },
  } as unknown as FormState;
}

function save(baseline: FormState, submitted: FormState, current = submitted, saved = baseline.tts.cloud) {
  const decision = decideCloudSave({ ...submitted.tts.cloud, savedProvider: baseline.tts.cloud.provider });
  const cloud = {
    provider: decision.provider,
    ...(decision.model !== undefined ? { model: decision.model } : {}),
    ...(decision.voice !== undefined ? { voice: decision.voice } : {}),
  };
  const patch = { tts: { defaultEngine: submitted.tts.defaultEngine, cloud } };
  const snapshot = cloudSaveSnapshot(submitted, patch);
  assert.ok(snapshot);
  return reconcileSavedCloud(rebaselineSavedPatch(baseline, submitted, patch), current, snapshot, saved);
}

test('a successful save restores omitted blanks and leaves the form clean', () => {
  const baseline = fixture();
  const submitted = structuredClone(baseline);
  submitted.tts.cloud.model = '  ';
  submitted.tts.cloud.voice = '';
  submitted.tts.defaultEngine = 'gemini';

  const result = save(baseline, submitted);

  assert.equal(result.form.tts.cloud.model, 'tts-1');
  assert.equal(result.form.tts.cloud.voice, 'alloy');
  assert.equal(result.form.tts.defaultEngine, 'gemini');
  assert.deepEqual(result.form, result.baseline, 'the authoritative hydration guard must see a clean form');
  assert.equal(submitted.tts.cloud.model, '  ', 'the request snapshot is immutable');
});

test('retained fields use the authoritative read and preserve unrelated edits', () => {
  const baseline = fixture();
  const submitted = structuredClone(baseline);
  submitted.tts.cloud.model = '';
  submitted.tts.cloud.voice = 'nova';
  submitted.station = 'Unsaved station';
  const current = structuredClone(submitted);
  current.llm.model = 'newer-llm';

  const result = save(baseline, submitted, current, {
    ...baseline.tts.cloud, model: 'authoritative-model', voice: 'nova',
  });

  assert.equal(result.form.tts.cloud.model, 'authoritative-model');
  assert.equal(result.baseline.tts.cloud.model, 'authoritative-model');
  assert.equal(result.form.tts.cloud.voice, 'nova');
  assert.equal(result.baseline.tts.cloud.voice, 'nova');
  assert.equal(result.form.station, 'Unsaved station');
  assert.equal(result.baseline.station, 'Station');
  assert.equal(result.form.llm.model, 'newer-llm');
  assert.equal(result.baseline.llm.model, 'original-llm');
});

test('model and voice edits made during the request remain dirty', () => {
  const baseline = fixture();
  const submitted = structuredClone(baseline);
  submitted.tts.cloud.model = '';
  submitted.tts.cloud.voice = '';
  const current = structuredClone(submitted);
  current.tts.cloud.model = 'newer-model';
  current.tts.cloud.voice = 'newer-voice';
  current.tts.defaultEngine = 'remote';

  const result = save(baseline, submitted, current);

  assert.deepEqual(result.form, current);
  assert.equal(result.baseline.tts.cloud.model, 'tts-1');
  assert.equal(result.baseline.tts.cloud.voice, 'alloy');
  assert.equal(result.baseline.tts.defaultEngine, 'cloud');
  assert.notDeepEqual(result.form, result.baseline);
});

test('a provider change during the request never gets another provider\'s retained fields', () => {
  const baseline = fixture();
  const submitted = structuredClone(baseline);
  submitted.tts.cloud.model = '';
  submitted.tts.cloud.voice = '';
  const current = structuredClone(submitted);
  current.tts.cloud.provider = 'fish-audio';

  const result = save(baseline, submitted, current);

  assert.deepEqual(result.form, current);
  assert.equal(result.form.tts.cloud.model, '');
  assert.equal(result.form.tts.cloud.voice, '');
});

test('stale-provider recovery reconciles the normalized provider as well as retained fields', () => {
  const baseline = fixture();
  const submitted = structuredClone(baseline);
  submitted.tts.cloud.provider = 'gemini';
  submitted.tts.cloud.model = '';
  submitted.tts.cloud.voice = '';

  const result = save(baseline, submitted);

  assert.equal(result.form.tts.cloud.provider, 'openai');
  assert.deepEqual(result.form, result.baseline);
  assert.deepEqual(result.form.tts.cloud, baseline.tts.cloud);
});

test('a compatible blank voice is a submitted clear, not a retained field', () => {
  const baseline = fixture();
  baseline.tts.cloud.provider = 'openai-compatible';
  const submitted = structuredClone(baseline);
  submitted.tts.cloud.voice = '';

  const result = save(baseline, submitted, submitted, { ...baseline.tts.cloud, voice: '' });

  assert.equal(result.form.tts.cloud.voice, '');
  assert.deepEqual(result.form, result.baseline);
});

test('an authoritative provider changed elsewhere is never applied to this saved snapshot', () => {
  const baseline = fixture();
  const submitted = structuredClone(baseline);
  submitted.tts.cloud.model = '';
  submitted.tts.cloud.voice = '';

  const result = save(baseline, submitted, submitted, {
    ...baseline.tts.cloud, provider: 'fish-audio', model: 's2.1-pro', voice: 'fish-voice',
  });

  assert.deepEqual(result.form, submitted);
  assert.deepEqual(result.baseline.tts.cloud, baseline.tts.cloud);
});

test('a failed post-save refresh waits for a later successful read before restoring blanks', () => {
  const baseline = fixture();
  const submitted = structuredClone(baseline);
  submitted.tts.cloud.model = '';
  const snapshot = cloudSaveSnapshot(submitted, { tts: { cloud: { provider: 'openai', voice: 'alloy' } } });
  assert.ok(snapshot);
  const pending = { snapshot, refreshAfter: 100 };

  assert.equal(cloudSaveReadReady(pending, 0), false, 'the previous stale envelope is not authoritative');
  assert.equal(cloudSaveReadReady(pending, 99), false, 'a pre-save poll cannot reconcile a committed save');
  assert.equal(cloudSaveReadReady(pending, 101), true);
  const result = save(baseline, submitted, submitted, { ...baseline.tts.cloud, model: 'later-model' });
  assert.equal(result.form.tts.cloud.model, 'later-model');
  assert.deepEqual(result.form, result.baseline);
});

test('a successful read must reach the component before its save is reconciled', () => {
  const snapshot = cloudSaveSnapshot(fixture(), { tts: { cloud: { provider: 'openai' } } });
  assert.ok(snapshot);
  const pending = { snapshot, refreshedAt: 200, refreshAfter: 201 };
  assert.equal(cloudSaveReadReady(pending, 199), false);
  assert.equal(cloudSaveReadReady(pending, 200), true);
});
