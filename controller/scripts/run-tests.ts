// Test-suite runner for controller/. Auto-discovers every `scripts/*.test.ts`
// and hands the list to `node --test`, which runs each file as its own
// subprocess. Registration is just dropping the file in here.
//
//   npm test              # run the whole suite
//   npm test -- picker    # run only files whose name matches "picker"
//
// Two shapes coexist: a plain script reporting one pass/fail off its exit
// code, and the node:test shape reporting per assertion. Prefer node:test for
// anything new.
//
// Concurrency is pinned to 1 — these files reach for shared ground (a temp
// state dir, the library DB, env vars).
//
// STATE_DIR is always a fresh temp dir, whatever the calling shell exports.
// Most files set their own before importing the controller, but one that does
// not falls through config.ts to the repo-local state/ — which on a host
// running the station is the live state root, and the Navidrome migration
// writes there on import. Overriding rather than defaulting means an exported
// STATE_DIR pointing at a real station cannot leak in either.

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2]; // optional substring filter

const files = readdirSync(scriptsDir)
  .filter((f) => f.endsWith('.test.ts'))
  .filter((f) => f !== 'run-tests.test.ts') // guard against self-inclusion if ever added
  .filter((f) => !filter || f.includes(filter))
  .sort();

if (files.length === 0) {
  console.error(filter ? `No test files match "${filter}".` : 'No *.test.ts files found.');
  process.exit(1);
}

console.log(`Running ${files.length} test file(s)${filter ? ` matching "${filter}"` : ''}:\n`);

// `--import tsx` loads .ts directly and is inherited by each subprocess. The
// spec reporter is forced so a non-TTY doesn't fall back to TAP.
const stateDir = mkdtempSync(join(tmpdir(), 'subwave-test-state-'));

const { status } = spawnSync(
  process.execPath,
  [
    '--import',
    'tsx',
    '--test',
    '--test-concurrency=1',
    '--test-reporter=spec',
    ...files.map((f) => join(scriptsDir, f)),
  ],
  { stdio: 'inherit', env: { ...process.env, STATE_DIR: stateDir } },
);

rmSync(stateDir, { recursive: true, force: true });
process.exit(status ?? 1);
