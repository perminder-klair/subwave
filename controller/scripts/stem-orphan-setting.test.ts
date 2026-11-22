// audio.stemOrphanPurgeEnabled: the switch on a job that deletes, so what it
// reads after a restart matters more than what it reads in the process that set
// it. settings.load() composes explicitly, so a field missing there saves, works
// until the next cold load, then silently vanishes (controller/CLAUDE.md): only
// a cold-load round trip pins it.
//
// Run: `npm test -- stem-orphan-setting`.

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { coldLoadSettings } from './test-utils/settings.js';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-orphan-setting-'));
after(async () => { await removeTempDir(stateRoot); });
process.env.STATE_DIR = stateRoot;

const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');

test('an enabled purge stays enabled across a controller restart', async () => {
  const cold = await coldLoadSettings({ audio: { stemOrphanPurgeEnabled: true } });
  assert.equal(cold.audio.stemOrphanPurgeEnabled, true);
});

test('what update() saved is what the next cold load reads', async () => {
  await coldLoadSettings({});
  await settings.update({ audio: { stemOrphanPurgeEnabled: true } });
  setCache(null);
  await settings.load();
  assert.equal(settings.get().audio.stemOrphanPurgeEnabled, true);
});

test('an upgrade with no stored value stays off: deleting is opt-in', async () => {
  const cold = await coldLoadSettings({ audio: {} });
  assert.equal(cold.audio.stemOrphanPurgeEnabled, false);
});

test('a malformed stored value reads as off, never as on', async () => {
  for (const bad of ['true', 1, null, {}]) {
    const cold = await coldLoadSettings({ audio: { stemOrphanPurgeEnabled: bad } });
    assert.equal(cold.audio.stemOrphanPurgeEnabled, false, JSON.stringify(bad));
  }
});
