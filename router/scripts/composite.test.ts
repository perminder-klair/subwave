// Merged sets: routing by owner, the raw-id fallback owner, and album-list
// paging served from one snapshot instead of offset+size per child per page.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createComposite } from '../src/host/composite.js';
import { prefixedCodec, rawCodec } from '../src/host/ids.js';
import { loadPlugin } from '../src/host/loader.js';
import { wrapPlugin } from '../src/host/wrap.js';
import type { HostSource } from '../src/host/types.js';
import type { SourcePlugin } from '../src/sdk/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const quiet = { info() {}, warn() {}, error() {} };

async function load(dir: string, builtin: boolean, config: Record<string, unknown> = {}): Promise<SourcePlugin> {
  const p = await loadPlugin(dir, builtin);
  assert.equal(p.error, undefined);
  return p.factory!({ config: config as Record<string, string>, fetch, log: quiet, dataDir: '/tmp' });
}

async function mock(): Promise<HostSource> {
  return wrapPlugin(await load(resolve(here, '../src/sources/mock'), true), { name: 'mock', label: 'Mock', codec: prefixedCodec('mock'), log: quiet });
}

async function good(raw = false): Promise<HostSource> {
  const plugin = await load(resolve(here, 'fixtures/plugins/good'), false, { greeting: 'g' });
  return wrapPlugin(plugin, { name: 'good', label: 'Good', codec: raw ? rawCodec() : prefixedCodec('good'), rawIds: raw, log: quiet });
}

test('ids route to their owner; unknown prefixes resolve to nothing', async () => {
  const c = createComposite([await mock(), await good()]);
  assert.equal((await c.song('good-s2'))?.title, 'Song 2');
  const m = (await c.randomSongs(1, {}))[0]!;
  assert.ok(await c.song(m.id));
  assert.equal(await c.song('px-123'), undefined);
  assert.equal(c.owns('px-123'), false);
});

test('a raw-id source owns whatever no prefixed source claims, and is asked last', async () => {
  const m = await mock();
  const c = createComposite([await good(true), m]);
  assert.equal((await c.song('s1'))?.title, 'Song 1', 'raw id resolves through the raw source');
  const mockSong = (await m.randomSongs(1, {}))[0]!;
  assert.equal((await c.song(mockSong.id))?.id, mockSong.id, 'a prefixed id is not swallowed by the raw source');
  await assert.rejects(async () => createComposite([await good(true), await good(true)]), /only one source/);
});

test('album-list paging returns every album exactly once, from one pass per child', async () => {
  const m = await mock();
  let calls = 0;
  const counted: HostSource = { ...m, albumList: async (...args) => (calls++, m.albumList(...args)) };
  const c = createComposite([counted, await good()]);
  const seen: string[] = [];
  for (let offset = 0; ; offset += 7) {
    const page = await c.albumList('alphabeticalByName', 7, offset);
    seen.push(...page.map((a) => a.id));
    if (page.length < 7) break;
  }
  assert.equal(seen.length, 29 + 1);
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(calls, 1, 'the mock was walked once for the whole paged read');
});

test('scan status: any source scanning is scanning; sources that cannot tell are left out', async () => {
  const m = await mock();
  const scanning: HostSource = { ...m, scanStatus: async () => ({ scanning: true, count: 5 }) };
  assert.deepEqual(await createComposite([m, await good()]).scanStatus(), { scanning: false, count: 261 });
  assert.deepEqual(await createComposite([scanning, m]).scanStatus(), { scanning: true, count: 266 });
  const g1 = await good();
  const g2 = { ...(await good()), name: 'good2' };
  assert.equal(await createComposite([g1, g2]).scanStatus(), null);
});

test('a child that fails a merged read shrinks the answer instead of failing it', async () => {
  const m = await mock();
  const broken: HostSource = { ...(await good()), search: async () => { throw new Error('backend down'); } };
  const hit = await createComposite([m, broken]).search('neon', { artistCount: 5, albumCount: 5, songCount: 5 });
  assert.ok(hit.songs.length > 0);
});

test('stars and playlists go to the owner; ids a backend cannot hold are dropped', async () => {
  const m = await mock();
  const c = createComposite([m, await good()]);
  const song = (await m.randomSongs(1, {}))[0]!;
  await c.star([song.id, 'good-s1']);
  assert.ok((await c.starred()).has(song.id));
  const pl = await c.createPlaylist('mixed', [song.id, 'good-s1']);
  assert.match(pl.id, /^mock-pl-/);
  assert.deepEqual(pl.songs.map((s) => s.id), [song.id]);
  await c.unstar([song.id]);
  await c.deletePlaylist(pl.id);
});
