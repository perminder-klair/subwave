// Admin → Settings → Music source (#692), end to end through the HTTP routes
// against a REAL music router: what a save refuses, what it applies (the live
// Subsonic connection, the router's config.json, the switch marker), secrets
// staying in the process, a draft test, a plugin rescan, and the direct
// Navidrome section not hijacking a router-mode station.

import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const { tagger, switchBlocksMessage } = await import('../src/broadcast/tagger.js');
const { router: musicRoutes } = await import('../src/routes/settings/music-source.js');
const { router: coreRoutes } = await import('../src/routes/settings/core.js');

// An upgraded station: a Navidrome connection and no music block. Boot writes
// the router's config.json (its credentials, and the station's Navidrome as its
// default source), then loads the live connection.
await setupConfig.saveSetupConfig({ navidrome: { url: 'http://navidrome.test:4533', user: 'nd-user', pass: 'nd-pass' } });
await setupConfig.syncRouterConfig();
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

test('GET reports the default: the station\'s Navidrome behind the router, and the inventory', async () => {
  const { status, body } = await call('GET', '/settings/music-source');
  assert.equal(status, 200);
  assert.equal(body.mode, 'router');
  assert.deepEqual(body.sources, [{ plugin: 'navidrome', config: {}, rawIds: true, secretsSet: [] }]);
  assert.equal(body.routerError, null);
  assert.deepEqual(body.router.active.map((a: any) => a.plugin), ['navidrome'], 'the router serves it');
  assert.equal(config.navidrome.url, routerProc.url, 'the live connection is the router');
  // The station connection it plays, without the password.
  assert.deepEqual({ ...body.navidrome, env: undefined }, { url: 'http://navidrome.test:4533', user: 'nd-user', passSet: true, env: undefined });
  assert.equal(body.failover.active, false);
  assert.equal(body.failover.eligible, true);
  // The demo library is for development: hidden from the operator.
  const names = body.router.plugins.map((p: any) => p.name).sort();
  assert.deepEqual(names, ['jellyfin', 'navidrome', 'plex']);
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
  assert.equal(config.navidrome.url, routerProc.url);
  assert.deepEqual(ms.readSelection(await setupConfig.loadSetupConfig()).sources.map((s) => s.plugin), ['navidrome']);
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

test('the activity feed shows the station\'s own Subsonic calls and which source answered', async () => {
  assert.equal((await fetch(`${base}/settings/music-source/activity`)).status, 401, 'admin-only');
  const subsonic = await import('../src/music/subsonic.js');
  await subsonic.getRandomSongs({ size: 1 });
  const { status, body } = await call('GET', '/settings/music-source/activity');
  assert.equal(status, 200);
  const latest = body.requests.find((r: any) => r.endpoint === 'getRandomSongs');
  assert.ok(latest, 'the request reached the feed');
  assert.equal(latest.client, 'controller');
  assert.equal(latest.state, 'ok');
  assert.ok(latest.calls.some((c: any) => c.source === 'mock' && c.op === 'randomSongs'));
  assert.ok(!JSON.stringify(body).includes(ms.readRouterAuth()!.pass), 'no credential rides the feed');
  // The status the page also reads says what the active plugin supports.
  const mock = (await call('GET', '/settings/music-source')).body.router.plugins.find((p: any) => p.name === 'mock');
  assert.equal(mock.capabilities.similarSongs, true);
});

// #1827 review: the router is the one step that can still refuse a selection
// (a plugin that throws on start-up). The save used to persist setup-config,
// repoint the live connection and write a switch marker first, then answer
// ok:false while the router kept serving the previous source.
test('a selection the router refuses at start-up is rolled back, not half-applied', async () => {
  const dir = path.join(routerDir, 'plugins', 'explodes');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'subwave-source.json'), JSON.stringify({ name: 'explodes', label: 'Explodes', version: '1.0.0', apiVersion: 1, idPrefix: 'exp', entry: 'index.mjs', config: [] }));
  writeFileSync(path.join(dir, 'index.mjs'), 'export default () => { throw new Error("cannot reach the backend at start-up"); };\n');
  assert.equal((await call('POST', '/settings/music-source/rescan')).status, 200);

  const before = {
    setup: readFileSync(path.join(stateRoot, 'setup-config.json'), 'utf8'),
    router: readFileSync(path.join(routerDir, 'config.json'), 'utf8'),
    marker: readFileSync(path.join(stateRoot, 'music-source-switch.json'), 'utf8'),
    live: { ...config.navidrome },
  };
  const res = await call('POST', '/settings/music-source', { mode: 'router', sources: [{ plugin: 'explodes', config: {} }] });
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /cannot reach the backend at start-up/);
  assert.equal(res.body.switched, false);
  assert.deepEqual(res.body.sources.map((s: any) => s.plugin), ['mock'], 'the reply shows what is still stored');

  assert.equal(readFileSync(path.join(stateRoot, 'setup-config.json'), 'utf8'), before.setup);
  assert.equal(readFileSync(path.join(routerDir, 'config.json'), 'utf8'), before.router, 'the router config is restored');
  assert.equal(readFileSync(path.join(stateRoot, 'music-source-switch.json'), 'utf8'), before.marker, 'no marker for a library that never went live');
  assert.deepEqual({ ...config.navidrome }, before.live);
  assert.equal(ms.currentSelection().sources[0]!.plugin, 'mock');
  const got = await call('GET', '/settings/music-source');
  assert.equal(got.body.router.configError, null, 'the restored config is the one being served');
  assert.deepEqual(got.body.router.active.map((a: any) => a.plugin), ['mock'], 'still serving the previous source');
  rmSync(dir, { recursive: true, force: true });
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
    sources: [{ plugin: 'jellyfin', config: { url: 'http://127.0.0.1:9', apiKey: '', user: 'someone' } }],
  });
  assert.equal(res.status, 200);
  let stored = ms.readSelection(await setupConfig.loadSetupConfig()).sources[0]!;
  assert.equal(stored.config.apiKey, 'TOP-SECRET-KEY', 'kept: same server');
  assert.equal(stored.config.user, 'someone');

  // A new server needs its key typed again: the stored one is not sent there.
  res = await call('POST', '/settings/music-source', {
    mode: 'router',
    sources: [{ plugin: 'jellyfin', config: { url: 'http://127.0.0.1:10', apiKey: '' } }],
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Jellyfin needs: API key/);
  stored = ms.readSelection(await setupConfig.loadSetupConfig()).sources[0]!;
  assert.equal(stored.config.url, 'http://127.0.0.1:9', 'nothing saved');
});

