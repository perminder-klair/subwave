// Shim that folds the pure-stdlib Python suites into `npm test`'s *.test.ts
// auto-discovery, so they actually run with the rest of the suite instead of
// only when someone remembers `python3 scripts/<file>.py`. Each suite is
// lightweight and isolated from the analyzer runtime (no torch / demucs /
// librosa / audio). Two numerical suites use NumPy; when it is unavailable,
// this shim installs the pinned test-only wheel into a temporary directory, so
// a clean checkout's `npm test` is reproducible without modifying the user's
// Python environment. A box without python3 still skips cleanly (exit 0).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

const SUITES = [
  'analyzer_sidecar_contract_test.py', // typed missing-path response for URL fallback (#1331)
  'analyzer_embedding_test.py', // batched CLAP + embedding-only backfills (#1426)
  'idle_release_test.py', // idle model release + heavy clock (#1099/#1204)
  'vocal_gate_test.py', // vocal-stem gate thresholds (#1125)
  'test_chatterbox_chunk.py', // chatterbox chunk_text (#1130)
  'analyzer_noise_test.py', // decode-noise filter + capability loss (#1300)
  'analyzer_silence_test.py', // edge dead-air measurement (silence trim)
];

const probe = spawnSync('python3', ['--version'], { stdio: 'ignore' });
if (probe.error || probe.status !== 0) {
  console.log('skipped: python3 not on PATH');
  process.exit(0);
}

const NUMPY_VERSION = '2.5.2';
const pythonEnv = { ...process.env };
let depsDir: string | null = null;
const numpyProbe = spawnSync('python3', ['-c', 'import numpy'], { stdio: 'ignore' });
if (numpyProbe.status !== 0) {
  depsDir = mkdtempSync(join(tmpdir(), 'subwave-python-test-deps-'));
  console.log(`— installing test dependency numpy==${NUMPY_VERSION}`);
  const install = spawnSync(
    'python3',
    ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--target', depsDir, `numpy==${NUMPY_VERSION}`],
    { stdio: 'inherit' },
  );
  if (install.error || install.status !== 0) {
    console.error(`✗ could not install test dependency numpy==${NUMPY_VERSION}`);
    process.exit(1);
  }
  pythonEnv.PYTHONPATH = pythonEnv.PYTHONPATH ? `${depsDir}:${pythonEnv.PYTHONPATH}` : depsDir;
}

const failed: string[] = [];
try {
  for (const file of SUITES) {
    console.log(`— ${file}`);
    const { status } = spawnSync('python3', [join(scriptsDir, file)], { stdio: 'inherit', env: pythonEnv });
    if (status !== 0) failed.push(file);
  }
} finally {
  if (depsDir) rmSync(depsDir, { recursive: true, force: true });
}

if (failed.length > 0) {
  console.error(`✗ python suite(s) failed: ${failed.join(', ')}`);
  process.exit(1);
}
console.log('✓ analyzer-python.test.ts passed');
