// scripts/run-tests.ts argument parsing: --jobs / -j / --jobs=, TEST_CONCURRENCY,
// and the name filter. A bad value is refused, never clamped to a serial run.
import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';
import test from 'node:test';
import { parseRunArgs } from './test-utils/run-args.js';

const noEnv = {};

test('no flag and no TEST_CONCURRENCY runs one file at a time', () => {
  assert.deepEqual(parseRunArgs([], noEnv), { jobs: 1, filter: undefined });
  assert.deepEqual(parseRunArgs(['picker'], noEnv), { jobs: 1, filter: 'picker' });
});

test('every spelling of the flag sets the job count, on either side of the filter', () => {
  assert.deepEqual(parseRunArgs(['--jobs', '3'], noEnv), { jobs: 3, filter: undefined });
  assert.deepEqual(parseRunArgs(['-j', '3', 'picker'], noEnv), { jobs: 3, filter: 'picker' });
  assert.deepEqual(parseRunArgs(['picker', '--jobs=4'], noEnv), { jobs: 4, filter: 'picker' });
  assert.equal(parseRunArgs(['--jobs', 'auto'], noEnv).jobs, Math.max(1, availableParallelism()));
  assert.equal(parseRunArgs(['--jobs=auto'], noEnv).jobs, Math.max(1, availableParallelism()));
});

test('only the first leftover argument is the filter', () => {
  assert.equal(parseRunArgs(['picker', 'queue'], noEnv).filter, 'picker');
});

test('TEST_CONCURRENCY applies without a flag, and an empty one means 1', () => {
  assert.equal(parseRunArgs([], { TEST_CONCURRENCY: '5' }).jobs, 5);
  assert.equal(parseRunArgs([], { TEST_CONCURRENCY: 'auto' }).jobs, Math.max(1, availableParallelism()));
  assert.equal(parseRunArgs([], { TEST_CONCURRENCY: '' }).jobs, 1);
});

test('the flag beats TEST_CONCURRENCY, which is then not read at all', () => {
  assert.equal(parseRunArgs(['--jobs', '2'], { TEST_CONCURRENCY: '5' }).jobs, 2);
  assert.equal(parseRunArgs(['--jobs', '2'], { TEST_CONCURRENCY: 'abc' }).jobs, 2);
});

test('a flag with no value is refused, not run serially', () => {
  for (const args of [['picker', '-j'], ['--jobs'], ['--jobs='], ['--jobs', '']]) {
    assert.throws(() => parseRunArgs(args, noEnv), /--jobs must be a positive integer or "auto", got ""/,
      JSON.stringify(args));
  }
});

test('a value that is not a positive integer is refused', () => {
  for (const value of ['0', 'x', '-2', '1.5']) {
    assert.throws(() => parseRunArgs(['--jobs', value], noEnv), /--jobs must be a positive integer/, value);
  }
  assert.throws(() => parseRunArgs(['-j', 'picker'], noEnv), /got "picker"/);
  assert.throws(() => parseRunArgs([], { TEST_CONCURRENCY: 'abc' }), /TEST_CONCURRENCY must be a positive integer/);
});