test('a draft test reports health without saving it', async () => {
  const res = await call('POST', '/settings/music-source/test', { plugin: 'mock', config: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.stats.songs, 261);
  assert.equal(res.body.capabilities.playlists, true);
  // Uses the stored secret when the draft leaves it blank — for the stored server only.
  const jf = await call('POST', '/settings/music-source/test', { plugin: 'jellyfin', config: { url: 'http://127.0.0.1:9' } });
  assert.equal(jf.body.state, 'unreachable');
  const elsewhere = await call('POST', '/settings/music-source/test', { plugin: 'jellyfin', config: { url: 'http://127.0.0.1:11' } });
  assert.equal(elsewhere.body.state, 'not-configured', 'no stored key travels to another server');
  assert.equal(ms.readSelection(await setupConfig.loadSetupConfig()).sources[0]!.plugin, 'jellyfin', 'nothing was saved');
});

test('the Navidrome connection is kept on file while the station plays other sources', async () => {
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

test('going direct to Navidrome restores the stored connection and idles the router', async () => {
  const res = await call('POST', '/settings/music-source', { mode: 'navidrome' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(config.navidrome.url, 'http://navidrome2.test:4533');
  assert.equal(config.navidrome.user, 'nd-user');
  const routerConfig = JSON.parse(readFileSync(path.join(routerDir, 'config.json'), 'utf8'));
  assert.deepEqual(routerConfig.sources, []);
  // The router sources are kept on file for next time.
  assert.equal(ms.readSelection(await setupConfig.loadSetupConfig()).sources[0]!.plugin, 'jellyfin');
});

test('back behind the router, the station\'s Navidrome is the same library, and its connection saves live', async () => {
  const markerPath = path.join(stateRoot, 'music-source-switch.json');
  const marker = () => (existsSync(markerPath) ? readFileSync(markerPath, 'utf8') : null);
  const before = marker();
  let res = await call('POST', '/settings/music-source', { mode: 'router', sources: [{ plugin: 'navidrome', config: {} }] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.switched, false, 'direct and behind the router publish the same ids');
  assert.equal(marker(), before, 'no new switch marker');
  assert.equal(config.navidrome.url, routerProc.url);
  const routed = () => JSON.parse(readFileSync(path.join(routerDir, 'config.json'), 'utf8')).sources;
  assert.deepEqual(routed(), [{ plugin: 'navidrome', config: { url: 'http://navidrome2.test:4533', user: 'nd-user', password: 'nd-pass' }, rawIds: true }]);

  // A new login for the station's Navidrome reaches the router at once.
  res = await call('POST', '/settings/navidrome', { user: 'nd-user-2' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { ok: true });
  assert.equal(routed()[0].config.user, 'nd-user-2');
  assert.equal(config.navidrome.url, routerProc.url, 'still the router');
});

test('the booth line names the track blocks a switch could not place', () => {
  assert.equal(
    switchBlocksMessage({ count: 3, tracks: [{ name: 'Lost Song', artist: 'Nobody' }, { name: 'Other', artist: null }] }),
    'Music source switch: 3 blocked tracks were not found on the new source (Lost Song — Nobody; Other and 1 more) — if they are there under different names, block them again',
  );
  assert.match(switchBlocksMessage({ count: 1, tracks: [] }), /^Music source switch: 1 blocked track was not found/);
});
