// Admin → Settings → Music source (#692), end to end through the HTTP routes
// against a REAL music router: what a save refuses, what it applies (the live
// Subsonic connection, the router's config.json, the switch marker), secrets
// staying in the process, a draft test, a plugin rescan, and the direct
// Navidrome section not hijacking a router-mode station.

import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { ROUTER_ROOT, startRouterProcess } from './test-utils/router-process.js';

const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-music-source-route-'));
const routerDir = path.join(stateRoot, 'router');
const routerProc = await startRouterProcess(routerDir);

process.env.STATE_DIR = stateRoot;
process.env.ADMIN_USER = 'test-admin';
process.env.ADMIN_PASS = 'test-pass';
process.env.MUSIC_ROUTER_URL = routerProc.url;
delete process.env.NAVIDROME_URL;
delete process.env.NAVIDROME_USER;
delete process.env.NAVIDROME_PASS;

const express = (await import('express')).default;
const ms = await import('../src/setup/music-source.js');
const setupConfig = await import('../src/setup/config.js');
const { config } = await import('../src/config.js');
const { tagger } = await import('../src/broadcast/tagger.js');
const { router: musicRoutes } = await import('../src/routes/settings/music-source.js');
const { router: coreRoutes } = await import('../src/routes/settings/core.js');

// Boot: the controller provisions the router's credentials, then loads the connection.
await ms.writeRouterConfig(ms.readSelection(await setupConfig.loadSetupConfig()));
await setupConfig.saveSetupConfig({ navidrome: { url: 'http://navidrome.test:4533', user: 'nd-user', pass: 'nd-pass' } });
await setupConfig.loadNavidromeConfig();
// Hold the tagger's slot so a switch reports the carry-across walk as pending
// instead of spawning a real one from inside a test.
tagger.running = true;

const app = express();
app.use(express.json());
app.use(musicRoutes);
app.use(coreRoutes);
const server = createServer(app);
await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const authorization = `Basic ${Buffer.from('test-admin:test-pass').toString('base64')}`;

after(() => {
  server.close();
  routerProc.stop();
  tagger.running = false;
  rmSync(stateRoot, { recursive: true, force: true });
});

async function call(method: string, route: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { authorization, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('the music-source routes are admin-only', async () => {
  const res = await fetch(`${base}/settings/music-source`);
  assert.equal(res.status, 401);
});

test('GET reports direct Navidrome and the router inventory', async () => {
  const { status, body } = await call('GET', '/settings/music-source');
  assert.equal(status, 200);
  assert.equal(body.mode, 'navidrome');
  assert.equal(body.routerError, null);
  assert.deepEqual(body.router.active, [], 'the router idles in navidrome mode');
  const names = body.router.plugins.map((p: any) => p.name).sort();
  assert.deepEqual(names, ['jellyfin', 'mock', 'navidrome', 'plex']);
  const jf = body.router.plugins.find((p: any) => p.name === 'jellyfin');
  assert.ok(jf.config.some((f: any) => f.key === 'apiKey' && f.type === 'secret'));
});

test('a save refuses a draft the router could not serve, and changes nothing', async () => {
  let res = await call('POST', '/settings/music-source', { mode: 'router', sources: [] });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /choose a music source/);
  res = await call('POST', '/settings/music-source', { mode: 'router', sources: [{ plugin: 'jellyfin', config: { url: 'http://jf.test' } }] });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Jellyfin needs: API key/);
  res = await call('POST', '/settings/music-source', { mode: 'router', sources: [{ plugin: 'nope-plugin' }] });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /no music-source plugin named 'nope-plugin'/);
  assert.equal(config.navidrome.url, 'http://navidrome.test:4533');
  assert.equal(ms.readSelection(await setupConfig.loadSetupConfig()).mode, 'navidrome');
});

