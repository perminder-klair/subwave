import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

function prepareCache(share: string, state: string, umask: number): void {
  const source = `
    process.umask(${umask});
    const cache = await import('./src/music/stem-cache.ts');
    const status = await cache.stemsRootStatus({ prepare: true });
    if (!status.online) throw new Error(status.message);
  `;
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, STATE_DIR: state, SUBWAVE_STEMS_DIR: share },
    stdio: 'pipe',
  });
}

function stageStation(state: string): void {
  const station = join(state, 'stations', 'night-shift');
  mkdirSync(station, { recursive: true });
  writeFileSync(join(station, 'station.json'), '{"navidromePolicy":"profile-v1"}');
  writeFileSync(join(state, 'stations', 'active.json'), '{"activeId":"night-shift"}');
}

test('new relocated station directories allow writes by analyzer uid 10001', () => {
  const temporary = createTempDir(join(tmpdir(), 'subwave-stems-permissions-'));
  const state = join(temporary, 'state');
  const share = join(temporary, 'stems');
  stageStation(state);
  mkdirSync(share);
  chmodSync(share, 0o777);
  prepareCache(share, state, 0o022);
  for (const dir of [share, join(share, 'stations'), join(share, 'stations', 'night-shift')]) {
    // The production analyzer has neither the controller's UID nor its GID.
    assert.equal(statSync(dir).mode & 0o007, 0o007, `${dir} must allow another UID to write`);
  }
});

test('every ancestor created for a marker is shared despite a restrictive umask', () => {
  const temporary = createTempDir(join(tmpdir(), 'subwave-stems-permissions-'));
  const state = join(temporary, 'state');
  const parent = join(temporary, 'new-share');
  const share = join(parent, 'stems');
  stageStation(state);
  const originalMode = statSync(temporary).mode;
  prepareCache(share, state, 0o077);
  for (const dir of [parent, share, join(share, 'stations'), join(share, 'stations', 'night-shift')]) {
    assert.equal(statSync(dir).mode & 0o777, 0o777, `${dir} must be shared with the analyzer`);
  }
  assert.equal(statSync(temporary).mode, originalMode, 'existing ancestors keep their permissions');
});
