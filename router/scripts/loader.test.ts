// Plugin discovery: every broken plugin is reported with its reason, never
// thrown, and never allowed to shadow a built-in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanPlugins } from '../src/host/loader.js';
import { parseManifest, resolveConfig } from '../src/host/manifest.js';

const here = dirname(fileURLToPath(import.meta.url));
const BUILTIN = resolve(here, '../src/sources');
const FIXTURES = resolve(here, 'fixtures/plugins');

test('built-ins load without errors', async () => {
  const plugins = await scanPlugins(BUILTIN, '/nonexistent');
  assert.deepEqual(plugins.map((p) => p.name).sort(), ['jellyfin', 'mock', 'navidrome', 'plex']);
  for (const p of plugins) {
    assert.equal(p.error, undefined, `${p.name}: ${p.error}`);
    assert.equal(p.builtin, true);
    assert.equal(typeof p.factory, 'function');
  }
});

test('devOnly is an optional boolean in the manifest, and only the demo library sets it', async () => {
  const plugins = await scanPlugins(BUILTIN, '/nonexistent');
  const flags = Object.fromEntries(plugins.map((p) => [p.name, p.manifest?.devOnly === true]));
  assert.deepEqual(flags, { jellyfin: false, mock: true, navidrome: false, plex: false });
  const base = { name: 'x-source', label: 'X', version: '1.0.0', apiVersion: 1, idPrefix: 'xs' };
  assert.equal(parseManifest(base).devOnly, undefined);
  assert.equal(parseManifest({ ...base, devOnly: true }).devOnly, true);
  assert.throws(() => parseManifest({ ...base, devOnly: 'yes' }), /devOnly/);
});

test('broken third-party plugins are reported with a reason', async () => {
  const plugins = await scanPlugins(BUILTIN, FIXTURES);
  const byDir = new Map(plugins.filter((p) => !p.builtin).map((p) => [p.dir.split('/').pop(), p]));
  assert.equal(byDir.get('good')?.error, undefined);
  assert.match(byDir.get('bad-manifest')?.error ?? '', /invalid subwave-source\.json: name/);
  assert.match(byDir.get('old-api')?.error ?? '', /plugin API v99/);
  assert.match(byDir.get('clash-name')?.error ?? '', /already taken by a built-in/);
  assert.match(byDir.get('clash-prefix')?.error ?? '', /idPrefix 'mock' is already used/);
  assert.match(byDir.get('escape-entry')?.error ?? '', /inside the plugin folder/);
  assert.match(byDir.get('throws-on-import')?.error ?? '', /boom at import/);
  for (const name of ['clash-name', 'clash-prefix', 'escape-entry', 'throws-on-import']) {
    assert.equal(byDir.get(name)?.factory, undefined, `${name} must not be usable`);
  }
  // The built-in still owns its name.
  assert.equal(plugins.find((p) => p.name === 'mock' && p.builtin)?.error, undefined);
});

test('an edited plugin is re-imported on rescan; an unchanged one is not', async () => {
  const root = mkdtempSync(join(tmpdir(), 'router-loader-'));
  try {
    cpSync(join(FIXTURES, 'good'), join(root, 'good'), { recursive: true });
    const first = (await scanPlugins('/nonexistent', root))[0]!;
    const again = (await scanPlugins('/nonexistent', root))[0]!;
    assert.equal(first.factory, again.factory, 'unchanged file reuses the module');
    const entry = join(root, 'good', 'index.mjs');
    writeFileSync(entry, readFileSync(entry, 'utf8').replace('Fixture Album', 'Edited Album'));
    const later = new Date(Date.now() + 5000);
    utimesSync(entry, later, later);
    const edited = (await scanPlugins('/nonexistent', root))[0]!;
    assert.notEqual(edited.factory, first.factory);
    const inst = await edited.factory!({ config: { greeting: 'hi' }, fetch, log: console, dataDir: root });
    assert.match((await inst.album('al1'))!.album.name, /Edited Album/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('config resolution: env wins and locks, defaults fill, required is reported', async () => {
  const plugins = await scanPlugins('/nonexistent', FIXTURES);
  const good = plugins.find((p) => p.name === 'good')!.manifest!;
  const none = resolveConfig(good, {}, {});
  assert.deepEqual(none.missing, ['greeting']);
  assert.equal(none.values.count, 2);
  const stored = resolveConfig(good, { greeting: 'hello', count: '5' }, {});
  assert.deepEqual(stored.missing, []);
  assert.equal(stored.values.count, 5);
  assert.deepEqual(stored.envLocked, []);
  const env = resolveConfig(good, { greeting: 'hello' }, { GOOD_GREETING: 'from env' });
  assert.equal(env.values.greeting, 'from env');
  assert.deepEqual(env.envLocked, ['greeting']);
});
