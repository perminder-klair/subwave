// PostgresAdapter integration test — runs the shared LibraryDbAdapter
// contract (scripts/adapter-contract.ts) against a REAL Postgres + pgvector
// instance. The same contract runs against SqliteAdapter in
// scripts/sqlite-adapter.test.ts, so the two backends can't drift.
//
// Run:  TEST_DATABASE_URL=postgres://user:pass@localhost:5432/subwave_test \
//         tsx scripts/postgres-adapter.test.ts
//
// SKIPS (exit 0) when TEST_DATABASE_URL is unset, so `npm test` stays green
// for contributors without a local Postgres. CI can point it at a pgvector
// service container (e.g. pgvector/pgvector:pg16).
//
// SAFETY: the test TRUNCATES every subwave table in the target database. It
// refuses to run unless the database name contains "test", or
// SUBWAVE_PG_TEST_FORCE=1 is set.

import { PostgresAdapter } from '../src/music/db/postgres.js';
import { runAdapterContract } from './adapter-contract.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.log('postgres-adapter: TEST_DATABASE_URL not set — skipping (set it to run against a real Postgres)');
  process.exit(0);
}

const dbName = (() => {
  try { return new URL(url).pathname.replace(/^\//, ''); } catch { return ''; }
})();
if (!/test/i.test(dbName) && process.env.SUBWAVE_PG_TEST_FORCE !== '1') {
  console.error(
    `postgres-adapter: refusing to run against database "${dbName}" — this test WIPES ` +
      `subwave tables. Use a database whose name contains "test", or set SUBWAVE_PG_TEST_FORCE=1.`,
  );
  process.exit(1);
}

runAdapterContract({
  label: 'postgres',
  makeAdapter: () => new PostgresAdapter(url),
  // Postgres reuses a long-lived database — clear rows so re-runs are
  // deterministic. (`sql` is the adapter's private pool; fine in a test.)
  wipe: async (adapter) => {
    const sql = (adapter as any).sql;
    await sql`TRUNCATE tracks, track_vectors, track_audio_vectors`;
    await sql`DELETE FROM embedding_meta`;
  },
})
  .then(failures => process.exit(failures === 0 ? 0 : 1))
  .catch(err => {
    console.error('postgres-adapter: fatal —', err?.message || err);
    process.exit(1);
  });
