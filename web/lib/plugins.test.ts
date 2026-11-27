// The /plugins directory's parser (#2413). catalog.json is a live remote fetch,
// so one bad entry must drop that entry only, and a malformed optional field
// must drop the field, never the plugin.
//
// Run: npm test -- plugins

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlugin, sortPlugins, type CommunityPlugin } from './plugins';
import { digest } from './communityDigest';
import type { CommunityCatalog } from './communityCatalog';

const FOLDER = {
  slug: 'folder',
  name: 'Music folder',
  plugin: 'folder',
  connectsTo: 'A folder of audio files',
  repo: 'https://github.com/perminder-klair/subwave/tree/main/docs/examples/sources/folder',
  apiVersion: 1,
  description: 'Plays audio files straight from a folder.',
  author: '@perminder-klair',
  checkedWith: '1.31.0',
  conformance: { pass: 13, warn: 3, fail: 0, skip: 6 },
  hostFiles: true,
  submitted: '2026-11-27',
};

test('a complete entry parses whole', () => {
  assert.deepEqual(parsePlugin(FOLDER), FOLDER);
});

test('the floor: name, plugin, connectsTo, an https repo and an apiVersion', () => {
  for (const key of ['name', 'plugin', 'connectsTo', 'repo', 'apiVersion'] as const) {
    const { [key]: _drop, ...rest } = FOLDER;
    assert.equal(parsePlugin(rest), null, `without ${key}`);
  }
  assert.equal(parsePlugin({ ...FOLDER, repo: 'http://example.com/plugin' }), null, 'plain http repo');
  assert.equal(parsePlugin({ ...FOLDER, repo: 'javascript:alert(1)' }), null, 'script url');
  assert.equal(parsePlugin({ ...FOLDER, apiVersion: 0 }), null);
  assert.equal(parsePlugin({ ...FOLDER, apiVersion: '1' }), null);
});

test('the plugin name follows the router manifest rule', () => {
  assert.equal(parsePlugin({ ...FOLDER, plugin: 'Folder' }), null);
  assert.equal(parsePlugin({ ...FOLDER, plugin: '../etc' }), null);
  assert.equal(parsePlugin({ ...FOLDER, plugin: 'a' }), null);
  assert.equal(parsePlugin({ ...FOLDER, plugin: 'emby-source' })?.plugin, 'emby-source');
});

test('a malformed optional field drops the field and keeps the plugin', () => {
  const p = parsePlugin({
    ...FOLDER,
    checkedWith: 'latest',
    submitted: 'yesterday',
    hostFiles: 'yes',
    conformance: { pass: 13, warn: 3, fail: 0 },
  });
  assert.ok(p);
  assert.equal(p.checkedWith, undefined);
  assert.equal(p.submitted, undefined);
  assert.equal(p.hostFiles, false);
  // A partial result would read as a clean one, so it is dropped whole.
  assert.equal(p.conformance, undefined);
});

test('a v-prefixed version is accepted, and long text is cut', () => {
  const p = parsePlugin({ ...FOLDER, checkedWith: 'v1.32.0', description: 'x'.repeat(400) });
  assert.equal(p?.checkedWith, '1.32.0');
  assert.equal(p?.description?.length, 280);
});

test('the slug falls back to the plugin name', () => {
  const { slug: _slug, ...rest } = FOLDER;
  assert.equal(parsePlugin(rest)?.slug, 'folder');
});

test('newest first, then by name, undated last', () => {
  const at = (name: string, submitted?: string) => ({ ...(parsePlugin(FOLDER) as CommunityPlugin), name, submitted });
  const sorted = sortPlugins([at('B', '2026-11-01'), at('Undated'), at('A', '2026-11-01'), at('New', '2026-11-20')]);
  assert.deepEqual(sorted.map((p) => p.name), ['New', 'A', 'B', 'Undated']);
});

test('the /community hub counts plugins and credits their authors', () => {
  const cat: CommunityCatalog = { skills: [], personas: [], shows: [], stations: [], apps: [], plugins: [FOLDER] };
  const d = digest(cat);
  assert.equal(d.counts.plugin, 1);
  assert.deepEqual(d.previews.plugin, ['Music folder']);
  assert.deepEqual(d.wire, [
    { kind: 'plugin', name: 'Music folder', by: 'perminder-klair', date: '2026-11-27', href: '/plugins#plugin-folder' },
  ]);
  assert.equal(d.contributors[0]?.byKind.plugin, 1);
});
