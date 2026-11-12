// The Library settings' two audio-energy switches load as the server stored
// them, and anything but a stored `true` loads as off, so a save from an older
// station's settings never turns either on.
//
// Run: npm test -- audio-energy-form

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settingsForm } from './form-state';
import type { SettingsData } from './shared';

type Values = NonNullable<SettingsData['values']>;

test('the switches load what the server stored', () => {
  const f = settingsForm({ embedding: { audioEnergy: { fillEmpty: true, overruleLlm: false } } } as Values);
  assert.deepEqual(f.embedding.audioEnergy, { fillEmpty: true, overruleLlm: false });
  const g = settingsForm({ embedding: { audioEnergy: { fillEmpty: false, overruleLlm: true } } } as Values);
  assert.deepEqual(g.embedding.audioEnergy, { fillEmpty: false, overruleLlm: true });
});

test('a station that never saved them loads both as off', () => {
  assert.deepEqual(settingsForm({} as Values).embedding.audioEnergy, { fillEmpty: false, overruleLlm: false });
  assert.deepEqual(settingsForm({ embedding: {} } as Values).embedding.audioEnergy, { fillEmpty: false, overruleLlm: false });
});
