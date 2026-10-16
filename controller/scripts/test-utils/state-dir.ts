// Preloaded into every test process by scripts/run-tests.ts (`--import`).
//
// Gives each test FILE its own empty STATE_DIR before any test code runs.
// Without it, a file that never sets STATE_DIR resolves config.ts's default —
// the repo's own state/ dir, which is also what the dev compose mounts for a
// local station — so `npm test` wrote settings.json, library.db and the
// liquidsoap_*.txt handoffs there, and parallel runs would race on them.
//
// A file that sets process.env.STATE_DIR itself still wins: its assignment runs
// after this preload, before it imports anything that reads the variable. The
// directory is removed on exit by createTempDir.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir } from './temp-dir.js';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-test-state-'));
