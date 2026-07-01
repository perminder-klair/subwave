// SqliteAdapter integration test — runs the shared LibraryDbAdapter contract
// (scripts/adapter-contract.ts) against the DEFAULT better-sqlite3 +
// sqlite-vec backend, in a throwaway temp STATE_DIR. Always runs (no external
// services), so `npm test` guards the default path against regressions from
// backend work — the same assertions run against Postgres in
// scripts/postgres-adapter.test.ts, pinning both backends to identical
// semantics.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// STATE_DIR is read at config.js import time, so it must be set before any
// src/ module loads — hence the dynamic imports below.
const stateDir = mkdtempSync(join(tmpdir(), 'subwave-sqlite-test-'));
process.env.STATE_DIR = stateDir;

// better-sqlite3 is a native addon; probe it directly so a Node version
// without a working binding (no prebuild + no local toolchain build, or a
// binding compiled for a different ABI) skips rather than fails — the
// containerised runtime (see Dockerfile) always has working bindings, so CI
// and the shipped image still run this.
try {
  const Database = (await import('better-sqlite3')).default;
  new Database(':memory:').close();
} catch (err: any) {
  console.log(
    `sqlite-adapter: better-sqlite3 native bindings unavailable on this Node — skipping\n  (${(err?.message || err).split('\n')[0]})`,
  );
  rmSync(stateDir, { recursive: true, force: true });
  process.exit(0);
}

const { SqliteAdapter } = await import('../src/music/db/sqlite.js');
const { runAdapterContract } = await import('./adapter-contract.js');

try {
  const failures = await runAdapterContract({
    label: 'sqlite',
    makeAdapter: () => new SqliteAdapter(),
    // No wipe needed — the temp STATE_DIR starts empty.
  });
  process.exit(failures === 0 ? 0 : 1);
} catch (err: any) {
  console.error('sqlite-adapter: fatal —', err?.message || err);
  process.exit(1);
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}
