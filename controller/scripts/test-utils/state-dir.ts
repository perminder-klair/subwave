// Preloaded into every test process by scripts/run-tests.ts (`--import`) to give
// each test file its own empty STATE_DIR: layer 2 of the two that header explains.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STATE_DIR_PREFIX } from './stale-state-dirs.js';
import { createTempDir } from './temp-dir.js';

process.env.SUBWAVE_TEST_STATE_DIR_BEFORE_PRELOAD = process.env.STATE_DIR ?? '';
process.env.STATE_DIR = createTempDir(join(tmpdir(), STATE_DIR_PREFIX));
