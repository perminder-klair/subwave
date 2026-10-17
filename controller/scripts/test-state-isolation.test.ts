// The runner hands every test file a fresh temp STATE_DIR (scripts/run-tests.ts),
// so a file that never sets its own cannot fall through config.ts to the
// repo-local state/ — the live station's state root on a host running it.
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('the runner points STATE_DIR at a temp dir, never the repo state/', () => {
  const dir = process.env.STATE_DIR;
  assert.ok(dir, 'STATE_DIR is set for every test file');
  const repoState = resolve(dirname(fileURLToPath(import.meta.url)), '../../state');
  assert.notEqual(resolve(dir), repoState);
  assert.ok(realpathSync(dir).startsWith(realpathSync(tmpdir()) + sep), `${dir} is under ${tmpdir()}`);
});
