// Test-suite runner for controller/. Auto-discovers every `scripts/*.test.ts`
// and hands the list to `node --test`, which runs each file as its own
// subprocess. Registration is just dropping the file in here.
//
//   npm test                     # run the whole suite, one file at a time
//   npm test -- picker           # run only files whose name matches "picker"
//   npm test -- --jobs 12        # run up to 12 files at once
//   npm test -- --jobs auto      # one file per available CPU
//   TEST_CONCURRENCY=8 npm test  # same as --jobs 8
//
// Two shapes coexist: a plain script reporting one pass/fail off its exit
// code, and the node:test shape reporting per assertion. Prefer node:test for
// anything new.
//
// STATE_DIR comes in two layers. This header is the one place they are
// explained; CLAUDE.md, test-utils/state-dir.ts, test-state-isolation.test.ts,
// package-scripts.test.ts, test-headers.test.ts and web/scripts/run-tests.mjs
// point here.
//
//   1. The run. This runner hands every file one fresh temp STATE_DIR,
//      overriding whatever the calling shell exports, so an exported STATE_DIR
//      pointing at a real station cannot leak in. Without it, a file that sets
//      none falls through config.ts to the repo-local state/, which on a host
//      running the station is the live state root, and the Navidrome migration
//      writes there on import.
//   2. The file. test-utils/state-dir.ts, preloaded into each test process,
//      replaces the run's dir with that process's own empty one, so files run
//      in parallel never race on one dir's settings.json, library.db or
//      liquidsoap_*.txt handoffs. A file that sets STATE_DIR itself still wins:
//      its assignment runs after the preload and before it imports config.
//
// Each layer hides the other's absence (without the preload every file shares
// the run's dir; without the run's dir the shell's STATE_DIR reaches the
// preload), so test-state-isolation.test.ts checks them apart. It needs two
// variables to do it: SUBWAVE_TEST_RUN_STATE_DIR is what this runner handed
// over, and SUBWAVE_TEST_STATE_DIR_BEFORE_PRELOAD is what the preload found in
// STATE_DIR before replacing it. They match only when layer 1 reached the file.
//
// Concurrency defaults to 1, and parallel runs are opt-in. Files never share a
// process (env vars and module state stay apart) or, given layer 2, a
// STATE_DIR, but they do share the host. A test that reserves a port must keep
// it bound (listen(0), never close it and bind the number again), and one that
// writes outside its STATE_DIR must use createTempDir. A test with a tight
// timing margin can still fail under `--jobs auto` on a busy host, so re-run a
// parallel-only failure alone before treating it as real.
//
// LRCLIB_URL is pinned the same way, over the shell's: the lyrics fallback is
// on by default, so any test that queues or airs a library track would
// otherwise send its title to lrclib.net. Port 9 has no listener, so such a
// lookup fails at once and backs off. A file that tests LRCLIB sets its own.

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { parseRunArgs, type RunArgs } from './test-utils/run-args.js';
import { STATE_DIR_PREFIX, sweepStaleStateDirs } from './test-utils/stale-state-dirs.js';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

let runArgs: RunArgs;
try {
  runArgs = parseRunArgs(process.argv.slice(2));
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
const { jobs, filter } = runArgs; // filter: optional substring

const files = readdirSync(scriptsDir)
  .filter((f) => f.endsWith('.test.ts'))
  .filter((f) => f !== 'run-tests.test.ts') // guard against self-inclusion if ever added
  .filter((f) => !filter || f.includes(filter))
  .sort();

if (files.length === 0) {
  console.error(filter ? `No test files match "${filter}".` : 'No *.test.ts files found.');
  process.exit(1);
}

console.log(`Running ${files.length} test file(s)${filter ? ` matching "${filter}"` : ''}${jobs > 1 ? `, ${jobs} at a time` : ''}:\n`);

// A killed run skips every process's exit cleanup, so its dirs are swept here,
// before this run makes its own (test-utils/stale-state-dirs.ts).
const swept = sweepStaleStateDirs(tmpdir());
if (swept.length > 0) console.log(`Removed ${swept.length} stale test STATE_DIR(s) left by a killed run.\n`);
const stateDir = mkdtempSync(join(tmpdir(), STATE_DIR_PREFIX));

// `--import tsx` loads .ts directly and is inherited by each subprocess, as is
// the state-dir preload. The spec reporter is forced so a non-TTY doesn't fall
// back to TAP.
const { status } = spawnSync(
  process.execPath,
  [
    '--import',
    'tsx',
    '--import',
    pathToFileURL(join(scriptsDir, 'test-utils', 'state-dir.ts')).href,
    '--test',
    `--test-concurrency=${jobs}`,
    '--test-reporter=spec',
    ...files.map((f) => join(scriptsDir, f)),
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, STATE_DIR: stateDir, SUBWAVE_TEST_RUN_STATE_DIR: stateDir, LRCLIB_URL: 'http://127.0.0.1:9' },
  },
);

rmSync(stateDir, { recursive: true, force: true });
process.exit(status ?? 1);
