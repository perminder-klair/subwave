// No package.json script runs a test file around scripts/run-tests.ts (#2019).
// The runner is what hands each file a temp STATE_DIR (its header explains the
// two layers). `tsx scripts/foo.test.ts` run on its own falls through config.ts
// to the repo's own state/, which on a host running the station is the live
// state root. A script for one file names it as the runner's filter instead:
// `tsx scripts/run-tests.ts foo.test.ts`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packagePath = join(dirname(fileURLToPath(import.meta.url)), '../package.json');
const { scripts } = JSON.parse(readFileSync(packagePath, 'utf8')) as { scripts: Record<string, string> };

// `.test` with no extension counts too: tsx resolves `scripts/foo.test` to the file.
const RUNS_A_TEST = /\.test\b|--test(?![\w-])/;
const THROUGH_RUNNER = /^tsx scripts\/run-tests\.ts(\s|$)/;

// A command can chain several steps (`&&`, `||`, `;`, a pipe, a newline, or a
// lone `&` that backgrounds one), so each step that runs a test is checked.
function bypassesRunner(command: string): boolean {
  return command
    .split(/[;&|\n]+/)
    .map((step) => step.trim())
    .some((step) => RUNS_A_TEST.test(step) && !THROUGH_RUNNER.test(step));
}

test('every script that runs a test file goes through scripts/run-tests.ts', () => {
  const bypassing = Object.entries(scripts)
    .filter(([, command]) => bypassesRunner(command))
    .map(([name, command]) => `${name}: ${command}`);
  assert.deepEqual(bypassing, []);
});

test('the check flags a direct run and passes the runner', () => {
  assert.equal(bypassesRunner('tsx scripts/llm-pure.test.ts'), true);
  assert.equal(bypassesRunner('node --import tsx --test scripts/a.test.ts'), true);
  assert.equal(bypassesRunner('tsx scripts/run-tests.ts a.test.ts && tsx scripts/b.test.ts'), true);
  assert.equal(bypassesRunner('tsx scripts/run-tests.ts a.test.ts & tsx scripts/b.test.ts'), true);
  assert.equal(bypassesRunner('tsx scripts/run-tests.ts a.test.ts\ntsx scripts/b.test.ts'), true);
  assert.equal(bypassesRunner('tsx scripts/llm-pure.test'), true);
  assert.equal(bypassesRunner('tsx scripts/run-tests.ts llm-pure.test.ts'), false);
  assert.equal(bypassesRunner('tsx scripts/run-tests.ts'), false);
});
