// Test runner for router/: every scripts/*.test.ts, through node's built-in
// runner with tsx loaded. Dropping a file in is the whole registration step.
//
//   npm test              # everything
//   npm test -- loader    # files whose name contains "loader"
//
// Serial: the HTTP tests bind ports and point ROUTER_DIR at temp dirs.

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2];
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.ts') && (!filter || f.includes(filter)))
  .sort();
if (!files.length) {
  console.error(filter ? `No test files match "${filter}".` : 'No *.test.ts files found.');
  process.exit(1);
}
const { status } = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=spec', ...files.map((f) => join(dir, f))],
  { stdio: 'inherit' },
);
process.exit(status ?? 1);
