// Admin → Music router's derivations: which strips the page shows and in what
// order, what each strip reads, what the service matrix marks, and the Signal
// path monitor's readouts.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MusicCapabilities, MusicPluginInfo, RouterActivityRequest, RouterStatus } from '../../../lib/schemas.generated';
import { activityMetrics, backendNote, buildChannels, coverageRows, formatMs, sourcesOf, statusCells, statusLamp, type RouterView } from './model';

const caps = (on: Partial<MusicCapabilities> = {}): MusicCapabilities => ({
  sonicSimilarity: false,
  artists: false,
  artistInfo: false,
  similarSongs: false,
  topSongs: false,
  lyrics: false,
  stars: false,
  playlists: false,
  scrobble: false,
  scanStatus: false,
  stats: true,
  ...on,
});

const plugin = (name: string, over: Partial<MusicPluginInfo> = {}): MusicPluginInfo => ({
  name,
  label: name[0]!.toUpperCase() + name.slice(1),
  description: `${name} plugin`,
  version: '1.0.0',
  apiVersion: 1,
  idPrefix: name.slice(0, 2),
  builtin: true,
  homepage: null,
  config: [],
  envLocked: [],
  error: null,
  capabilities: null,
  devOnly: false,
  ...over,
});

const jellyfin = plugin('jellyfin', {
  config: [
    { key: 'url', label: 'Server URL', type: 'url', required: true },
    { key: 'apiKey', label: 'API key', type: 'secret', required: true },
    { key: 'user', label: 'User', type: 'string' },
  ],
});

function status(over: Partial<RouterStatus> = {}): RouterStatus {
  return {
    router: { version: '1.0.0', apiVersion: 1 },
    configured: true,
    merge: false,
    configError: null,
    plugins: [plugin('plex'), jellyfin, plugin('mock'), plugin('folder', { builtin: false }), plugin('broken', { builtin: false, error: 'plugin API v99' })],
    active: [],
    serving: null,
    endpoints: [
      { endpoint: 'getSong', group: 'Browsing', needs: null, whenMissing: null },
      { endpoint: 'getTopSongs', group: 'Discovery', needs: 'topSongs', whenMissing: 'degraded', feature: "an artist's top tracks" },
      { endpoint: 'getSonicSimilarTracks', group: 'Discovery', needs: 'sonicSimilarity', whenMissing: 'unsupported', feature: 'sonic picks' },
    ],
    ...over,
  };
}

const active = (name: string, songs: number, on: Partial<MusicCapabilities> = {}) => ({
  plugin: name,
  label: name,
  idPrefix: name.slice(0, 2),
  rawIds: false,
  envLocked: [],
  capabilities: caps(on),
  health: { state: 'healthy' as const, stats: { artists: 1, albums: 2, songs, genres: 3 }, ms: 42 },
});

const view = (s: RouterStatus, over: Partial<RouterView> = {}): RouterView => ({
  mode: 'router',
  merge: s.merge,
  sources: [],
  router: s,
  routerError: null,
  ...over,
});

test('serving sources come first, then built-ins before installed plugins, each alphabetical', () => {
  const channels = buildChannels(view(status({ active: [active('mock', 100)], serving: { name: 'mock', label: 'Mock', capabilities: caps() } })));
  assert.deepEqual(channels.map((c) => c.name), ['mock', 'jellyfin', 'plex', 'broken', 'folder']);
  assert.equal(channels[0]!.onAir, true);
  assert.equal(channels[0]!.readout, 'RDY');
  assert.equal(channels[0]!.ms, 42);
  assert.deepEqual([channels[1]!.lamp, channels[1]!.readout], ['standby', 'STBY']);
  assert.deepEqual([channels[3]!.lamp, channels[3]!.readout, channels[3]!.detail], ['broken', 'LOAD', 'plugin API v99']);
});

test('in direct-Navidrome mode nothing is on air, even if the router still reports a source', () => {
  const channels = buildChannels(view(status({ active: [active('mock', 1)] }), { mode: 'navidrome' }));
  assert.ok(channels.every((c) => !c.onAir));
  assert.ok(!channels.some((c) => c.kind === 'bus'));
});

test('a merged set reads each source as its share of the songs, with the bus after them', () => {
  const s = status({
    merge: true,
    active: [active('jellyfin', 300), active('plex', 100)],
    serving: { name: 'jellyfin+plex', label: 'Merged', capabilities: caps({ topSongs: true }) },
  });
  const channels = buildChannels(view(s));
  assert.deepEqual(channels.slice(0, 3).map((c) => [c.name, c.kind, c.readout]), [
    ['jellyfin', 'source', '75%'],
    ['plex', 'source', '25%'],
    ['jellyfin+plex', 'bus', '100%'],
  ]);
  assert.equal(channels[2]!.stats?.songs, 400);
  assert.equal(channels[0]!.meter, 9);
});

test('an unhealthy serving source reads as an error with its reason', () => {
  const sick = { ...active('jellyfin', 0), health: { state: 'unreachable' as const, error: 'could not connect (ECONNREFUSED)', ms: 10 } };
  const [c] = buildChannels(view(status({ active: [sick] })));
  assert.deepEqual([c!.lamp, c!.readout, c!.detail, c!.alert, c!.meter], ['unreachable', 'ERR', 'could not connect (ECONNREFUSED)', true, 0]);
});

test('settings show saved values, never secrets, and say where a value comes from', () => {
  const s = status({ active: [active('jellyfin', 1)] });
  const v = view(s, { sources: [{ plugin: 'jellyfin', config: { url: 'http://jf:8096' }, secretsSet: ['apiKey'] }] });
  const [c] = buildChannels(v);
  assert.deepEqual(c!.settings.map((f) => [f.label, f.value]), [
    ['Server URL', 'http://jf:8096'],
    ['API key', '•••••• set'],
    ['User', 'unset'],
  ]);
  const locked = buildChannels(view({ ...s, plugins: s.plugins.map((p) => (p.name === 'jellyfin' ? { ...p, envLocked: ['url'] } : p)) }, { sources: v.sources }));
  assert.equal(locked[0]!.settings[0]!.value, 'from env');
});

