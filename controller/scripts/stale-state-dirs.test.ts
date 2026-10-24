// The runner's start-of-run sweep (test-utils/stale-state-dirs.ts) removes only
// a day-old top-level dir named exactly like a test STATE_DIR — never a file, a
// symlink, a near-miss name, something nested, a dir another run still uses, or
// one another user owns.
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
  const anHourAgo = new Date(now - 60 * 60 * 1000);
  // In creation order: the symlink needs its target first.
  const fixtures: Array<{ name: string; make: (path: string) => void; mtime: Date; swept: boolean }> = [
    { name: 'subwave-test-state-AbC123', make: (p) => { mkdirSync(p); writeFileSync(join(p, 'settings.json'), '{}'); }, mtime: then, swept: true },
    { name: 'subwave-test-state-Fresh1', make: mkdirSync, mtime: anHourAgo, swept: false },
    { name: 'subwave-test-state-File01', make: (p) => writeFileSync(p, 'not a dir'), mtime: then, swept: false },
    { name: 'subwave-test-state-Seven77', make: mkdirSync, mtime: then, swept: false },
    { name: 'subwave-test-state-ab-cde', make: mkdirSync, mtime: then, swept: false },
    { name: 'my-subwave-test-state-Prefix', make: mkdirSync, mtime: then, swept: false },
    { name: 'nested/subwave-test-state-Nested', make: (p) => mkdirSync(p, { recursive: true }), mtime: then, swept: false },
    { name: 'target', make: mkdirSync, mtime: then, swept: false },
    { name: 'subwave-test-state-Link01', make: (p) => symlinkSync(at('target'), p), mtime: then, swept: false },
  ];
  for (const { name, make, mtime } of fixtures) {
    make(at(name));
    lutimesSync(at(name), mtime, mtime); // the link itself, never its target
  }

  assert.deepEqual(sweepStaleStateDirs(root, now), fixtures.filter((f) => f.swept).map((f) => at(f.name)));
  for (const { name, swept } of fixtures) {
    assert.equal(existsSync(at(name)), !swept, `${name} is ${swept ? 'swept' : 'kept'}`);
  }
});

// A dir another user owns cannot be made without root, so the sweep is told this
// one belongs to someone else instead.
test('a stale dir another user owns is never swept', { skip: process.getuid === undefined }, () => {
  const root = createTempDir(join(tmpdir(), 'subwave-sweep-test-'));
  const dir = join(root, 'subwave-test-state-NotOur');
  mkdirSync(dir);
  utimesSync(dir, then, then);

  assert.deepEqual(sweepStaleStateDirs(root, now, process.getuid!() + 1), []);
  assert.ok(existsSync(dir), 'another user\'s dir is kept');
  assert.deepEqual(sweepStaleStateDirs(root, now), [dir], 'the same dir is swept as its owner\'s');
});

test('a missing root sweeps nothing and does not throw', () => {
  assert.deepEqual(sweepStaleStateDirs(join(tmpdir(), 'subwave-sweep-test-missing-zz9'), now), []);
});
