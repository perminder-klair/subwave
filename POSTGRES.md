# PostgreSQL Backend for Sub/Wave

> **Scope — Phase 1 (this PR):** Postgres handles all **write-path** operations:
> tagging (`npm run tag`), acoustic analysis (`npm run analyze`), and embedding
> storage. The **live read-path** — the picker, genre recommendations, and
> coverage stats — still reads from SQLite via `library.ts`. Setting
> `DATABASE_URL` without completing the Phase 2 async cascade means the tagger
> writes to Postgres while the live controller reads a separate SQLite file.
> See the [Phase 2 roadmap](#phase-2-roadmap-full-read-path-migration) below.

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

KNN uses the cosine-distance operator `<=>` with an `ivfflat` index
(`vector_cosine_ops`). Similarity is computed as `1 - distance`, matching
the `KnnHit.similarity` contract from the SQLite path.

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

## Caller Migration: Sync → Async

### What changed

`controller/src/music/library-db.ts` previously exported **synchronous**
functions. It now exports **async** functions that return Promises,
regardless of the active backend (SQLite or Postgres). The function names,
parameters, and return types are identical — only the calling convention
changed.

### Files that need `await` added

Every file that imports `library-db.ts` and calls its exports synchronously
must have `await` added in front of each call. The imports themselves
require no changes (`import * as db from './library-db.js'` still works).

The affected files as of this PR are listed below, with example patterns:

| File | Pattern needing `await` |
|---|---|
| `controller/src/music/library.ts` | `db.getTrack(id)`, `db.hasTags(id)`, `db.songsByMood(m)`, `db.knnById(id,k)`, `db.filter({...})`, `db.stats()`, etc. |
| `controller/src/music/tag-library.ts` | `db.getTrack`, `db.upsertTrackMeta`, `db.upsertTrackTags`, `db.untaggedIds`, `db.staleTaggedIds`, `db.pruneMissingTracks`, etc. |
| `controller/src/music/analyze-library.ts` | `db.needsAnalysisIds`, `db.upsertTrackAnalysis`, `db.clearAnalysis`, `db.trackCount`, etc. |
| `controller/src/music/journey.ts` | `db.getTrack`, `db.knnById`, `db.knnAudioById` |
| `controller/src/music/analyze.ts` | `db.upsertTrackVector`, `db.hasVector` |
| `controller/src/music/library-coverage.ts` | `db.trackCount`, `db.analysedCount`, `db.vectorCount`, etc. |
| `controller/src/music/genre-suggest.ts` | `db.genreCentroids` |
| `controller/src/music/seed-selector.ts` | `db.trackIdsByGenreDecade`, `db.untaggedIds` |
| `controller/src/routes/library.ts` | `db.upsertTrackMeta`, `db.allTagged`, `db.allTaggedSampled`, `db.filter`, `db.getVector`, `db.getAudioVector` |
| `controller/src/routes/backup.ts` | `db.backup`, `db.isOpen` |

### Cascade to library.ts callers

`library.ts` exposes a higher-level sync API (`get()`, `has()`,
`songsByMood()`, `filter()`, `stats()`, `tracksLikeThis()`, etc.) that is
called **synchronously** by `picker.ts`, LLM tools, and route handlers. Once
`library.ts` adds `await` to its `db.*` calls (making those calls async),
its own exported functions must also become `async`. That cascades to
**all callers of `library.ts`**:

| File | Sync calls to library.ts that will need `await` |
|---|---|
| `controller/src/music/picker.ts` | `library.get()`, `library.songsByMood()`, `library.tracksLikeThis()`, `library.tracksLikeThisAudio()`, `library.tracksByAudioVector()`, `library.stats()` |
| `controller/src/routes/library.ts` | `library.filter()`, `library.stats()` |
| LLM tools (`controller/src/llm/`) | Various `library.*` calls |

This cascade is intentional: the SQLite backend was synchronous; the async
wrapper is the correct long-term API for both backends. The migration is
straightforward — all affected call sites are inside `async` functions
already; only `await` needs to be inserted.

### SQLite path during migration

While callers are being migrated, the **SQLite path remains functionally
correct**: the `SqliteAdapter` wraps every sync call in
`Promise.resolve(...)`, so awaited calls work exactly as they did
synchronously. The only breakage is in call sites that have NOT yet been
migrated to `await` — those receive `Promise` objects instead of values,
which will silently misbehave. **Prioritise migrating callers before
enabling `DATABASE_URL` in production.**

---

## Performance Notes

- The `ivfflat` index is created with `lists = 100`. For libraries larger
  than ~100,000 vectors, tune `lists` to `sqrt(row_count)` and run
  `ANALYZE track_vectors` after a bulk re-embed.
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

## Phase 2 Roadmap: Full Read-Path Migration

The cascade that makes the live picker, genre recommendations, and coverage
stats read from Postgres is intentionally deferred. It requires making
`library.ts` async, which ripples to all of its callers.

### Files to update in Phase 2

**`controller/src/music/library.ts`** — the main blocker.

Change the import from `'./library-db-core.js'` to `'./library-db.js'` and
add `await` to every `db.*` call. Then make all exported functions `async`:

| Function | `db.*` calls to await |
|---|---|
| `load()` | `db.open()`, `db.trackCount()`, `db.getEmbeddingMeta()` etc. |
| `reload()` | `db.close()`, then call `load()` |
| `get(id)` | `db.getTrack(id)` |
| `set(id, tags)` | `db.upsertTrackMeta()`, `db.upsertTrackTags()` |
| `has(id)` | `db.hasTags(id)` |
| `allTaggedIds()` | `db.allTaggedIds()` |
| `songsByMood(m)` | `db.songsByMood(m)` |
| `songsByEnergy(e)` | `db.songsByEnergy(e)` |
| `tracksLikeThis(id, k)` | `db.knnById(id, k)`, `db.getTrack()` |
| `tracksLikeThisAudio(id, k)` | `db.knnAudioById(id, k)`, `db.getTrack()` |
| `tracksByVector(vec, k)` | `db.knnByVector(vec, k)`, `db.getTrack()` |
| `tracksByAudioVector(vec, k)` | `db.knnByAudioVector(vec, k)`, `db.getTrack()` |
| `filter(opts)` | `db.filter(opts)` |
| `stats()` | `db.stats()` |

**`controller/src/music/journey.ts`** and
**`controller/src/music/genre-suggest.ts`** — same pattern: change import to
`library-db.js`, add `await`.

### Cascade to library.ts callers

Once `library.ts` exports become `async`, these files need `await` added:

| File | Calls to update |
|---|---|
| `controller/src/music/picker.ts` | `library.get()`, `library.songsByMood()`, `library.tracksLikeThis()`, `library.tracksLikeThisAudio()`, `library.tracksByAudioVector()`, `library.stats()` |
| `controller/src/routes/library.ts` | `library.filter()`, `library.stats()`, `library.has()` |
| LLM tool files (`src/llm/`) | Various `library.*` calls |

All call sites are already inside `async` functions; only `await` needs to be
inserted. TypeScript will catch any missed sites as type errors once the
signatures become `Promise<T>`.

### After Phase 2

With the cascade complete, set `DATABASE_URL` and Postgres handles both reads
and writes. At that point `better-sqlite3` and `sqlite-vec` can be removed
from `package.json` and `SqliteAdapter` / `library-db-core.ts` deprecated.
