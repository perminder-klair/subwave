import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createStation, activateStation, listStations } from '../src/stations/manager.js';

const a = { url: 'http://music-a:4533', user: 'station-a', pass: 'password-a' };
const b = { url: 'http://music-b:4533', user: 'station-b', pass: 'password-b' };

// A fresh process matters: station paths and environment policy are boot-time
// decisions. Exercise the real boot loader and both setup-status readers.
function boot(root: string, action = '') {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    const { config } = await import('./src/config.ts');
    const { loadNavidromeConfig, saveSetupConfig, applyNavidromeToLiveConfig } = await import('./src/setup/config.ts');
    const { getSetupStatus, getSetupStatusSync } = await import('./src/setup/firstRun.ts');
    const { navidromeEnvLocks } = await import('./src/setup/navidrome-policy.ts');
    const { NAVIDROME_ENV_ENABLED } = await import('./src/config.ts');
    await loadNavidromeConfig();
    ${action}
    console.log(JSON.stringify({
      connection: config.navidrome,
      status: await getSetupStatus(), sync: getSetupStatusSync(),
      locks: navidromeEnvLocks(NAVIDROME_ENV_ENABLED),
    }));
  `], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
    env: { ...process.env, STATE_DIR: root, NAVIDROME_URL: a.url, NAVIDROME_USER: a.user, NAVIDROME_PASS: a.pass },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!);
}

function connection(result: ReturnType<typeof boot>) {
  const nv = result.connection;
  return { url: nv.url, user: nv.user, pass: nv.password };
}

test('conversion preserves original connection; fresh/duplicate require setup despite env; switching restores each source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'subwave-station-nv-'));
  try {
    assert.deepEqual(connection(boot(root)), a, 'single-station env remains supported');
    writeFileSync(join(root, 'setup-config.json'), JSON.stringify({ navidrome: b, setupCompletedAt: 'earlier' }));
    const fresh = await createStation(root, { name: 'B', currentName: 'A', currentNavidrome: a });
    const stored = JSON.parse(readFileSync(join(root, 'stations/main/setup-config.json'), 'utf8'));
    assert.deepEqual(stored.navidrome, a, 'preserve effective values, including env overrides');
    assert.equal(stored.setupCompletedAt, 'earlier');
    assert.deepEqual(connection(boot(root)), a);
    const duplicate = await createStation(root, { name: 'Copy', currentName: 'A', mode: 'duplicate' });
    for (const id of [duplicate.id, fresh.id]) {
      activateStation(root, id);
      const unconfigured = boot(root);
      assert.deepEqual(connection(unconfigured), { url: '', user: '', pass: '' });
      assert.equal(unconfigured.status.needsSetup, true);
      assert.equal(unconfigured.sync.needsSetup, true);
      assert.deepEqual(unconfigured.locks, { url: false, user: false, pass: false });
    }
    const saved = boot(root, `const nv = ${JSON.stringify(b)}; await saveSetupConfig({ navidrome: nv }); applyNavidromeToLiveConfig(nv);`);
    assert.deepEqual(connection(saved), b);
    assert.equal(saved.status.needsSetup, false);
    assert.equal(saved.sync.needsSetup, false);
    assert.deepEqual(connection(boot(root)), b, 'saved connection survives restart with env still present');
    activateStation(root, 'main');
    assert.deepEqual(connection(boot(root)), a);
    activateStation(root, fresh.id);
    assert.deepEqual(connection(boot(root)), b);
    assert.equal(listStations(root, 'unused', true).find(s => s.id === duplicate.id)?.configured, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing, partial and corrupt station connections never fall back to shared env', () => {
  const root = mkdtempSync(join(tmpdir(), 'subwave-station-nv-invalid-'));
  try {
    const dir = join(root, 'stations', 'main');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'station.json'), '{"navidromePolicy":"profile-v1"}');
    writeFileSync(join(root, 'stations', 'active.json'), '{"activeId":"main"}');
    for (const contents of ['{}', '{"navidrome":{"url":"http://music:4533"}}', 'broken']) {
      writeFileSync(join(dir, 'setup-config.json'), contents);
      const result = boot(root);
      assert.equal(result.status.needsSetup, true);
      assert.equal(result.sync.needsSetup, true);
      assert.equal(result.connection.user, '');
      assert.equal(result.connection.password, '');
      assert.equal(listStations(root, 'unused', true)[0].configured, false);
    }
    // A real station may use the conventional container hostname too.
    writeFileSync(join(dir, 'setup-config.json'), JSON.stringify({ navidrome: { ...b, url: 'http://navidrome:4533' } }));
    assert.equal(boot(root).sync.needsSetup, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('malformed saved connection objects leave both setup readers unconfigured', () => {
  const root = mkdtempSync(join(tmpdir(), 'subwave-station-nv-malformed-'));
  try {
    const dir = join(root, 'stations', 'main');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'station.json'), '{"navidromePolicy":"profile-v1"}');
    writeFileSync(join(root, 'stations', 'active.json'), '{"activeId":"main"}');
    for (const navidrome of [
      null, false, 42, 'invalid', [], [b],
      { ...b, url: { host: 'music-b' } },
      { ...b, user: ['station-b'] },
      { ...b, pass: 42 },
    ]) {
      writeFileSync(join(dir, 'setup-config.json'), JSON.stringify({ navidrome }));
      const result = boot(root);
      assert.equal(result.status.needsSetup, true, JSON.stringify(navidrome));
      assert.equal(result.sync.needsSetup, true, JSON.stringify(navidrome));
      assert.equal(listStations(root, 'unused', true)[0].configured, false);
      for (const value of Object.values(connection(result))) assert.equal(typeof value, 'string');
    }
    const repaired = boot(root, `await saveSetupConfig({ navidrome: ${JSON.stringify(b)} }); await loadNavidromeConfig();`);
    assert.deepEqual(connection(repaired), b);
    assert.equal(repaired.status.needsSetup, false);
    assert.equal(repaired.sync.needsSetup, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('duplicating a profile never imports its retained legacy mood library', async () => {
  const root = mkdtempSync(join(tmpdir(), 'subwave-station-legacy-library-'));
  try {
    const legacy = JSON.stringify({ tracks: {
      'legacy-source-id': { title: 'Source song', artist: 'Source artist', moods: ['calm'], energy: 'low' },
    } });
    writeFileSync(join(root, 'moods.json'), legacy);
    const duplicate = await createStation(root, { name: 'Copy', currentName: 'A', mode: 'duplicate', currentNavidrome: a });
    activateStation(root, duplicate.id);
    boot(root, `
      const assert = await import('node:assert/strict');
      const db = await import('./src/music/library-db.ts');
      await db.open({ embeddingDim: 3 });
      try {
        assert.equal(db.getTrack('legacy-source-id'), null, 'duplicate must not inherit source library rows');
        assert.equal(db.stats().mirrorTotal, 0);
      } finally { db.close(); }
    `);
    assert.equal(existsSync(join(root, 'stations', duplicate.id, 'moods.json')), false);
    assert.equal(readFileSync(join(root, 'stations', 'main', 'moods.json'), 'utf8'), legacy);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
