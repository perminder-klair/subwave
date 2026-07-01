# PostgreSQL Backend for Sub/Wave

> **Postgres backend is fully operational as of Phase 2.** Setting `DATABASE_URL`
> routes all read and write operations through PostgreSQL + pgvector. The tagger,
> analyzer, acoustic pipeline, picker, genre recommendations, and coverage stats
> all use the same Postgres backend. SQLite remains the default when `DATABASE_URL`
> is unset.

Sub/Wave ships a SQLite + sqlite-vec library store by default. Setting
`DATABASE_URL` switches the write-path to a PostgreSQL + pgvector backend.
Both backends implement the same `LibraryDbAdapter` interface
(`controller/src/music/db/adapter.ts`).

---

## Requirements

- PostgreSQL 15+ (14 works but lacks some JSONB improvements).
- The `pgvector` extension. Install once per database:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

`open()` calls `CREATE EXTENSION IF NOT EXISTS vector` on every startup, so
this is handled automatically if the Postgres superuser / `CREATE` privilege
is available. In managed cloud databases (RDS, Cloud SQL) you may need to
enable the extension manually.

---

## Connection String Format

```
postgres://user:password@host:5432/dbname
```

Standard libpq connection string. Set in the environment or `.env`:

```bash
DATABASE_URL=postgres://subwave:secret@localhost:5432/subwave
```

Docker Compose example (add to the `controller` service):

```yaml
environment:
  DATABASE_URL: postgres://subwave:${POSTGRES_PASSWORD}@db:5432/subwave
```

### TLS / SSL

For remote or cloud-managed Postgres (RDS, Cloud SQL, Neon, Supabase, etc.) append
`?sslmode=require` to encrypt the connection:

```bash
DATABASE_URL=postgres://subwave:secret@db.example.com:5432/subwave?sslmode=require
```

Use `?sslmode=verify-full` for full certificate chain verification (recommended for
production). Local or Docker installs that don't expose Postgres externally typically
don't need `sslmode`. The `postgres` npm package passes the parameter through to the
underlying TLS handshake.

---

## Schema Migrations

Migrations run automatically on `open()`. The version table is:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (version INT PRIMARY KEY);
```

Migrations run 1 → 9, matching the 9-version SQLite `PRAGMA user_version`
sequence. Each migration is idempotent (`CREATE TABLE IF NOT EXISTS`,
`ALTER TABLE … ADD COLUMN IF NOT EXISTS`). You can run `open()` multiple
times safely; already-applied versions are skipped.

---

## JSON Column Types

All columns that SQLite stores as `TEXT` JSON blobs are stored as `JSONB` in
Postgres (`moods`, `lastfm_tags`, `structure_json`, `vocal_ranges_json`,
`pace_json`, `beats_json`, `bars_json`, `key_ranges_json`). The `postgres`
npm package automatically serialises JS arrays/objects to JSONB on write and
deserialises back on read, so application code never needs `JSON.parse()` for
rows returned by the Postgres adapter.

---

## Vector Storage

Text-embedding vectors live in `track_vectors(id TEXT PRIMARY KEY, embedding vector(N))`.
Audio (CLAP) vectors live in `track_audio_vectors(id TEXT PRIMARY KEY, embedding vector(512))`.

Dim-negotiation logic (adopt/reseed) mirrors SQLite:
- `adoptStoredDim: true` (live controller) — honours the dim already in
  `embedding_meta`, ignores `embeddingDim`. Prevents a model-name collision
  wiping a tagged index.
- `reseed: true` (tagger `--reseed`) — drops `track_vectors`, clears meta,
  rebuilds at the new dim.
- Mismatch without either flag → throws an actionable error with the
  `--reseed` hint.

KNN uses the cosine-distance operator `<=>` with an `HNSW` index
(`vector_cosine_ops`). Similarity is computed as `1 - distance`, matching
the `KnnHit.similarity` contract from the SQLite path.

HNSW (not IVFFlat) because the index is created on an empty table and filled
incrementally by the tagger: IVFFlat trains its list centroids at
`CREATE INDEX` time, so an index built before the data exists has untrained
lists and the default `probes = 1` silently drops rows from KNN results.
HNSW builds incrementally with no training step. Migration v10 converts
existing IVFFlat indexes automatically on the next `open()`.

### Vector format

The `postgres` package doesn't know about the `vector` type. Vectors are
passed as the string literal `[x,y,z,...]` and cast in SQL:

```sql
INSERT INTO track_vectors VALUES ($1, $2::vector)
SELECT id, 1-(embedding <=> $1::vector) AS similarity FROM track_vectors ...
SELECT embedding::text FROM track_vectors WHERE id = $1
```

On read, the `::text` cast returns the same `[x,y,z,...]` string, which
`PostgresAdapter` parses back to `Float32Array` locally.

---

## Backup and Restore

`backup()` and `restoreFromFile()` in `PostgresAdapter` are no-ops that log
a `console.warn`. Use `pg_dump` / `pg_restore` for Postgres backups:

```bash
# Backup
pg_dump "$DATABASE_URL" -Fc -f subwave.dump