test('the matrix marks a missing op as the handler handles it, and an unbuilt plugin as unknown', () => {
  const s = status({ active: [active('mock', 1, { topSongs: true })] });
  const channels = buildChannels(view(s));
  const rows = coverageRows(s.endpoints, channels);
  const top = rows.find((r) => r.endpoint === 'getTopSongs')!;
  const sonic = rows.find((r) => r.endpoint === 'getSonicSimilarTracks')!;
  assert.equal(top.cells['src-mock'], 'full');
  assert.equal(sonic.cells['src-mock'], 'unsupported');
  assert.equal(top.cells['src-plex'], 'unknown', 'never built, so not guessed');
  assert.equal(rows.find((r) => r.endpoint === 'getSong')!.varies, false);
  assert.equal(sonic.varies, true);
});

test('a plugin built for a Test reports its capabilities while standing by', () => {
  const s = status({ plugins: [plugin('plex', { capabilities: caps({ topSongs: true }) })] });
  const rows = coverageRows(s.endpoints, buildChannels(view(s)));
  assert.equal(rows.find((r) => r.endpoint === 'getTopSongs')!.cells['src-plex'], 'full');
  assert.equal(rows.find((r) => r.endpoint === 'getSonicSimilarTracks')!.cells['src-plex'], 'unsupported');
});

const req = (over: Partial<RouterActivityRequest>): RouterActivityRequest => ({
  id: Math.random().toString(36),
  endpoint: 'getSong',
  client: 'controller',
  at: 0,
  ms: 10,
  state: 'ok',
  calls: [],
  ...over,
});

test('the monitor averages finished requests and counts failures', () => {
  const m = activityMetrics([req({ ms: 10 }), req({ ms: 30, state: 'error' }), req({ ms: null, state: 'pending' })]);
  assert.deepEqual(m, { captured: 3, avgMs: 20, failed: 1 });
  assert.deepEqual(activityMetrics([]), { captured: 0, avgMs: null, failed: 0 });
});

test('a backend row says what it did for the selected request', () => {
  const r = req({
    calls: [
      { source: 'plex', op: 'song', ms: 40, state: 'ok' },
      { source: 'plex', op: 'starred', ms: 5, state: 'ok' },
      { source: 'jellyfin', op: 'starred', ms: 7, state: 'error' },
    ],
  });
  assert.deepEqual(sourcesOf(r), ['plex', 'jellyfin']);
  assert.deepEqual(backendNote('plex', r, undefined), { text: '2 calls · 45 ms', used: true, failed: false });
  assert.equal(backendNote('jellyfin', r, undefined).failed, true);
  assert.equal(backendNote('mock', r, undefined).text, 'Standby');
});

test('durations read in ms, and in seconds once they are long', () => {
  assert.equal(formatMs(null), 'in flight');
  assert.equal(formatMs(1234), '1,234 ms');
  assert.equal(formatMs(65_000), '65.0 s');
});

test('the Navidrome strip shows the station connection it plays, never a password', () => {
  const s = status({ active: [active('navidrome', 10)], plugins: [plugin('navidrome', { config: [{ key: 'url', label: 'Server URL', type: 'url', required: true }] })] });
  const [c] = buildChannels(view(s, { navidrome: { url: 'http://nd:4533', user: 'radio', passSet: true, env: { url: false, user: true, pass: false } } }));
  assert.deepEqual(c!.settings.map((f) => [f.label, f.value]), [
    ['Server URL', 'http://nd:4533'],
    ['Username', 'from env'],
    ['Password', '•••••• set'],
  ]);
});

test('the header strip reads the router at a glance, lighting what needs attention', () => {
  const s = status({ active: [active('navidrome', 1)], serving: { name: 'navidrome', label: 'Navidrome', capabilities: caps() } });
  const cells = statusCells(view(s), null);
  assert.deepEqual(cells.map((c) => [c.label, c.value, c.tone]), [
    ['Mode', 'ROUTER', 'ok'],
    ['Serving', 'NAVIDROME', undefined],
    ['Router', 'v1.0.0 · API v1', undefined],
    ['Plugins', '5', undefined],
    ['Endpoints', '3', undefined],
    ['Faults', '1', 'bad'],
  ]);
  assert.equal(statusLamp(view(s), null), 'error', 'a plugin that failed to load lights the lamp');

  const direct = statusCells(view(s, { mode: 'navidrome' }), null);
  assert.deepEqual(direct.slice(0, 2).map((c) => [c.value, c.tone]), [['DIRECT', 'warn'], ['NAVIDROME DIRECT', 'warn']]);
  const failedOver = statusCells(view(s, { failover: { active: true } }), null);
  assert.deepEqual(failedOver.slice(0, 2).map((c) => [c.value, c.tone]), [['FAILOVER', 'bad'], ['NAVIDROME DIRECT', 'bad']]);
  assert.deepEqual(statusCells(undefined, 'boom'), [{ label: 'Link', value: 'NO LINK TO THE CONTROLLER', tone: 'bad' }]);

  const clean = status({ plugins: [plugin('navidrome')], active: [active('navidrome', 1)] });
  assert.equal(statusLamp(view(clean), null), 'ok');
  assert.equal(statusLamp(view(clean, { mode: 'navidrome' }), null), 'idle');
  assert.ok(!statusCells(view(clean), null).some((c) => c.label === 'Faults'));
});
