// Fail the build on a Bun older than MINIMUM. The build passes
// --no-compile-autoload-dotenv and --no-compile-autoload-bunfig (#2203), and a
// Bun without those flags (1.3.2 and older) doesn't reject them: it ignores them
// and compiles a binary that loads the working directory's .env at boot, which
// brings #2196 back with no error. So the version is checked before compiling.
//
// Runs from package.json's `prebuild` (every build:* target) and from the
// workflows, which call `bun build` directly.
//
// Usage: node scripts/check-bun-version.mjs [bun-executable]
// Exit codes: 0 new enough, 1 too old, unreadable or not found.

import { spawnSync } from 'node:child_process';

const MINIMUM = [1, 3, 3];

const bun = process.argv[2] || 'bun';
const run = spawnSync(bun, ['--version'], { encoding: 'utf8' });
const reported = (run.stdout ?? '').trim();
const m = reported.match(/^(\d+)\.(\d+)\.(\d+)/);

if (run.error || run.status !== 0 || !m) {
  console.error(
    `check-bun-version: could not read the version of '${bun}'` +
      (run.error ? ` (${run.error.message})` : reported ? ` (got '${reported}')` : '') +
      `. Building the CLI needs Bun >= ${MINIMUM.join('.')}.`,
  );
  process.exit(1);
}

const have = m.slice(1, 4).map(Number);
const older = (() => {
  for (let i = 0; i < 3; i++) {
    if (have[i] !== MINIMUM[i]) return have[i] < MINIMUM[i];
  }
  return false;
})();

if (older) {
  console.error(
    `check-bun-version: Bun ${reported} is too old to build the CLI; it needs Bun >= ${MINIMUM.join('.')}.\n` +
      'Older Bun ignores --no-compile-autoload-dotenv and --no-compile-autoload-bunfig\n' +
      "without an error, and its binary would load the working directory's .env (#2203).\n" +
      'Upgrade with `bun upgrade`, or install the version CI pins in .github/workflows/publish-cli.yml.',
  );
  process.exit(1);
}

console.log(`check-bun-version: Bun ${reported} (>= ${MINIMUM.join('.')})`);
