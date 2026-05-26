# Embedding-propagated library tagger — design spec

**Status:** draft (awaiting operator review)
**Date:** 2026-05-26
**Branch context:** follow-up to PR #157 (`perf(controller): bulk tag library tracks in batches of 20`)
**Spec author:** Claude (brainstormed with operator)
**Supersedes:** [audio-features tagger](2026-05-26-audio-features-tagger-design.md)

## 1. Problem

Today's tagger (post-PR #157) batches ~20 tracks per LLM call. That's a real improvement but the call count still scales linearly with library size. The operator's working library is ~3-5k tracks; a 50k-track library — common for serious listeners — needs:

- ~2,500 LLM calls at batch=20
- ~28 hours of wall time at observed cloud-model latency (~40s/call)
- ~$5-$50 of cloud-LLM cost depending on provider (free if Ollama-local, but still hours of CPU)
- Re-running for any vocab change repeats the full cost

Plus: when the operator adds 100 new tracks to Navidrome next month, today's tagger walks the whole library again to find them. No incremental story.

The earlier audio-features design (now [superseded](2026-05-26-audio-features-tagger-design.md)) attacked *per-call grounding* by adding BPM+LUFS context. Implemented; it works; but it's the wrong axis. Each track still costs an LLM call AND a ~60s audio fetch. For 50k tracks that's worse, not better.

## 2. Goal

Cut the LLM call count by an order of magnitude (10×+) for the bulk-tag pass on libraries of any size, while preserving or improving tag quality. Specifically:

- 50k-track library tagged end-to-end in ≤5 hours (vs. ~28h today)
- 5k-track library tagged in ≤30 min (vs. ~3h today)
- New tracks added incrementally cost milliseconds, not hours
- Tag quality matches or beats today's metadata-only LLM baseline on a held-out sample

## 3. Approach

**Semi-supervised label propagation via text embeddings.** Three phases:

1. **Embed** every track's metadata text — `"<artist> — <title> · <album> (<year>) [<genre>]"` — to a vector via a cheap, local embedding model. ~5ms per track on CPU with `nomic-embed-text` via Ollama.

2. **Seed** by LLM-tagging a small representative subset (~`sqrt(N)` tracks, capped at 500). Seed selection prioritises the operator's explicit signals (starred tracks, tracks in mood-named playlists, frequent-play tracks) and fills the rest by k-means clustering over the embedding space — so seeds cover the library's actual musical diversity, not just its most-common artists.

3. **Propagate** moods+energy to the remaining tracks via KNN over the embedding index (cosine similarity, HNSW ANN). For each untagged track, pull its 5 nearest tagged neighbours, vote on moods (mood passes if ≥3/5 neighbours have it), majority-vote energy. Tracks where neighbours disagree or no neighbour is close enough are flagged "uncertain" → queued for individual LLM tagging. Uncertain residuals are LLM-tagged in batches; new tags rejoin the seed pool; propagate again. Up to N rounds (default 3).

This is well-established ML technique (label propagation, active learning) — novel only in its application to mood tagging at this scale, where the alternative is brute-force per-track inference.

For a typical 50k-track library, expected outcome:

