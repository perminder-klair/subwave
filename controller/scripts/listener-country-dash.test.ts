// Two review findings on the Dash Listeners Country column (#1747), pinned:
//
//  - THE HINT REACHES THE PAGE. The web adapter for GET /listeners/connections
//    rebuilt the body field by field and dropped `geoip`, so the "why are some
//    countries blank" line could never render. It must pass the key through,
//    and stay silent (key absent) against an older controller.
//  - THE CHECK SCRIPT READS THE ACTIVE STATION. scripts/geoip-check.ts must
//    report the path the controller itself would use: the active station's
//    setting (stations/active.json), not the first station that has one, and
//    GEOIP_DB_PATH over either.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const { toConnectionsState } = await import('../../web/components/admin/dash/connections.js');

const UNKNOWN = { known: false, count: 0, source: null, proxies: [], dropped: [] } as const;

test('the adapter forwards the geoip status', () => {
  const geoip = { source: 'setting', path: '/var/sub-wave/geo.mmdb', ok: false, error: 'ENOENT' } as const;
  const out = toConnectionsState({ count: 1, connections: [], geoip } as any, UNKNOWN as any);
  assert.deepEqual(out.geoip, geoip);
  assert.equal(out.count, 1);
});

test('an older controller without geoip leaves the key absent', () => {
  const out = toConnectionsState({ count: 0, connections: [] } as any, UNKNOWN as any);
  assert.equal('geoip' in out, false);
  assert.deepEqual(out.trustedProxies, UNKNOWN);
});

const here = path.dirname(fileURLToPath(import.meta.url));
const controllerDir = path.resolve(here, '..');
const tsx = path.join(controllerDir, 'node_modules', '.bin', 'tsx');

function writeSettings(dir: string, geoipDbPath: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ stream: { geoipDbPath } }));
}

// Root, then station "alpha", then "beta" — alphabetical, so a script that took
// the first setting it found would answer with alpha's path. beta is active.
function multiStationRoot(): string {
  const root = createTempDir(path.join(tmpdir(), 'subwave-geoip-check-'));
  writeSettings(path.join(root, 'stations', 'alpha'), '/data/alpha.mmdb');
  writeSettings(path.join(root, 'stations', 'beta'), '/data/beta.mmdb');
  writeFileSync(path.join(root, 'stations', 'active.json'), JSON.stringify({ activeId: 'beta' }));
  return root;
}

function runCheck(stateDir: string, env: Record<string, string> = {}) {
  const childEnv: Record<string, string | undefined> = { ...process.env, STATE_DIR: stateDir, ...env };
  if (!('GEOIP_DB_PATH' in env)) delete childEnv.GEOIP_DB_PATH;
  const r = spawnSync(tsx, ['scripts/geoip-check.ts'], { cwd: controllerDir, env: childEnv, encoding: 'utf8' });
  return r.stdout + r.stderr;
}

test('geoip-check reports the active station path, not the first one found', () => {
  const out = runCheck(multiStationRoot());
  assert.match(out, /path the controller uses: \/data\/beta\.mmdb \(from the setting\)/);
  assert.doesNotMatch(out, /alpha\.mmdb/);
});

test('geoip-check reports GEOIP_DB_PATH over the setting', () => {
  const out = runCheck(multiStationRoot(), { GEOIP_DB_PATH: '/data/env.mmdb' });
  assert.match(out, /path the controller uses: \/data\/env\.mmdb \(from GEOIP_DB_PATH\)/);
});

test('geoip-check on a single-station install reads the root settings', () => {
  const root = createTempDir(path.join(tmpdir(), 'subwave-geoip-check-'));
  writeSettings(root, '/data/root.mmdb');
  assert.match(runCheck(root), /path the controller uses: \/data\/root\.mmdb/);
});
