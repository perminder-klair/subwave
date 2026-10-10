#!/usr/bin/env node
// Discovers and runs web's tests.
//
// WHY THIS EXISTS
// ---------------
// `web/` has had test files for a long time — under `tests/`, `components/`,
// `hooks/`, `lib/` and `scripts/` — with NO way to run them. `package.json` had no
// `test` script and CI never invoked any of them, so a green lint said nothing
// about them and the only way to execute one was to already know the file existed.
//
// That is how a guard for a real bug went unrun: `tts.gemini.libraryLanguage` was
// silently dropped on every save, and the regression test written for it would
// have caught it, but there was no command that would ever have run it.
//
// The discovery mirrors `controller/scripts/run-tests.ts`, which does the same
// job on the controller side. `tsx --test <directory>` is not usable here: it
// resolves the argument as a module import and fails with
// ERR_UNSUPPORTED_DIR_IMPORT, so the file list has to be built explicitly.
//
// Node's own runner is used, not a framework — these are `node:test` files.
//
//   npm test                 # everything
//   npm test -- gemini       # only paths matching "gemini"

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Roots searched for test files. Listed rather than globbed so a new test
 *  directory is a deliberate addition instead of an accidental omission —
 *  the previous state was the opposite: files nobody could reach. */
const ROOTS = ['tests', 'components', 'hooks', 'lib', 'scripts'];
const SKIP = new Set(['node_modules', '.next', '.git']);
const EXTS = ['.test.ts', '.test.tsx', '.test.mjs'];

/** Errors a missing OPTIONAL root legitimately produces. `ENOENT` is the root
 *  simply not existing; `ENOTDIR` is a path component that is a file. Both mean
 *  "nothing here", and both are expected for a root that does not exist yet.
 *
 *  Everything else is a real failure and is rethrown. A blanket `catch {}` treats
 *  an EACCES or an EIO as an empty directory, so a permissions problem or a
 *  corrupted subtree would silently REDUCE COVERAGE while the remaining tests
 *  still passed green — the runner reporting success over tests it never ran.
 *  That is the same failure shape as an assertion that cannot fail: it looks
 *  like coverage and is not. */
const ABSENT_ROOT = new Set(['ENOENT', 'ENOTDIR']);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (err) {
    if (!ABSENT_ROOT.has(err.code)) throw err;
    return out;
  }
  for (const name of entries) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTS.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

const filter = process.argv[2];
const files = ROOTS
  .flatMap((r) => walk(join(webRoot, r)))
  .filter((f) => !filter || relative(webRoot, f).includes(filter))
  .sort();

if (!files.length) {
  console.error(filter
    ? `no web test files match ${JSON.stringify(filter)}`
    : 'no web test files found');
  process.exit(1);
}

console.log(`web: ${files.length} test file(s)${filter ? ` matching ${JSON.stringify(filter)}` : ''}`);
const tsx = join(webRoot, 'node_modules', '.bin', 'tsx');
const res = spawnSync(
  tsx,
  // `--test-concurrency=1` is PASSED, not merely described. It was previously a
  // COMMENT above a call that never passed it, and a comment asserting a
  // guarantee the code does not make is worse than no comment.
  //
  // The original comment justified it with `process.env` and module-level
  // caches. That justification is WRONG for this package and was checked rather
  // than assumed: node's runner gives each test FILE its own process (verified —
  // two files, two PIDs), so neither `process.env` nor module state is shared
  // between them. No current web test needs this flag; the controller's do,
  // because those share a temp state dir and a library DB on disk.
  //
  // It is passed anyway, for two honest reasons: the filesystem is still shared
  // (every file runs with cwd at the web root, so a future test writing a fixture
  // or temp path can collide), and serial execution keeps output deterministic
  // and matches the posture `CLAUDE.md` documents for both packages. If a web
  // test ever needs real parallelism, this is the line to revisit — with the
  // measurement above in hand rather than a guess.
  ['--test', '--test-concurrency=1', ...files],
  {
    cwd: webRoot,
    stdio: 'inherit',
    env: { ...process.env, TSX_TSCONFIG_PATH: join(webRoot, 'tsconfig.json') },
  },
);
process.exit(res.status ?? 1);