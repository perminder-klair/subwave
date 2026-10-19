// Two layers keep every test file off the repo-local state/ — the live station's
// state root on a host running it. scripts/run-tests.ts hands the whole run one
// temp STATE_DIR, overriding whatever the shell exports, and test-utils/state-dir.ts,
// preloaded into each file, replaces it with that file's own, which is what keeps
// parallel files (`--jobs`) apart. Either layer hides the other's absence, so each
// is checked on its own here.
import assert from 'node:assert/strict';
import { readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoState = resolve(dirname(fileURLToPath(import.meta.url)), '../../state');

function assertTempDir(dir: string) {
  assert.notEqual(resolve(dir), repoState);
  assert.ok(realpathSync(dir).startsWith(realpathSync(tmpdir()) + sep), `${dir} is under ${tmpdir()}`);
}

test('the runner hands the run a temp STATE_DIR, never the repo state/', () => {
  const runDir = process.env.SUBWAVE_TEST_RUN_STATE_DIR;
  assert.ok(runDir, 'the runner exports its dir as SUBWAVE_TEST_RUN_STATE_DIR');
  assertTempDir(runDir);
  assert.equal(process.env.SUBWAVE_TEST_INHERITED_STATE_DIR, runDir,
    'the runner passes its dir to every file as STATE_DIR, whatever the shell exports');
});

test('each file gets its own empty STATE_DIR, not the run one', () => {
  const dir = process.env.STATE_DIR;
  assert.ok(dir, 'STATE_DIR is set for every test file');
  assert.notEqual(dir, process.env.SUBWAVE_TEST_RUN_STATE_DIR, 'the state-dir preload replaced the run dir');
  assertTempDir(dir);
  assert.deepEqual(readdirSync(dir), [], 'nothing has written to this file\'s dir yet');
});
