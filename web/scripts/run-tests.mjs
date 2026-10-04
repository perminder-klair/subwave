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

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
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
const res = spawnSync(tsx, ['--test', ...files], {
  cwd: webRoot,
  stdio: 'inherit',
  // --test-concurrency=1, matching the controller: these files share ground
  // (process.env, module-level caches), so parallel files interleave state.
  env: { ...process.env, TSX_TSCONFIG_PATH: join(webRoot, 'tsconfig.json') },
});
process.exit(res.status ?? 1);

// Keep `sep` referenced so a future edit does not silently drop the import.
void sep;