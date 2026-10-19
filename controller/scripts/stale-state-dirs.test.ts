// The runner's start-of-run sweep (test-utils/stale-state-dirs.ts) removes only
// a day-old top-level dir named exactly like a test STATE_DIR — never a file, a
// symlink, a near-miss name, something nested, or a dir another run still uses.
import assert from 'node:assert/strict';
import { existsSync, lutimesSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sweepStaleStateDirs } from './test-utils/stale-state-dirs.js';
import { createTempDir } from './test-utils/temp-dir.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const then = new Date('2026-01-01T00:00:00Z');
const now = then.getTime() + 2 * DAY_MS;

test('only a day-old top-level dir named like a test STATE_DIR is swept', () => {
  const root = createTempDir(join(tmpdir(), 'subwave-sweep-test-'));
  const at = (name: string) => join(root, name);

  mkdirSync(at('subwave-test-state-AbC123'));
  writeFileSync(at('subwave-test-state-AbC123/settings.json'), '{}');
  mkdirSync(at('subwave-test-state-Fresh1'));
  writeFileSync(at('subwave-test-state-File01'), 'not a dir');
  mkdirSync(at('subwave-test-state-Seven77'));
  mkdirSync(at('subwave-test-state-ab-cde'));
  mkdirSync(at('my-subwave-test-state-Prefix'));
  mkdirSync(at('nested/subwave-test-state-Nested'), { recursive: true });
  mkdirSync(at('target'));
  symlinkSync(at('target'), at('subwave-test-state-Link01'));

  for (const name of ['subwave-test-state-AbC123', 'subwave-test-state-File01', 'subwave-test-state-Seven77',
    'subwave-test-state-ab-cde', 'my-subwave-test-state-Prefix', 'nested/subwave-test-state-Nested', 'target']) {
    utimesSync(at(name), then, then);
  }
  lutimesSync(at('subwave-test-state-Link01'), then, then);
  const anHourAgo = new Date(now - 60 * 60 * 1000);
  utimesSync(at('subwave-test-state-Fresh1'), anHourAgo, anHourAgo);

  assert.deepEqual(sweepStaleStateDirs(root, now), [at('subwave-test-state-AbC123')]);
  assert.equal(existsSync(at('subwave-test-state-AbC123')), false);
  for (const kept of ['subwave-test-state-Fresh1', 'subwave-test-state-File01', 'subwave-test-state-Seven77',
    'subwave-test-state-ab-cde', 'my-subwave-test-state-Prefix', 'nested/subwave-test-state-Nested',
    'subwave-test-state-Link01', 'target']) {
    assert.ok(existsSync(at(kept)), `${kept} is kept`);
  }
});

test('a missing root sweeps nothing and does not throw', () => {
  assert.deepEqual(sweepStaleStateDirs(join(tmpdir(), 'subwave-sweep-test-missing-zz9'), now), []);
});
