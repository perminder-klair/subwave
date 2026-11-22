// The plugin bay's rules: slot order, lamp state and what each module backs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MusicCapabilities, MusicPluginInfo, RouterStatus } from '../../../lib/schemas.generated';
import { bayReadout, buildBay, moduleCoverage, slotLabel } from './pluginBay';

const caps = (on: Partial<MusicCapabilities> = {}): MusicCapabilities => ({
  sonicSimilarity: false, artists: false, artistInfo: false, similarSongs: false, topSongs: false,
  lyrics: false, stars: false, playlists: false, scrobble: false, scanStatus: false, stats: true, ...on,
});

const plugin = (name: string, over: Partial<MusicPluginInfo> = {}): MusicPluginInfo => ({
  name, label: name[0]!.toUpperCase() + name.slice(1), description: '', version: '1.0.0', apiVersion: 1,
  idPrefix: name.slice(0, 2), builtin: true, homepage: null, config: [], envLocked: [], error: null,
  capabilities: null, devOnly: false, ...over,
});

const endpoints: RouterStatus['endpoints'] = [
  { endpoint: 'getSong', group: 'Browsing', needs: null, whenMissing: null },
  { endpoint: 'getTopSongs', group: 'Discovery', needs: 'topSongs', whenMissing: 'degraded', feature: 'top tracks' },
  { endpoint: 'getSonicSimilarTracks', group: 'Discovery', needs: 'sonicSimilarity', whenMissing: 'unsupported', feature: 'sonic picks' },
];

const status = (over: Partial<RouterStatus> = {}): RouterStatus => ({
  router: { version: '1.0.0', apiVersion: 1 }, configured: true, merge: false, configError: null,
  plugins: [plugin('plex'), plugin('navidrome'), plugin('folder', { builtin: false }), plugin('broken', { builtin: false, error: 'API v99' })],
  active: [{ plugin: 'navidrome', label: 'Navidrome', idPrefix: 'nd', rawIds: true, envLocked: [], capabilities: caps({ topSongs: true }), health: { state: 'healthy', ms: 40 } }],
  serving: null, endpoints, ...over,
});

test('on-air modules take the top slots, then built-ins, then installed — a fault keeps its slot', () => {
  const bay = buildBay(status(), true);
  assert.deepEqual(bay.map((m) => [m.slot, m.plugin.name, m.state]), [
    [1, 'navidrome', 'onair'],
    [2, 'plex', 'standby'],
    [3, 'broken', 'fault'],
    [4, 'folder', 'standby'],
  ]);
  assert.equal(bay[0]!.rawIds, true);
  assert.equal(bay[0]!.health?.ms, 40);
  assert.deepEqual(bayReadout(bay), { slots: 4, onAir: 1, faults: 1, installed: 2 });
  assert.equal(slotLabel(3), 'SLOT 03');
});

test('in direct mode nothing in the bay is on air', () => {
  assert.ok(buildBay(status(), false).every((m) => m.state !== 'onair'));
});

test('coverage follows the router\'s own table: a missing op degrades or errors as its handler does', () => {
  const c = moduleCoverage(endpoints, caps({ topSongs: false }));
  assert.deepEqual(c.cells.map((x) => x.state), ['full', 'degraded', 'unsupported']);
  assert.deepEqual([c.full, c.degraded, c.unsupported, c.unknown, c.total], [1, 1, 1, 0, 3]);
  const unknown = moduleCoverage(endpoints, null);
  assert.deepEqual(unknown.cells.map((x) => x.state), ['full', 'unknown', 'unknown'], 'never built: not guessed');
});

test('a standby module that was tested reports what it supported then', () => {
  const s = status({ plugins: [plugin('plex', { capabilities: caps({ sonicSimilarity: true, topSongs: true }) })], active: [] });
  const [plex] = buildBay(s, true);
  assert.equal(plex!.state, 'standby');
  assert.equal(plex!.coverage.full, 3);
});