# Restore
pg_restore -d "$DATABASE_URL" --clean subwave.dump
```

The backup/restore HTTP routes (`/admin/library/backup` and
`/admin/library/restore`) return a `501 Not Implemented`-equivalent log
message when Postgres is active; the files they produce or consume are
SQLite files that are meaningless to the Postgres backend.

---

## API Convention: Everything Is Async

`controller/src/music/library-db.ts` and `controller/src/music/library.ts`
export **async** functions that return Promises, regardless of the active
backend. Function names, parameters, and return types are identical to the
old synchronous API — only the calling convention changed (the Phase 2
cascade). The `SqliteAdapter` wraps its sync better-sqlite3 calls in
Promises, so both backends satisfy the same `LibraryDbAdapter` interface.

Two helpers deliberately stayed synchronous for hot-path use, with the data
hydrated up front instead of looked up per call:

- **Queue tracks** are hydrated once at `queue.push()` (`hydrateAcoustics`):
  bpm / key / introMs / loudness / energy / genre are merged onto the track
  object from the library, so `mixAnalysisFor`, `applyLoudnessGain`, and the
  intro-budget prompt helpers stay sync and read straight off the object.
- **`preferEnergyHydrated`** backfills `energy` for Subsonic-sourced
  candidate lists before the show-energy lean (`show-filter.ts`).

When adding a new caller: `await` every `library.*` / `db.*` call, or — if
the call site must stay synchronous — hydrate the fields you need at the
nearest async boundary, following the two patterns above.

---

## Performance Notes

- The `HNSW` index uses pgvector's defaults (`m = 16, ef_construction = 64`),
  which hold up well past 100k vectors. Run `ANALYZE track_vectors` after a
  bulk re-embed. If recall matters more than latency on very large libraries,
  raise `hnsw.ef_search` (default 40) per session.
- Rebuilding the HNSW index over a large populated library (the one-time v10
  migration, or a `--reseed`) is much faster with more
  `maintenance_work_mem` — Postgres logs a NOTICE when the graph no longer
  fits (default 64MB caps out around ~10k × 1536-d vectors). For a 100k-track
  library, `SET maintenance_work_mem = '2GB'` (or the equivalent server
  setting) before the migration is worth it; the build still completes fine
  without it, just slower.
- JSONB queries on `moods` and `vocal_ranges_json` benefit from GIN indexes.
  Add them if `filter()` becomes slow on large libraries:

  ```sql
  CREATE INDEX idx_tracks_moods      ON tracks USING GIN (moods);
  CREATE INDEX idx_tracks_vocal      ON tracks USING GIN (vocal_ranges_json);
  ```

- The `allTaggedSampled` stratified-sample query uses window functions;
  Postgres plans this efficiently for typical library sizes (< 1M rows).

---

## Migrating an Existing SQLite Library to Postgres

There is no automatic SQLite → Postgres migrator in this PR. The recommended
path is a fresh import:

1. Bring up Postgres with pgvector.
2. Set `DATABASE_URL` and restart the controller — `open()` creates the schema.
3. Re-run the tagging pipeline (`npm run tag`) and the analysis pass
   (`npm run analyze`). These re-populate `tracks`, `track_vectors`, and
   `track_audio_vectors` from Navidrome.

If you want to preserve existing tags without a re-tag run, a one-off
migration script (using `better-sqlite3` to read `state/library.db` and the
`postgres` package to write) is the cleanest option. The schema shapes are
identical modulo the JSON → JSONB column types and the vec0 → pgvector
vector tables.

---

## Testing

`scripts/postgres-adapter.test.ts` is an integration test that exercises the
full `LibraryDbAdapter` contract against a **real** Postgres + pgvector
instance: schema migration idempotency, track/tag/enrichment/analysis writes,
text + audio KNN ordering and seed exclusion, filter facets and pagination,
stats aggregation, prune, and the reseed / adoptStoredDim dim-negotiation
guards.

```bash
# Point it at a scratch database (the test wipes subwave tables — it refuses
# to run unless the db name contains "test", or SUBWAVE_PG_TEST_FORCE=1):
docker run -d --name pg-test -e POSTGRES_PASSWORD=test -p 5433:5432 pgvector/pgvector:pg16
docker exec pg-test psql -U postgres -c "CREATE DATABASE subwave_test"

TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/subwave_test npm run test:pg
```

It is part of `npm test` and **skips cleanly** (exit 0) when
`TEST_DATABASE_URL` is unset, so contributors without Postgres stay green.

---

## What Remains (Post-Phase 2)

Phase 2 completed the async cascade. The remaining work is optional cleanup
and polish, not blocking functionality:

- **Migration script** — No committed tool for moving an existing `library.db`
  to Postgres without re-tagging. The recommended path is a fresh `npm run tag`
  run. A one-off script using `better-sqlite3` + `postgres` to copy rows is
  straightforward but not included.
- **Backup/restore admin routes** — Return a `501`-equivalent when Postgres is
  active (documented above). Use `pg_dump` / `pg_restore` instead.
- **SQLite removal** — `better-sqlite3`, `sqlite-vec`, and `SqliteAdapter` can
  be removed once Postgres is the only target. Not done — SQLite remains the
  default for installs without `DATABASE_URL`.
