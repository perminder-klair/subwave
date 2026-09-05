// ANALYZE_MAX_BYTES is the download cap, and it is read on BOTH sides of the
// analysis split — `envInt` in src/music/analyzer.ts for the controller's own
// prefetch, `_env_int` in scripts/analyze_worker.py when the worker fetches the
// audio itself. The comment above each says they mirror one another, so a bad
// value has to land the same way on both or the two fetch paths run on
// different envelopes (#1549).
//
// The failure this pins: the TS side used to read the var with
// `parseInt(process.env.X || '…')`, so `ANALYZE_MAX_BYTES=ten` yielded NaN and
// EVERY comparison against it was false — the cap stopped applying and every
// download was flagged incomplete, which silently disables outro analysis
// library-wide. Meanwhile the Python side's bare `int()` RAISED on the same
// value, killing the download outright.
//
// Loopback HTTP only, no external network — same shape as
// analyzer-download-cleanup.test.ts. The malformed cap is set BEFORE the
// dynamic import because the module reads it once, at load.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

// The shared default both sides fall back to.
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;

// Well under the default cap, so a body this size is a COMPLETE download —
// unless a malformed cap has poisoned the comparison.
const BODY_BYTES = 2048;

const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(BODY_BYTES) });
  res.end(Buffer.alloc(BODY_BYTES, 0x41));
});

let analyzer: typeof import('../src/music/analyzer.js');
let tmpDir: string;

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'subwave-analyzer-max-bytes-'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  process.env.STATE_DIR = tmpDir;
  process.env.ANALYZE_MAX_BYTES = 'twelve';
  process.env.NAVIDROME_URL = `http://127.0.0.1:${address.port}`;
  process.env.NAVIDROME_USER = 'test';
  process.env.NAVIDROME_PASS = 'test';
  analyzer = await import('../src/music/analyzer.js');
});

after(async () => {
  analyzer?.shutdown();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  rmSync(tmpDir, { recursive: true, force: true });
});

test('a malformed cap still reports a short download as complete', async () => {
  const { path, complete } = await analyzer.downloadCapped('ok');
  assert.equal(existsSync(path), true);
  assert.equal(statSync(path).size, BODY_BYTES);
  assert.equal(
    complete,
    true,
    'a NaN cap made every download incomplete, which turns outro analysis off library-wide',
  );
});

// Every case the two sides must agree on: the value each ends up capping at.
const CASES: ReadonlyArray<{ raw: string; expected: number; why: string }> = [
  { raw: '4096', expected: 4096, why: 'a plain integer is honoured' },
  { raw: ' 4096 ', expected: 4096, why: 'surrounding whitespace is trimmed, not fatal' },
  { raw: '', expected: DEFAULT_MAX_BYTES, why: 'empty means unset — compose writes VAR=${VAR:-}' },
  { raw: 'twelve', expected: DEFAULT_MAX_BYTES, why: 'a non-numeric value falls back, never NaN and never a raise' },
  { raw: '12MB', expected: DEFAULT_MAX_BYTES, why: 'a unit suffix is a typo, not 12 bytes' },
  { raw: '4096.5', expected: DEFAULT_MAX_BYTES, why: 'a float is rejected outright rather than truncated' },
  { raw: '0', expected: DEFAULT_MAX_BYTES, why: 'a zero cap would truncate every download to nothing' },
  { raw: '-4096', expected: DEFAULT_MAX_BYTES, why: 'a negative cap is below the floor' },
  { raw: '1_000_000', expected: DEFAULT_MAX_BYTES, why: 'python int() takes underscores; the TS regex does not' },
];

test('the controller reads the cap with envInt semantics', async () => {
  const { envInt } = await import('../src/util/env.js');
  const saved = process.env.ANALYZE_MAX_BYTES;
  try {
    for (const { raw, expected, why } of CASES) {
      process.env.ANALYZE_MAX_BYTES = raw;
      assert.equal(envInt('ANALYZE_MAX_BYTES', DEFAULT_MAX_BYTES, { min: 1 }), expected, `${raw || '<empty>'}: ${why}`);
    }
  } finally {
    process.env.ANALYZE_MAX_BYTES = saved;
  }
});

test('the python worker resolves the same cap for the same value', () => {
  const probe = spawnSync('python3', ['--version'], { stdio: 'ignore' });
  if (probe.error || probe.status !== 0) {
    // Same posture as analyzer-python.test.ts: a box without python3 skips.
    console.log('skipped: python3 not on PATH');
    return;
  }
  for (const { raw, expected, why } of CASES) {
    const { status, stdout } = spawnSync(
      'python3',
      ['-c', 'import analyze_worker; print(analyze_worker.ANALYZE_MAX_BYTES)'],
      { cwd: scriptsDir, encoding: 'utf8', env: { ...process.env, ANALYZE_MAX_BYTES: raw } },
    );
    assert.equal(status, 0, `${raw || '<empty>'}: the worker must not raise on a malformed cap`);
    assert.equal(Number(stdout.trim()), expected, `${raw || '<empty>'}: ${why}`);
  }
});
