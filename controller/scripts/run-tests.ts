// Test-suite runner for controller/. Auto-discovers every `scripts/*.test.ts`
// and runs each as its own tsx subprocess, so a test that signals failure by
// `process.exit(1)` OR by an `assert` throwing is caught the same way — the
// exit code is the universal contract. Runs all files (doesn't stop at the
// first failure) and prints a summary. Exits non-zero if any test failed.
//
//   npm test              # run the whole suite
//   npm test -- picker    # run only files whose name matches "picker"
//
// Adding a test is now just dropping a `*.test.ts` file in here — no
// package.json edit — which is what let mix-fx.test.ts silently fall out of
// the old hand-maintained `&&` chain.

import { readdirSync } from 'node:fs';
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

const failed: string[] = [];
for (const file of files) {
  console.log(`\x1b[1m▶ ${file}\x1b[0m`);
  const { status } = spawnSync('tsx', [join(scriptsDir, file)], { stdio: 'inherit' });
  if (status !== 0) failed.push(file);
  console.log('');
}

const passed = files.length - failed.length;
if (failed.length === 0) {
  console.log(`\x1b[32m✓ all ${passed} test file(s) passed\x1b[0m`);
} else {
  console.log(`\x1b[31m✗ ${failed.length}/${files.length} test file(s) failed:\x1b[0m`);
  for (const f of failed) console.log(`    - ${f}`);
  process.exit(1);
}
