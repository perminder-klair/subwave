// Converting a music-router station to multi-station (#692, #1827 review).
// Two things went wrong before: `router/` moved into stations/main (its
// credentials and installed plugins stranded, since the router mounts only
// STATE_ROOT/router), and the conversion preserved the LIVE connection as the
// station's Navidrome — which, in router mode, is the router itself.
//
// The route passes setup/config storedNavidrome() to manager.createStation;
// this drives that same composition against a throwaway root.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'subwave-stations-router-'));
process.env.STATE_DIR = root;
delete process.env.NAVIDROME_URL;
delete process.env.NAVIDROME_USER;
delete process.env.NAVIDROME_PASS;

const ms = await import('../src/setup/music-source.js');
const setupConfig = await import('../src/setup/config.js');
const { config } = await import('../src/config.js');
const manager = await import('../src/stations/manager.js');

after(() => rmSync(root, { recursive: true, force: true }));

const stored = { url: 'http://music-a:4533', user: 'a', pass: 'secret-a' };

test('a router-mode station converts with its own Navidrome and keeps the router install-level', async () => {
  writeFileSync(join(root, 'settings.json'), '{"station":"Router FM"}');
  writeFileSync(join(root, 'setup-config.json'), JSON.stringify({
    navidrome: stored,
    music: { mode: 'router', sources: [{ plugin: 'folder', config: { path: '/music' } }] },
  }));
  writeFileSync(join(root, 'music-source-switch.json'), '{"version":1,"at":"2026-10-07T12:00:00.000Z","from":"a","to":"b"}');
  await setupConfig.syncRouterConfig();
  mkdirSync(join(root, 'router', 'plugins', 'folder'), { recursive: true });
  writeFileSync(join(root, 'router', 'plugins', 'folder', 'subwave-source.json'), '{}');
  const routerConfig = readFileSync(join(root, 'router', 'config.json'), 'utf8');

  await setupConfig.loadNavidromeConfig();
  assert.equal(config.navidrome.url, ms.ROUTER_URL, 'the live connection is the router');

  const navidrome = await setupConfig.storedNavidrome();
  assert.deepEqual(navidrome, { url: stored.url, user: stored.user, password: stored.pass });

  const { id, converted } = await manager.createStation(root, {
    name: 'Second',
    mode: 'fresh',
    currentName: 'Router FM',
    currentNavidrome: { url: navidrome.url, user: navidrome.user, pass: navidrome.password },
  });
  assert.equal(id, 'second');
  assert.equal(converted, true);

  assert.equal(readFileSync(join(root, 'router', 'config.json'), 'utf8'), routerConfig, 'credentials stay where the router reads them');
  assert.ok(existsSync(join(root, 'router', 'plugins', 'folder', 'subwave-source.json')), 'installed plugins stay');
  assert.ok(!existsSync(join(root, 'stations', 'main', 'router')));

  const main = JSON.parse(readFileSync(join(root, 'stations', 'main', 'setup-config.json'), 'utf8'));
  assert.deepEqual(main.navidrome, stored, 'the station keeps its own Navidrome, not the router');
  assert.equal(main.music.mode, 'router');
  assert.ok(existsSync(join(root, 'stations', 'main', 'music-source-switch.json')), 'a pending switch belongs to its station');
});