test('switching to the router makes it the live Subsonic connection', async () => {
  const res = await call('POST', '/settings/music-source', { mode: 'router', sources: [{ plugin: 'mock', config: { songMaxSec: 30 } }] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  assert.equal(res.body.switched, true);
  assert.equal(res.body.reconcile, 'pending', 'the carry-across walk waits for the busy tagger');
  assert.deepEqual(res.body.router.active.map((a: any) => [a.plugin, a.health.state]), [['mock', 'healthy']]);
  assert.equal(config.navidrome.url, routerProc.url);
  assert.equal(config.navidrome.user, ms.readRouterAuth()!.user);
  const routerConfig = JSON.parse(readFileSync(path.join(routerDir, 'config.json'), 'utf8'));
  assert.deepEqual(routerConfig.sources, [{ plugin: 'mock', config: { songMaxSec: 30 } }]);
  assert.ok(existsSync(path.join(stateRoot, 'music-source-switch.json')), 'the next walk will carry the library across');

  // The station's own Subsonic client now reaches the router's library.
  const subsonic = await import('../src/music/subsonic.js');
  assert.deepEqual(await subsonic.ping(), { ok: true });
  const songs = await subsonic.getRandomSongs({ size: 2 });
  assert.match(songs[0].id, /^mock-/);
});

test('secrets stay in the process; a blank secret keeps the stored one', async () => {
  // A Jellyfin source we can save without a reachable server: the router
  // constructs it lazily, so the save succeeds and health reports the outage.
  let res = await call('POST', '/settings/music-source', {
    mode: 'router',
    sources: [{ plugin: 'jellyfin', config: { url: 'http://127.0.0.1:9', apiKey: 'TOP-SECRET-KEY' } }],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(!JSON.stringify(res.body).includes('TOP-SECRET-KEY'));
  assert.equal(res.body.router.active[0].health.state, 'unreachable');
  const got = await call('GET', '/settings/music-source');
  assert.ok(!JSON.stringify(got.body).includes('TOP-SECRET-KEY'));
  assert.deepEqual(got.body.sources[0].secretsSet, ['apiKey']);
  assert.equal(got.body.sources[0].config.url, 'http://127.0.0.1:9');

  res = await call('POST', '/settings/music-source', {
    mode: 'router',
    sources: [{ plugin: 'jellyfin', config: { url: 'http://127.0.0.1:10', apiKey: '' } }],
  });
  assert.equal(res.status, 200);
  const stored = ms.readSelection(await setupConfig.loadSetupConfig()).sources[0]!;
  assert.equal(stored.config.apiKey, 'TOP-SECRET-KEY', 'kept');
  assert.equal(stored.config.url, 'http://127.0.0.1:10');
});

test('a draft test reports health without saving it', async () => {
  const res = await call('POST', '/settings/music-source/test', { plugin: 'mock', config: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.stats.songs, 261);
  assert.equal(res.body.capabilities.playlists, true);
  // Uses the stored secret when the draft leaves it blank.
  const jf = await call('POST', '/settings/music-source/test', { plugin: 'jellyfin', config: { url: 'http://127.0.0.1:9' } });
  assert.equal(jf.body.state, 'unreachable');
  assert.equal(ms.readSelection(await setupConfig.loadSetupConfig()).sources[0]!.plugin, 'jellyfin', 'nothing was saved');
});

test('the direct Navidrome section saves without hijacking a router-mode station', async () => {
  const res = await call('POST', '/settings/navidrome', { url: 'http://navidrome2.test:4533' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, live: false });
  assert.equal(config.navidrome.url, routerProc.url, 'still the router');
  const settings = await call('GET', '/settings');
  assert.equal(settings.body.navidrome.url, 'http://navidrome2.test:4533', 'the section shows the stored connection');
  assert.equal(settings.body.navidrome.user, 'nd-user');
  assert.equal(settings.body.musicMode, 'router');
});

test('rescan picks up a plugin dropped into state/router/plugins', async () => {
  cpSync(path.join(ROUTER_ROOT, 'scripts/fixtures/plugins/good'), path.join(routerDir, 'plugins', 'good'), { recursive: true });
  const res = await call('POST', '/settings/music-source/rescan');
  assert.equal(res.status, 200);
  assert.ok(res.body.router.plugins.some((p: any) => p.name === 'good' && p.error === null && !p.builtin));
});

test('switching back to Navidrome restores the stored connection and idles the router', async () => {
  const res = await call('POST', '/settings/music-source', { mode: 'navidrome' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(config.navidrome.url, 'http://navidrome2.test:4533');
  assert.equal(config.navidrome.user, 'nd-user');
  const routerConfig = JSON.parse(readFileSync(path.join(routerDir, 'config.json'), 'utf8'));
  assert.deepEqual(routerConfig.sources, []);
  // The router sources are kept on file for next time.
  assert.equal(ms.readSelection(await setupConfig.loadSetupConfig()).sources[0]!.plugin, 'jellyfin');
});
