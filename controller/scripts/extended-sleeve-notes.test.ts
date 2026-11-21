import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-extended-sleeves-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
test('DJ link-style defaults survive a cold load', async () => {
  await settings.load();
  assert.equal(settings.get().djBehaviour.extendedSleeveNotes, false);
  assert.equal(settings.get().djBehaviour.sleeveNotesMaintenanceWhenEmpty, false);
  assert.equal(settings.get().djBehaviour.releaseYearMentions, 'regular');

  await settings.update({ djBehaviour: {
    extendedSleeveNotes: true, sleeveNotesMaintenanceWhenEmpty: true, releaseYearMentions: 'rare',
  } } as never);

  setCache(null);
  await settings.load();
  assert.equal(settings.get().djBehaviour.extendedSleeveNotes, true);
  assert.equal(settings.get().djBehaviour.sleeveNotesMaintenanceWhenEmpty, true);
  assert.equal(settings.get().djBehaviour.releaseYearMentions, 'rare');
});

test('extended sleeve notes refuse non-boolean patches', async () => {
  await assert.rejects(
    () => settings.update({ djBehaviour: { extendedSleeveNotes: 'on' } } as never),
    /djBehaviour\.extendedSleeveNotes must be a boolean/,
  );
  await assert.rejects(
    () => settings.update({ djBehaviour: { releaseYearMentions: 'sometimes' } } as never),
    /djBehaviour\.releaseYearMentions must be regular, occasional or rare/,
  );
});

test('Genius provider configuration is independent and survives a cold load', async () => {
  assert.equal(settings.get().sleeveNotes.providers.genius.enabled, true);
  await settings.update({ djBehaviour: { extendedSleeveNotes: false } } as never);
  await settings.update({ sleeveNotes: { providers: { genius: { enabled: false } } } } as never);
  setCache(null);
  await settings.load();
  assert.equal(settings.get().sleeveNotes.providers.genius.enabled, false);
  assert.equal(settings.get().djBehaviour.extendedSleeveNotes, false);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