- Phase 0 (Navidrome enrichment, parallel pool of 8): **~20 min** (one-time; cached forever after, so incremental runs skip this)
- Phase 1 (50,000 embeddings × 5ms via `embedMany` batches of 64): **~4 min**, runs locally, free
- Phase 2 (~500 seed tracks at LLM batch=25): **~20 calls × 60s ≈ 20 min**
- Phase 3 (KNN propagation via sqlite-vec brute-force, ~40-80ms per query): **~30-70 min** (slower than HNSW would be, fast enough for a one-shot CLI)
- Phase 4 (3,000-5,000 uncertain residuals at LLM batch=25): **~120-200 calls × 60s ≈ 2-3 h**
- **Total: ~3-5 hours, ~150-250 LLM calls** (vs. today's ~28 h / ~2,500 calls)

For a 5k-track library:

- Enrichment: ~3-5 min
- Embeddings: ~25s
- Seed (200 tracks): ~10 min of LLM
- Propagation: ~10-30 s (linear in library size, fine at 5k)
- Uncertain residuals: ~5-10 min
- **Total: ~20-30 min**

If propagation wall time later becomes the dominant bottleneck on very large libraries, `sqlite-vec` has experimental HNSW support that's a drop-in swap (no schema change beyond a `vec0` option). See §11.

## 4. Non-goals

- **No audio decoding.** Throwing out the audio-features approach entirely. We never fetch the actual audio bytes — embeddings are over text metadata + Subsonic-sourced enrichments only.
- **No new compose service.** Embedding runs through the existing AI SDK provider stack; vector storage and KNN run in-process via SQLite + `sqlite-vec`.
- **No replacement of the picker contract.** `library.songsByMood(mood)` returns the same shape as today. The new SQLite backing is invisible to consumers.
- **No external database.** Stays single-host SQLite — no Postgres, Qdrant, Chroma, Weaviate, or anything that adds a container to compose. The operator's existing backup story (restic → B2 of `state/`) covers it for free.
- **No mandatory cloud dependency for embeddings.** Ollama-local users (the homelab default) need zero new credentials — `nomic-embed-text` is a free local model. Cloud LLM users (OpenAI, etc.) reuse their existing key for embeddings.
- **No re-tag of existing tracks.** The 66 tracks already tagged on this branch (and any other v1 entries in `moods.json`) are migrated into the SQLite store and become anchor seeds. Their moods/energy values are preserved.
- **In scope for v1 (was out of scope in prior draft):** Last.fm tags from `getArtistInfo2.tag[]` and lyrics from `getLyricsBySongId`, both folded into the embedding *text* for propagation. Without these, propagation just re-applies the artist prior and quality stalls. They are signals on the *embedding input*, not separate tagging paths.
- **Still out of scope (named for v2):** AcoustID/MusicBrainz canonical metadata, BPM/LUFS audio features as additional vector dimensions, operator-playlist mood ground-truth. See §12.

## 5. Architecture

```
   ┌──────────────────────────────────────────────────────────────────┐
   │                    controller container                          │
   │                                                                  │
   │   npm run tag                                                    │
   │     │                                                            │
   │     ├─→ Phase 0: ENRICH                                          │
   │     │     for each artist seen in iteration:                     │
   │     │       fetch getArtistInfo2(id) → cache .tag[]              │
   │     │     for each song:                                         │
   │     │       fetch getLyricsBySongId(id) → cache excerpt          │
   │     │     (both cached in tracks table; pulled lazily on misses)│
   │     │                                                            │
   │     ├─→ Phase 1: EMBED                                           │
   │     │     for each track:                                        │
   │     │       text = formatTrackText(song, lastfmTags, lyricExcerpt)│
   │     │       vec  = embed(text)             // local, ~5ms        │
   │     │       db.upsertVector(songId, vec)   // sqlite-vec INSERT  │
   │     │                                                            │
   │     ├─→ Phase 2: SEED                                            │
   │     │     selectSeeds(N):                                         │
   │     │       priority = starred ∪ frequent ∪ mood-named-playlists │
   │     │       stratify by (genre, decade) over half the budget     │
   │     │       fill remainder by k-means over embeddings            │
   │     │     tagBatch(seeds) via existing LLM pipeline (PR #157)     │
   │     │     db.upsertTags(id, moods, energy, source='llm', ...)    │
   │     │                                                            │
   │     ├─→ Phase 3: PROPAGATE                                       │
   │     │     for untagged in remaining:                              │
   │     │       neighbours = db.knn(songId, k=5)  -- vec_distance    │
   │     │       moods, energy, confidence = vote(neighbours)         │
   │     │       if confidence ≥ threshold:                            │
   │     │         db.upsertTags(id, ..., source='propagated')        │
   │     │       else: uncertain.push(untagged)                        │
   │     │                                                            │
   │     └─→ Phase 4: ACTIVE-LEARN (loop up to maxRounds)             │
   │           tagBatch(uncertain) via existing LLM pipeline           │
   │           db.upsertTags(id, ..., source='uncertain-llm')         │
   │           re-propagate; new uncertain set may emerge              │
   │                                                                  │
   │   state/library.db          ← SQLite (tracks + vectors + cache)  │
   │   state/library.db-wal      ← SQLite write-ahead log              │
   │   state/moods.json.archived ← one-time migration backup           │
   └──────────────────────────────────────────────────────────────────┘
                                    │
                                    │ embedMany() per batch
                                    ▼
                          AI SDK provider (Ollama by default)
                                    │
                                    ▼
                          nomic-embed-text (or cloud equivalent)
```

Load-bearing properties:

- **One file, one source of truth.** `state/library.db` is a single SQLite file (~200MB for 50k tracks: ~50MB tags + Last.fm/lyric cache, ~150MB vectors). Tags and embeddings are transactionally consistent — no two-file drift risk. Backs up cleanly via the existing `state/` → restic → B2 flow.
- **The embedding step is the cheap one.** Local Ollama embeddings are CPU-only, no GPU needed, batch-friendly (`embedMany(texts[])` makes one HTTP call per batch). 50k tracks at batch=64 = ~780 embedding calls, each finishing in 200ms-1s.
- **KNN is SQL.** `sqlite-vec` adds `vec_distance_cosine()` and a `vec0` virtual table; nearest-neighbour queries are a single `SELECT ... ORDER BY vec_distance_cosine(...) LIMIT 5`. Brute-force exact search, ~40-80ms per query at 50k×768d — fast enough for a one-shot CLI; the picker doesn't do vector queries in its hot path.
- **The LLM only sees tracks the embeddings flag as ambiguous.** Two ways a track is ambiguous: (a) no neighbour is close enough (top similarity < 0.5 — likely an outlier the seed set didn't cover), (b) neighbours disagree (no mood gets a strong majority). Both signals reliably mean "this track is in a sparsely-tagged region of the embedding space" — exactly where human-grade judgement matters.
- **The picker is untouched.** `library.songsByMood(mood)` returns the same shape as today; SQL replaces the in-memory loop but the JS-side contract is unchanged.
- **Embeddings are canonical data, not cache.** They're expensive to compute, deterministic given input text + model, and cheap to store (~150MB for 50k tracks at 768d). Treating them as cache would mean regenerating them every time something downstream tweaks — that's wrong. They live in SQLite alongside tags and get backed up the same way.
- **The flow is incremental by construction.** Adding 100 new tracks to Navidrome next month → next `npm run tag` invocation sees them as untagged → embeds them (500ms) → KNN against existing 50k tagged tracks → propagates moods. Zero new LLM calls for the common case where new tracks are similar to existing ones.

## 6. Components

### 6.1 New: `controller/src/music/embeddings.ts`

Wraps the AI SDK `embedMany()` call. Provider tracks `settings.embedding.provider` (defaults to `settings.llm.provider` — no separate config required for the common case).

```ts
export interface TrackEnrichment {
  lastfmTags?: string[];     // from Subsonic getArtistInfo2.tag[]
  lyricExcerpt?: string;     // first ~400 chars of lyrics if available
}

export async function embedTexts(texts: string[]): Promise<number[][]>;
export function embeddingDim(): number;     // 768 (nomic), 1024 (mxbai), 1536 (openai-small), etc.
export function isAvailable(): boolean;     // true if provider supports embeddings

export function formatTrackText(song: SongMeta, enrich?: TrackEnrichment): string;
//   Canonical text format used for all embeddings. Single function so seed + propagation +
//   future similarity queries all produce identical vectors for the same input.
//
//   Without enrichment:
//     "Snoop Dogg — Slid Off · Missionary (2024) [Hip-Hop]"
//
//   With enrichment (the v1 default when both signals exist):
//     "Snoop Dogg — Slid Off · Missionary (2024) [Hip-Hop]
//      Last.fm: chill, west-coast, smooth, late-night
//      Lyrics: I slid off, ain't been the same since the call dropped / late night drive, neon
//      reflections in the rain..."
//
//   Empty enrichment fields are omitted entirely (no "Last.fm: (none)" line). The format is
//   structured but plain — modern embedding models handle multi-line free text fine.
```

**Why enrichment matters and lives in v1.** The earlier draft kept this out of scope; review correctly flagged that without it, propagation just compresses the artist prior the metadata-only tagger already had. Last.fm tags are crowdsourced mood/style labels applied by real listeners — they're the strongest cheap signal we can put into an embedding text. Lyrics (when available) discriminate tracks within the same artist's catalogue ("Slid Off" vs. "Pop My Shit" by the same Snoop Dogg album have very different lyrical character).

**Enrichment fetch and caching.** Both signals are fetched lazily on first encounter and cached in the SQLite `tracks` table (columns `lastfm_tags JSON` and `lyric_excerpt TEXT`). Cache hits skip the Navidrome round-trip. Per artist, `getArtistInfo2` is called once; per song, `getLyricsBySongId` is called once. Missing data (artist not in Last.fm, no lyrics indexed) is fine — `formatTrackText` just omits the line.

Default embedding models per provider (resolved in `llm/provider.ts`):
- `ollama` → `nomic-embed-text` (768d, local)
- `openai` / `openai-compatible` → `text-embedding-3-small` (1536d, cheap)
- `google` → `text-embedding-004` (768d)
- `anthropic` → falls back to OpenAI embeddings (Anthropic has no first-party embedding API as of 2026-05); controller logs a warning and requires `OPENAI_API_KEY` for the embedding leg only
- `deepseek` / `openrouter` / `gateway` → whatever embedding model the operator names in `settings.embedding.model`; default falls back to `nomic-embed-text` via Ollama if available

### 6.2 New: `controller/src/music/library-db.ts`

Owns `state/library.db`. Thin wrapper around `better-sqlite3` with `sqlite-vec` loaded as a runtime extension. Single in-process singleton; opens once on controller boot.

```ts
// Opens / migrates / closes
export async function open(): Promise<void>;       // open + apply pending migrations
export async function close(): Promise<void>;
export function isAvailable(): boolean;            // sqlite-vec loaded + schema present

// Track CRUD (used by both server.ts at boot and tag-library.ts orchestrator)
export function getTrack(id: string): TrackRecord | null;
export function upsertTrackMeta(id: string, meta: TrackMeta): void;
export function upsertTrackTags(id: string, tags: TagWrite): void;
export function upsertTrackEnrichment(id: string, enrich: TrackEnrichment): void;
export function upsertTrackVector(id: string, vector: number[]): void;
export function hasVector(id: string): boolean;
export function hasTags(id: string): boolean;

// Bulk reads for the picker / admin UI (replace today's library.ts in-memory loops)
export function songsByMood(mood: string): TrackRecord[];
export function filter(opts: FilterOpts): { total: number; rows: TrackRecord[] };
export function stats(): LibraryStats;

// Vector queries (used by tag-propagator + future picker similarity source)
export function knnById(id: string, k: number): Array<{ id: string; similarity: number }>;
export function knnByVector(vec: number[], k: number): Array<{ id: string; similarity: number }>;

// Provenance
export function getEmbeddingMeta(): { model: string; dim: number; count: number } | null;
export function setEmbeddingMeta(model: string, dim: number): void;

// For --reseed
export function dropVectors(): void;
```

Schema (applied on first open; migrations live in `controller/src/music/library-db-migrations/`):

```sql
-- Plain track rows, one per Subsonic song id ever seen. Tag fields are nullable
-- while the track is in flight (just embedded, not yet propagated).
CREATE TABLE tracks (
  id              TEXT PRIMARY KEY,
  title           TEXT,
  artist          TEXT,
  album           TEXT,
  year            INTEGER,
  genre           TEXT,
  duration_sec    INTEGER,

  -- enrichment cache (lazy-fetched from Navidrome; reused across embeddings runs)
  lastfm_tags     JSON,
  lyric_excerpt   TEXT,
  enriched_at     TEXT,

  -- tags
  moods           JSON,
  energy          TEXT CHECK (energy IN ('low','medium','high') OR energy IS NULL),
  source          TEXT CHECK (source IN ('llm','propagated','uncertain-llm') OR source IS NULL),
  confidence      REAL,
  tagger_version  INTEGER,
  prompt_hash     TEXT,
  model           TEXT,
  tagged_at       TEXT
);
CREATE INDEX idx_tracks_artist ON tracks(artist);
CREATE INDEX idx_tracks_genre  ON tracks(genre);

-- sqlite-vec virtual table. `id` is the join key back into `tracks`.
CREATE VIRTUAL TABLE track_vectors USING vec0(
  id        TEXT PRIMARY KEY,
  embedding FLOAT[768]                    -- dimension fixed per embedding model
);

-- Single-row metadata about the embedding model in use.
CREATE TABLE embedding_meta (
  pk              INTEGER PRIMARY KEY CHECK (pk = 1),
  model           TEXT NOT NULL,
  dim             INTEGER NOT NULL,
  set_at          TEXT NOT NULL
);
```

A typical mood query becomes one line: `SELECT id, title, artist, album, year, genre, moods, energy FROM tracks WHERE EXISTS (SELECT 1 FROM json_each(moods) WHERE value = ?)`. The existing `library.filter()` multi-facet JS loop (~50 lines) collapses into a parameterised SQL query — that code gets deleted as part of this PR.

KNN by id is two clauses:
```sql
SELECT t.id, vec_distance_cosine(v.embedding, q.embedding) AS dist
FROM   track_vectors q
JOIN   track_vectors v ON v.id != q.id
JOIN   tracks t ON t.id = v.id
WHERE  q.id = ?
ORDER  BY dist ASC
LIMIT  ?;
```

The dim is fixed at the schema's `FLOAT[768]` for `nomic-embed-text`. If the operator switches to `text-embedding-3-small` (1536d), the dim mismatch is caught at `upsertTrackVector` time and the user is told to `npm run tag -- --reseed`, which calls `dropVectors()` (which `DROP TABLE track_vectors; CREATE VIRTUAL TABLE ...` with the new dim) and re-embeds from scratch. We don't auto-migrate because re-embedding 50k tracks is a several-minute operation the operator should opt into.

Connection mode: `better-sqlite3` in WAL journal mode, synchronous mode `NORMAL`. WAL gives concurrent reader + single writer, which matches our pattern (tagger writes, picker reads).

### 6.3 New: `controller/src/music/tag-propagator.ts`

The KNN voting logic. Pure functions, easy to unit-test.

```ts
export interface VoteResult {
  moods: string[];                          // moods voted ≥ threshold of neighbours
  energy: 'low'|'medium'|'high'|null;       // majority vote
  confidence: number;                       // 0..1; below threshold → uncertain
}

export function vote(
  neighbours: Array<{ songId: string; similarity: number }>,
  getTags: (id: string) => { moods: string[]; energy: string|null } | null,
  opts: { moodVoteThreshold: number; minTopSimilarity: number },
): VoteResult;
```

Voting rules:
- Drop neighbours whose tags don't exist (untagged neighbours don't vote — important for early-loop propagation where most are untagged)
- Per-mood: keep moods where ≥`moodVoteThreshold` (default 0.6 = 3/5) of voting neighbours have them
- Energy: majority of voting neighbours; tie → take the energy of the most-similar voting neighbour
- Confidence: `(top similarity) × (voting_neighbour_count / k)` — falls if neighbours are far away OR if most neighbours don't have tags

A track is "uncertain" iff `confidence < settings.embedding.confidenceThreshold` (default 0.6).

### 6.4 New: `controller/src/music/seed-selector.ts`

Hybrid seed picker. Pure function over `iterateAllSongs()` + `subsonic.getStarred()` + `subsonic.getFrequentAlbums()` + `subsonic.getPlaylists()` + the SQLite `tracks` table (for previously-tagged entries and per-track genre/year).

```ts
export async function selectSeeds(
  totalSongs: number,
  alreadyTagged: Set<string>,
  opts: { seedCount: number },
): Promise<string[]>;
```

Selection waterfall (each layer can only pick from tracks the previous layers didn't take):

1. **Already-tagged tracks** (v1 entries migrated from `moods.json`, or seeds from prior runs) — they count toward the seed pool for free, no LLM cost.
2. **Operator's explicit signals** — starred tracks + tracks in playlists whose name contains a vocabulary mood word (`Late Night Drives`, `Rainy Sunday`, `Workout Bangers`) + tracks from `getFrequentAlbums`. Capped at ~30% of `seedCount` so explicit signals don't crowd out coverage.
3. **Stratified-by-(genre, decade)** — bucket all remaining tracks by `(genre, decade)` (where `decade = floor(year/10)*10`); allocate the next ~35% of `seedCount` proportionally so every populated bucket gets ≥1 seed. This is what reviewer feedback called out as the missing piece — k-means alone clusters in *embedding space*, but the embedding model could leave rare-mood corners (`rainy`, `spiritual`) co-clustered with common neighbours. Stratifying by metadata buckets guarantees diversity along the axes the operator most cares about (you can't have a 50k library where reggae from the 90s is invisible to the seed picker).
4. **K-means over embeddings** — use the remaining ~35% to fill embedding-space gaps the metadata stratification missed. K = remaining budget; tag one track per cluster (the centroid's nearest member).

`seedCount` defaults to `max(200, ceil(sqrt(totalSongs)))` — 200 minimum for tiny libraries, scales with size for big ones. Operator can override via `--seeds N` or `settings.embedding.seedCount`.

The waterfall is deterministic given the same library state, which makes test verification straightforward (set seed=12345 for randomness inside k-means, run twice, expect identical seed set).

### 6.5 Modified: `controller/src/music/tag-library.ts`

The bulk script becomes the orchestrator of phases 0-4. Today's batched-tagging code becomes the LLM step inside the seed and active-learn phases. Existing CLI flags (`--limit`, `--batch`) are preserved — they apply to the LLM batches. New flags:

- `--seeds N` — override seed count (default `max(200, ceil(sqrt(library)))`)
- `--no-propagate` — only tag seeds, skip propagation (debug)
- `--reseed` — drop + rebuild the `track_vectors` table, re-embed from scratch (preserves existing tag rows)
- `--re-enrich` — null out `lastfm_tags` + `lyric_excerpt` columns and re-fetch from Navidrome (use when the operator updated Navidrome's Last.fm agent config)
- `--upgrade` — re-tag only rows whose `prompt_hash` or `model` doesn't match current settings (cheap way to refresh after prompt/vocab changes)
- `--max-rounds N` — cap active-learning rounds (default 3)
- `--skip-enrich` — embed using metadata-only text (debug; verifies enrichment is actually helping)

### 6.6 Modified: `controller/src/music/library.ts`

Now a thin facade over `library-db.ts`. The public surface (`load`, `get`, `set`, `has`, `songsByMood`, `filter`, `stats`) is preserved so existing callers (picker, dj-agent, scheduler, admin UI) need zero changes — only the backing store moves from JSON-in-memory to SQLite.

- `load()` → `library-db.open()` (no-op on subsequent calls)
- `save()` → no-op (SQLite writes are durable per statement)
- `get(id)` → `library-db.getTrack(id)`
- `set(id, data)` → `library-db.upsertTrackMeta + upsertTrackTags`
- `songsByMood(mood)` → `library-db.songsByMood(mood)` (now a SQL query, see §6.2)
- `filter(opts)` → `library-db.filter(opts)` (the ~50-line in-memory loop deleted)
- `stats()` → `library-db.stats()` (now a few SQL aggregates)

Per-track record shape returned by `getTrack` (mirrors the SQLite columns; what the rest of the codebase sees):

```jsonc
{
  "id":             "<subsonic_id>",
  "title":          "...",
  "artist":         "...",
  "album":          "...",
  "year":           2024,
  "genre":          "Hip-Hop",
  "durationSec":    187,

  // enrichment cache (lazy)
  "lastfmTags":     ["west-coast", "smooth", "chill"],
  "lyricExcerpt":   "I slid off, ain't been the same...",
  "enrichedAt":     "2026-05-26T...",

  // tags
  "moods":          ["energetic", "night", "driving"],
  "energy":         "high",
  "source":         "llm" | "propagated" | "uncertain-llm",
  "confidence":     0.82,           // null for source = 'llm'
  "taggerVersion":  3,              // 1 = metadata-llm legacy, 2 = audio-llm (superseded, no on-disk records), 3 = embedding-propagated
  "promptHash":     "sha256:...",   // hash of the system prompt + mood vocab at tagging time
  "model":          "ollama:glm-5.1:cloud",
  "taggedAt":       "..."
}
```

**`promptHash` + `model` matter.** Reviewer correctly flagged that versioning the pipeline alone isn't enough — when we tune the system prompt or swap models, v3 records become inconsistent with each other. Recording `(promptHash, model)` per tag lets the implementation PR add a `library-db.needsRetag(record)` query that finds records whose `(promptHash, model)` no longer matches the current settings, so `--upgrade` mode can re-tag exactly the stale ones. `promptHash` is computed once per tagger run as `sha256(TAGGER_SYSTEM + MOOD_VOCAB.join(','))` and recorded for every track tagged in that run.

`source: 'llm'` is a seed (direct LLM call). `source: 'propagated'` is a KNN-derived tag. `source: 'uncertain-llm'` is an active-learning round LLM call. This provenance is useful for debugging quality regressions ("the bad moods are all from `source = 'propagated'` with `confidence < 0.7` → tighten the threshold").

### 6.7 New: `controller/src/routes/library.ts` — `GET /library/similar/:id`

Bonus endpoint, near-zero implementation cost given the index. Returns `k` nearest neighbours by embedding similarity. Powers a future picker source ("similar to current track via library embeddings — completely independent of Last.fm").

### 6.8 Modified: `controller/src/llm/provider.ts`

Add `embedModel(id?)` resolver alongside the existing chat-model resolver, using the same provider registry pattern.

### 6.9 Modified: `controller/package.json`

Two dependencies added:

- `better-sqlite3` (~4 MB, widely-used native binding to SQLite; synchronous API; battle-tested)
- `sqlite-vec` (~1 MB, runtime-loaded C extension exposing `vec0` virtual tables + `vec_distance_cosine()`; maintained successor to `sqlite-vss`)

No Python, no model downloads, no new compose service. Both bindings build at `npm install` time and need standard C build tools (already present in `node:22-bookworm-slim`).

### 6.10 New: `controller/src/settings.ts` — `settings.embedding`

```ts
{
  embedding: {
    enabled: true,                                // master switch
    provider: null,                               // null = follow settings.llm.provider
    model: null,                                  // null = sensible default per provider
    seedCount: null,                              // null = auto max(200, ceil(sqrt(library)))
    knnNeighbours: 5,
    moodVoteThreshold: 0.6,
    confidenceThreshold: 0.6,
    maxActiveLearningRounds: 3,
    enrichment: {
      lastfmTags: true,                           // fetch + include getArtistInfo2 tags in embed text
      lyrics: true,                               // fetch + include lyric excerpt in embed text
    },
  }
}
```

When `enabled: false`, `npm run tag` falls back to today's brute-force batched flow — useful as an escape hatch. `enrichment.lastfmTags = false` or `enrichment.lyrics = false` selectively disables a signal source (useful if the operator's Navidrome doesn't have the Last.fm agent enabled, or the lyric provider is offline).

## 7. Data flow

### 7.0 First boot after this PR ships (one-shot migration)

When `state/library.db` is missing but `state/moods.json` exists, controller boot:

1. Opens / creates `state/library.db` and runs schema migrations (idempotent).
2. Reads `state/moods.json`, inserts every record into `tracks` with `tagger_version: 1`, null `prompt_hash`, null `model`, null `embedding`. Skips records that are already present (re-runnable).
3. Renames `state/moods.json` → `state/moods.json.archived.<timestamp>`. Operator can keep or delete; SQLite is now authoritative.
4. From this point on, all reads/writes go through `library-db.ts`. `moods.json` is no longer read.

Migration is one-shot and idempotent. A botched migration is easy to undo: stop the controller, delete `library.db`, rename `moods.json.archived.*` back to `moods.json`, restart.

### 7.1 First-ever run (cold library, post-migration)

1. `npm run tag` starts; `library-db.open()` connects; queries find zero `track_vectors` rows.
2. **Phase 0 (Enrich):** for each artist encountered, fetch `getArtistInfo2(id)`; cache `.tag[]` into `tracks.lastfm_tags`. For each song, fetch `getLyricsBySongId(id)` if available; cache first ~400 chars into `tracks.lyric_excerpt`. Both done lazily on misses; cached forever (until operator forces re-fetch via `--re-enrich`).
3. **Phase 1 (Embed):** iterate all songs from Navidrome in batches of 64; for each batch, `formatTrackText(song, {lastfmTags, lyricExcerpt})` → `embedMany(texts)`; `library-db.upsertTrackVector(id, vec)` per row. Commits happen per `embedMany` batch (transactional), so a crash mid-run resumes cleanly.
4. **Phase 2 (Seed):** `selectSeeds(N)` returns ~200 ids using the §6.4 waterfall; `tagBatch(seeds)` in batches of 25 via the existing PR #157 pipeline; `library-db.upsertTrackTags(id, {moods, energy, source: 'llm', promptHash, model})` each.
5. **Phase 3 (Propagate):** for each track without tags, `library-db.knnById(id, 5)` → `vote(neighbours, getTags)`. If `confidence >= 0.6`, `library-db.upsertTrackTags(id, {..., source: 'propagated', confidence})`. Else push to `uncertain[]`.
6. **Phase 4 (Active-learn):** for `round in 1..3`:
   - `tagBatch(uncertain)` via existing pipeline; `library-db.upsertTrackTags(id, {..., source: 'uncertain-llm'})`.
   - Re-run phase 3 over still-untagged tracks. If new `uncertain[]` is small or stable, exit loop.
7. Final stats logged. No explicit "save" — SQLite is durable per statement under WAL.

### 7.2 Incremental run (library grew)

1. `library-db.open()` (already open if the controller is the caller).
2. Iterate Navidrome; for each track:
   - If `hasVector(id) AND hasTags(id)`: skip (already known).
   - If `hasVector(id) AND NOT hasTags(id)`: tag via phase 3 directly (KNN propagation).
   - If neither: enrich (phase 0), embed (phase 1), then propagate (phase 3).
3. Same uncertain → LLM loop as cold run.

### 7.3 Embedding model swap (`--reseed`)

1. `library-db.dropVectors()` drops + recreates the `track_vectors` virtual table with the new dim.
2. Cold-run path from §7.1 (phases 0-4). Existing tag rows in `tracks` are preserved — their `moods`/`energy` are still usable as seeds even though the embedding model changed.

### 7.4 Embedding provider unavailable (e.g., Ollama down on a cloud-only operator)

1. `embeddings.isAvailable()` returns false at startup.
2. `npm run tag` logs `[tag] embeddings unavailable, falling back to brute-force LLM tagger` and runs today's PR #157 flow unchanged (writes go to the same `tracks` table, but with `source: 'llm'` and no `embedding`).
3. No partial-state corruption; the embedding propagation path simply doesn't run.

### 7.5 Prompt or vocab tuning (`--upgrade`)

1. Operator updates the system prompt or `SHOW_MOODS` array; restarts the controller. `promptHash` derived from the new strings differs from what's stored on existing rows.
2. `npm run tag -- --upgrade` queries `tracks WHERE prompt_hash != ? OR model != ?` for the current hash; re-tags only the stale rows via the normal pipeline. Embeddings are not touched (text input unchanged).

## 8. Error handling

| Failure | Handler | User-visible outcome |
|---|---|---|
| Embedding provider returns 500 on a batch | Retry once with 1s backoff; on second failure throw | Whole bulk run aborts cleanly; no partial corruption (SQLite WAL keeps committed work, in-flight transaction rolls back) |
| Embedding model dimension mismatch on upsert | Throw "vector dim N != schema dim M, run --reseed" | Friendly error, no auto-rebuild |
| `embedMany` returns fewer vectors than texts | Throw "embedding count mismatch" | Bulk run aborts cleanly |
| Single track's embedding produces NaN | Skip + log; track stays without `embedding` this run | Picked up by next run; can still be propagated *to* by KNN |
| LLM batch fails in seed/uncertain phase | Existing per-track `tagOne` fallback (PR #157) | Same as today; no new failure modes |
| Propagation vote produces empty moods AND null energy | Track marked uncertain → queued for LLM | Same as today's "metadata too thin to tag" |
| All neighbours of a track are themselves untagged | Track marked uncertain (`voting_neighbour_count == 0`) | LLM call in active-learning round; converges over rounds |
| `better-sqlite3` / `sqlite-vec` native build fails on operator's platform | `library-db.isAvailable()` returns false; controller refuses to start with a clear error | Operator runs `npm rebuild better-sqlite3` or files a bug; tagger is unusable until fixed |
| `state/library.db` corrupted | SQLite refuses to open; rename to `.db.corrupt.<ts>`, log error, controller falls back to read-only metadata from Navidrome | One bulk-tag run rebuilds the store from scratch |
| Migration from `moods.json` fails mid-way | SQLite transaction rolls back; `moods.json` stays in place untouched; controller logs error and refuses to start until operator intervenes | No data loss; operator can retry after fixing the underlying cause |
| Last.fm fetch fails for an artist | Cached `lastfm_tags` stays null; embed text omits the line; logged once per artist | Track still gets embedded; tag quality slightly weaker for that artist |
| Lyrics fetch fails for a song | Cached `lyric_excerpt` stays null; embed text omits the line | Same — track still embedded |

## 9. Migration

### 9.1 `moods.json` → `state/library.db` (one-shot, automatic on boot)

On first controller boot after this PR is deployed, `library-db.open()` detects:
- `state/library.db` does not exist → create it, apply schema migrations
- `state/moods.json` exists → run migration

Migration script (`controller/src/music/library-db-migrations/001-from-moods-json.ts`):

1. Open a SQLite transaction.
2. Stream-parse `moods.json` (one record at a time so a 50k-track file doesn't load into memory).
3. For each entry, `INSERT INTO tracks (id, title, artist, album, year, genre, moods, energy, tagger_version, tagged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`. `prompt_hash` and `model` are NULL (legacy entries — operator can `--upgrade` to refresh them later). `embedding` is not yet populated.
4. Commit.
5. Atomic rename `moods.json` → `moods.json.archived.<unix-ts>`.

On crash mid-migration, the SQLite transaction rolls back and `moods.json` stays in place; safe to retry. The operation is idempotent — re-running it on a partially-migrated `tracks` table is a no-op (`INSERT OR IGNORE`).

For the operator's actual library state: the 66 tracks already tagged on this branch from PR #157 testing → migrated as v1 entries with `prompt_hash = NULL` and `model = NULL`. They become anchor seeds for the first new tagger run. Their `moods` and `energy` values are preserved; no LLM cost to bring them forward.

### 9.2 Tagger version history

- **v1** (today, no `tagger_version` column): metadata-only LLM tagging. Migrated as `tagger_version = 1`, no embedding, no provenance.
- **v2** (audio-features path, see [superseded spec](2026-05-26-audio-features-tagger-design.md)): implemented and smoke-tested on this branch, reverted before release. Zero v2 entries exist anywhere. N/A.
- **v3** (this PR): embedding-propagated, full provenance, SQLite-backed.

Future tagger-version bumps (v4 = audio dims in vector, v5 = AcoustID-augmented) layer on top by extending the schema (additive migrations) and incrementing `tagger_version`.

## 10. Testing

### 10.1 Unit / pure

- `tag-propagator.vote()` — table of `[neighbours, getTags] → expected {moods, energy, confidence}` covering: unanimous agreement, split vote, all-untagged neighbours, tie-breaking, far-away neighbours.
- `embeddings.formatTrackText()` — snapshot tests for the canonical text format.
- `seed-selector.selectSeeds()` — with synthetic embedding inputs, verify diversity coverage (k-means produces seeds in distinct clusters).

### 10.2 Integration (dev stack against real Navidrome)

- **Migration only:** controller boot with existing `moods.json` and no `library.db` → verify all entries land in SQLite as `tagger_version = 1`, `moods.json.archived.<ts>` is created, controller starts cleanly.
- **Phase 0+1 only:** `npm run tag -- --no-propagate --seeds 0` — enrich + embed all ~3k tracks; verify `state/library.db` grows to expected size, `SELECT COUNT(*) FROM track_vectors` matches library size; no LLM calls fired.
- **Phase 0+1+2:** `--no-propagate --seeds 50` — enrich + embed all, tag 50 seeds via LLM; verify seeds chosen from diverse `(genre, decade)` buckets per §6.4 stratification; verify all 50 land in `tracks` with `source = 'llm'`, populated `prompt_hash` and `model`.
- **Full run:** `npm run tag` on the same library; verify majority of tracks come back `source = 'propagated'` with `confidence > 0.6`; spot-check 10 tracks where propagation set non-trivial moods — do they match what a human listener would say?
- **Active-learning loop:** verify at least one round of `source = 'uncertain-llm'` fires for a fresh library; verify uncertain set shrinks across rounds.
- **Incremental:** run twice; verify second run embeds zero tracks, KNN-propagates only newly-added tracks (synthetic test inserts a fake new track via direct SQL).
- **Reseed:** `npm run tag -- --reseed`; verify `track_vectors` is dropped and rebuilt; verify `tracks` rows (with their `moods`/`energy`) survive untouched and act as seeds.
- **Prompt upgrade:** modify `TAGGER_SYSTEM`; run `npm run tag -- --upgrade`; verify only rows with stale `prompt_hash` are re-tagged (count = full library), then run again immediately → verify no rows match (idempotent).
- **Fallback:** disable embeddings (`settings.embedding.enabled = false`); verify run falls back to PR #157 brute-force flow, writes still land in SQLite.
- **Enrichment toggles:** with `enrichment.lastfmTags = false`, verify no `getArtistInfo2` calls fire and the embed text omits the Last.fm line; same with lyrics.

### 10.3 Acceptance criteria

- A bulk run against a real library of N tracks completes in `≤ (N / 10000) hours` wall-time (the 50k → 5h target).
- LLM call count is ≤ `sqrt(N) + N × 0.15` (seed + uncertain budget; 50k → ~7,725 max, target ~2,000-5,000 in practice).
- Spot-check sample of 20 propagated tracks: at least 16/20 produce moods a human evaluator (operator) considers reasonable. (The bar is "as good as today's metadata-only LLM" — this PR succeeds if propagation matches that bar at 10× lower cost.)
- `npm run lint` passes (eslint + `tsc --noEmit`).
- Existing tags are preserved; `library.songsByMood(mood)` returns identical results pre/post for the same input mood.
- Incremental run on an unchanged library completes in <30s (just iteration + load, no embedding, no LLM).

## 11. Open questions

- **Initial confidence threshold.** 0.6 is a guess; the right number is empirical. The implementation PR should include a small calibration pass: run with threshold 0.5/0.6/0.7, count LLM calls + spot-check quality at each, pick the elbow.
- **Cluster count for k-means seeding.** `sqrt(N)` is a rule of thumb; for very small libraries (<1k) the seed count floor of 200 means we're effectively brute-force tagging anyway, which is fine.
- **Embedding model upgrades.** When a better local embedding model arrives, do we auto-detect drift and offer a re-seed? Likely yes (compare `embedding_meta.model` to `settings.embedding.model`), but the trigger is a future PR.
- **Storage scaling.** ~200MB for 50k tracks fits comfortably in `state/`. At 500k tracks (~2GB) it starts to matter; SQLite handles this fine but backup time grows. Out of scope for this PR.
- **`sqlite-vec` KNN performance ceiling.** Brute-force exact search is fine at 50k; at 200k+ it's ~300ms per query, which slows full propagation to multiple hours. `sqlite-vec` has experimental HNSW support; if/when stable, swap in with a one-line `vec0` table option. No schema change needed.

## 12. Out of scope (named for follow-up PRs)

These are not "vague future ideas" — they're concrete extensions that this spec deliberately defers, with the expectation that each becomes a focused follow-up PR. Listed in suggested implementation order:

### v3.1 — Operator playlist ground truth (smallest, highest immediate value)

Tracks in playlists named after vocab moods (`Late Night Drives`, `Rainy Sunday`) inherit those moods as `source = 'operator-playlist'`, overriding any propagated tag. This spec already uses such playlists as a seed *priority*; ground-truth treatment goes further. A few dozen lines in `seed-selector.ts` + a new `source` value.

### v3.2 — AcoustID / MusicBrainz canonical tags

`fpcalc` (Chromaprint) on each track produces a fingerprint → AcoustID API resolves to MusicBrainz recording id → editorial genre/mood/era tags pulled from MusicBrainz. For any track AcoustID resolves (most non-obscure releases), we get high-quality human-curated tags effectively for free. Adds: `fpcalc` apt package (~5MB), AcoustID API key (free, no auth header for low-volume use), new `tracks.acoustid_recording_id` column. Becomes a 6th seed source in §6.4 (between operator signals and stratified-by-bucket).

### v3.3 — Audio features (BPM/LUFS) as additional vector dimensions

Reviewer's clever idea: concatenate a 4-dim normalised audio vector (bpm_norm, lufs_norm, duration_norm, year_norm) onto the text embedding so KNN gets tempo/loudness signal. Requires the audio-decoding step we previously rejected — but if the operator has mounted their music library into the controller via `MUSIC_LIBRARY_PATH`, the existing `getLocalPath()` lets ffmpeg/aubio read from disk at ~1-2s/track instead of streaming over the network. For 50k tracks on a quad-core box that's ~1 hour, fully parallelisable, one-time. Adds the audio binaries (`ffmpeg`, `aubio-tools`) to the controller image and 4 columns to `tracks`. Schema: `track_vectors.embedding FLOAT[772]` instead of 768.

### v3.4 — Similarity-based picker source

`library-db.knnById(songId, k=10)` is already built into this spec (§6.2). A future PR adds it to `picker.buildCandidates` as an 8th source: "similar to current track via library embeddings — completely Last.fm-independent track recommendation." Zero new code in `library-db.ts`; just a new caller in `picker.ts`.

### v3.5 — Per-track re-embedding on title/artist edits

When the operator fixes a typo in Navidrome, the track's text changes → embedding goes stale. A small `POST /library/reembed/:id` route refreshes just that vector. Adds a route, no schema change.
