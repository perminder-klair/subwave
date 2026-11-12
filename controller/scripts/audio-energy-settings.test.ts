// settings.embedding.audioEnergy: the two opt-ins of the audio energy pass
// (music/propagated-energy.ts). Both off by default, so an upgrade runs the
// same correction it ran before; both must survive a controller restart, which
// is a COLD load: load() composes the embedding block field by field, and a
// field missing there saves, works in that process and vanishes on restart.
// Run: npm test -- audio-energy-settings

import assert from 'node:assert/strict';
import { coldLoadSettings } from './test-utils/settings.js';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-audio-energy-settings-'));
process.env.STATE_DIR = stateRoot;

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { DEFAULTS } = await import('../src/settings/defaults.js');

test('both options are off by default', () => {
  assert.deepEqual(DEFAULTS.embedding.audioEnergy, { fillEmpty: false, overruleLlm: false });
});

test('a saved choice survives a controller restart', async () => {
  const s = await coldLoadSettings({ embedding: { audioEnergy: { fillEmpty: true, overruleLlm: true } } });
  assert.deepEqual(s.embedding.audioEnergy, { fillEmpty: true, overruleLlm: true });
});

test('absent or malformed values read as off', async () => {
  assert.deepEqual((await coldLoadSettings({ embedding: {} })).embedding.audioEnergy, { fillEmpty: false, overruleLlm: false });
  assert.deepEqual(
    (await coldLoadSettings({ embedding: { audioEnergy: { fillEmpty: 'yes', overruleLlm: 1 } } })).embedding.audioEnergy,
    { fillEmpty: false, overruleLlm: false },
  );
});

test('update() sets each option on its own and refuses a non-boolean', async () => {
  setCache(null);
  await settings.load();
  await settings.update({ embedding: { audioEnergy: { fillEmpty: true } } });
  assert.deepEqual(settings.get().embedding.audioEnergy, { fillEmpty: true, overruleLlm: false });
  await settings.update({ embedding: { audioEnergy: { overruleLlm: true } } });
  assert.deepEqual(settings.get().embedding.audioEnergy, { fillEmpty: true, overruleLlm: true });
  await assert.rejects(() => settings.update({ embedding: { audioEnergy: { fillEmpty: 'on' } } }), /audioEnergy\.fillEmpty/);
  // And it is still there after a cold load of what update() wrote.
  setCache(null);
  await settings.load();
  assert.deepEqual(settings.get().embedding.audioEnergy, { fillEmpty: true, overruleLlm: true });
});
