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
// STATE_DIR is always a fresh temp dir, whatever the calling shell exports.
// Most files set their own before importing the controller, but one that does
// not falls through config.ts to the repo-local state/ — which on a host
// running the station is the live state root, and the Navidrome migration
// writes there on import. Overriding rather than defaulting means an exported
// STATE_DIR pointing at a real station cannot leak in either.
//
// Concurrency defaults to 1, and parallel runs are opt-in. They are safe because
// nothing is shared between files: each runs in its own process (env vars and
// module state stay apart), and test-utils/state-dir.ts,
// preloaded below, gives each process its OWN temp STATE_DIR on top of the
// run's one. Without that preload every file would share the run's dir, and
// parallel files would race on its settings.json, library.db and handoffs.

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

// --jobs N / -j N / --jobs=N, else TEST_CONCURRENCY, else 1. 'auto' means one
// file per available CPU. The first remaining argument is the name filter.
function parseJobs(raw: string | undefined, source: string): number {
  if (raw === undefined || raw === '') return 1;
  if (raw === 'auto') return Math.max(1, availableParallelism());
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`${source} must be a positive integer or "auto", got "${raw}".`);
    process.exit(1);
  }
  return n;
}

const args = process.argv.slice(2);
let jobsArg: string | undefined;
const rest: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--jobs' || a === '-j') jobsArg = args[++i] ?? '';
  else if (a.startsWith('--jobs=')) jobsArg = a.slice('--jobs='.length);
  else rest.push(a);
}
const jobs = jobsArg !== undefined
  ? parseJobs(jobsArg, '--jobs')
  : parseJobs(process.env.TEST_CONCURRENCY, 'TEST_CONCURRENCY');
const filter = rest[0]; // optional substring filter

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

// `--import tsx` loads .ts directly and is inherited by each subprocess, as is
// the state-dir preload. The spec reporter is forced so a non-TTY doesn't fall
// back to TAP.
const stateDir = mkdtempSync(join(tmpdir(), 'subwave-test-state-'));

const { status } = spawnSync(
  process.execPath,
  [
    '--import',
    'tsx',
    '--import',
    join(scriptsDir, 'test-utils', 'state-dir.ts'),
    '--test',
    `--test-concurrency=${jobs}`,
    '--test-reporter=spec',
    ...files.map((f) => join(scriptsDir, f)),
  ],
  { stdio: 'inherit', env: { ...process.env, STATE_DIR: stateDir } },
);

rmSync(stateDir, { recursive: true, force: true });
process.exit(status ?? 1);
