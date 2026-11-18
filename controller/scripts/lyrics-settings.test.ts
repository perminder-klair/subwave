// settings.lyrics — the operator's switches for the listener Lyrics panel and its
// LRCLIB fallback.
// A new settings field needs DEFAULTS, the update() branch AND a line in
// load()'s composition; one missing from load() still saves and works until
// the next restart, then silently reverts. So the switch is pinned through a
// cold load, not only in-process.
//
// Run: `npm test -- lyrics-settings`.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir } from './test-utils/temp-dir.js';
import { coldLoadSettings } from './test-utils/settings.js';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-lyrics-settings-'));
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASS = 'admin-pass';

const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
const { validateSettingsPatch } = await import('../src/settings/patch-registry.js');
const express = (await import('express')).default;
const { router } = await import('../src/routes/settings/core.js');

const app = express();
app.use(express.json());
app.use(router);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const authorization = `Basic ${Buffer.from('admin:admin-pass').toString('base64')}`;
after(() => server.close());

test('absent or malformed loads as on, and a saved off stays off', async () => {
  // On by default, upgrades included: an install that never saved the key
  // gets the panel. An operator's saved off is the only way to keep it off.
  assert.equal((await coldLoadSettings({})).lyrics.enabled, true);
  assert.equal((await coldLoadSettings({ lyrics: null })).lyrics.enabled, true);
  assert.equal((await coldLoadSettings({ lyrics: { enabled: 'yes' } })).lyrics.enabled, true);
  assert.equal((await coldLoadSettings({ lyrics: { enabled: false } })).lyrics.enabled, false);
});

test('a save survives a cold load, both ways', async () => {
  await coldLoadSettings({});
  await settings.update({ lyrics: { enabled: true } } as never);
  setCache(null);
  await settings.load();
  assert.equal(settings.get().lyrics.enabled, true);

  await settings.update({ lyrics: { enabled: false } } as never);
  setCache(null);
  await settings.load();
  assert.equal(settings.get().lyrics.enabled, false);
});

test('the LRCLIB fallback loads on unless saved off, and survives a cold load', async () => {
  // On by default with the panel; a saved off keeps the station's plays home.
  assert.equal((await coldLoadSettings({})).lyrics.lrclib, true);
  assert.equal((await coldLoadSettings({ lyrics: { enabled: true } })).lyrics.lrclib, true);
  assert.equal((await coldLoadSettings({ lyrics: { lrclib: 'yes' } })).lyrics.lrclib, true);
  assert.equal((await coldLoadSettings({ lyrics: { lrclib: false } })).lyrics.lrclib, false);

  await coldLoadSettings({});
  await settings.update({ lyrics: { enabled: true, lrclib: false } } as never);
  setCache(null);
  await settings.load();
  assert.deepEqual(settings.get().lyrics, { enabled: true, lrclib: false });

  // A patch naming only the panel switch leaves the fallback where it was.
  await settings.update({ lyrics: { enabled: false } } as never);
  assert.deepEqual(settings.get().lyrics, { enabled: false, lrclib: false });
  await settings.update({ lyrics: { lrclib: true } } as never);
  setCache(null);
  await settings.load();
  assert.deepEqual(settings.get().lyrics, { enabled: false, lrclib: true });
});

test('the route accepts the key, and a patch without it leaves the switch alone', async () => {
  assert.equal(validateSettingsPatch({ lyrics: { enabled: true } }), null);
  // Off, the opposite of the default, so a patch that reset it would show.
  await settings.update({ lyrics: { enabled: false } } as never);
  await settings.update({ likes: { enabled: false } } as never);
  assert.equal(settings.get().lyrics.enabled, false);
});

test('the admin form reads the switch back, so a likes save cannot turn it off', async () => {
  // GET /settings `values` is an allowlist. Missing from it, the Listeners form
  // hydrated the switch as off and every likes save posted `enabled: false`.
  await settings.update({ lyrics: { enabled: true, lrclib: true } } as never);
  const read = await fetch(`${base}/settings`, { headers: { authorization } });
  const body = await read.json() as { values?: { lyrics?: { enabled?: boolean; lrclib?: boolean } } };
  assert.deepEqual(body.values?.lyrics, { enabled: true, lrclib: true });

  const save = await fetch(`${base}/settings`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ likes: { starInNavidrome: false }, lyrics: body.values?.lyrics }),
  });
  assert.equal(save.status, 200);
  assert.deepEqual(settings.get().lyrics, { enabled: true, lrclib: true }, 'the fallback rides the same block');
});
