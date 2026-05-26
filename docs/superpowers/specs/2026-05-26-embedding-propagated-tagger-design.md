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

- 50k-track library tagged end-to-end in ≤4 hours (vs. ~28h today)
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

- ~50,000 embeddings × 5ms = **4 min**, runs locally, free
- ~500 seed tracks at LLM batch=25 = **~20 calls × 60s ≈ 20 min**
- Propagation pass (HNSW KNN over 50k vectors) = **<1 min**
- ~3,000-5,000 uncertain residuals at batch=25 = **~120-200 calls × 60s ≈ 2-3 h**
- **Total: ~3-4 hours, ~150-250 LLM calls** (vs. 28h, 2,500 calls)

For a 5k-track library:

- Embeddings: ~25s
- Seed (200 tracks): ~10 min of LLM
- Propagation: <5s
- Uncertain residuals: ~5 min
- **Total: ~15-20 min**

## 4. Non-goals

- **No audio decoding.** Throwing out the audio-features approach entirely. We never fetch the actual audio bytes — embeddings are over text metadata only.
- **No new compose service.** Embedding runs through the existing AI SDK provider stack; HNSW index runs in-process via `hnswlib-node`.
- **No replacement of the picker contract.** `library.songsByMood(mood)` returns the same shape as today. The embedding index is invisible to consumers.
- **No mandatory cloud dependency.** Ollama-local users (the homelab default) need zero new credentials — `nomic-embed-text` is a free local model.
- **No re-tag of existing tracks.** The 66 tracks already tagged on this branch (and any other v1 entries in `moods.json`) are preserved and become anchor seeds.
- **No Last.fm tag integration / lyric integration / operator-playlist ground-truth integration.** All worthwhile, all separate future PRs. Each layer is independent and additive. This spec ships the embedding propagation core; later PRs layer those signals on top.

## 5. Architecture

```
   ┌──────────────────────────────────────────────────────────────────┐
   │                    controller container                          │
   │                                                                  │
   │   npm run tag                                                    │
   │     │                                                            │
   │     ├─→ Phase 1: EMBED                                           │
   │     │     iterateAllSongs() → for each track:                     │
   │     │       text  = "Artist — Title · Album (Year) [Genre]"      │
   │     │       vec   = embed(text)            // local, ~5ms        │
   │     │       indexAdd(songId, vec)          // hnswlib add        │
   │     │                                                            │
   │     ├─→ Phase 2: SEED                                            │
   │     │     selectSeeds(N):                                         │
   │     │       priority = starred ∪ frequent ∪ playlist-mood-named   │
   │     │       fill remainder by k-means cluster centroids           │
   │     │     tagBatch(seeds) via existing LLM pipeline (PR #157)     │
   │     │     library.set(seedId, { moods, energy, source: 'llm' })  │
   │     │                                                            │
   │     ├─→ Phase 3: PROPAGATE                                       │
   │     │     for untagged in remaining:                              │
   │     │       neighbours = indexKnn(untagged, k=5)                  │
   │     │       moods, energy, confidence = voteMoods(neighbours)     │
   │     │       if confidence ≥ threshold:                            │
   │     │         library.set(untagged.id, { moods, energy,          │
   │     │                              source: 'propagated' })       │
   │     │       else: uncertain.push(untagged)                        │
   │     │                                                            │
   │     └─→ Phase 4: ACTIVE-LEARN (loop up to maxRounds)             │
   │           tagBatch(uncertain) via existing LLM pipeline           │
   │           seeds ∪= newly-tagged                                   │
   │           re-propagate; new uncertain set may emerge              │
   │                                                                  │
   │   state/embeddings.bin       ← hnswlib binary index               │
   │   state/embeddings-meta.json ← id ↔ ordinal mapping + dims/model  │
   │   state/moods.json           ← unchanged shape + 'source' field   │
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

- **The embedding step is the cheap one.** Local Ollama embeddings are CPU-only, no GPU needed, batch-friendly (`embedMany(texts[])` makes one HTTP call per batch). 50k tracks at batch=64 = ~780 embedding calls, each finishing in 200ms-1s.
- **HNSW index lives in-process.** `hnswlib-node` is a small native binding (~100KB). The index loads on controller boot if `state/embeddings.bin` exists; new embeddings `add()` to it incrementally with zero rebuild.
- **The LLM only sees tracks the embeddings flag as ambiguous.** Two ways a track is ambiguous: (a) no neighbour is close enough (top similarity < 0.5 — likely an outlier the seed set didn't cover), (b) neighbours disagree (no mood gets a strong majority). Both signals reliably mean "this track is in a sparsely-tagged region of the embedding space" — exactly where human-grade judgement matters.
- **The picker is untouched.** `library.songsByMood(mood)` reads the same shape as today; the new `source` field is metadata only.
- **The flow is incremental by construction.** Adding 100 new tracks to Navidrome next month → next `npm run tag` invocation sees them as untagged → embeds them (500ms) → KNN against existing 50k tagged tracks → propagates moods. Zero new LLM calls for the common case where new tracks are similar to existing ones.

## 6. Components

### 6.1 New: `controller/src/music/embeddings.ts`

Wraps the AI SDK `embedMany()` call. Provider tracks `settings.embedding.provider` (defaults to `settings.llm.provider` — no separate config required for the common case).

```ts
export async function embedTexts(texts: string[]): Promise<number[][]>;
export function embeddingDim(): number;     // 768 (nomic), 1024 (mxbai), 1536 (openai-small), etc.
export function isAvailable(): boolean;     // true if provider supports embeddings
export function formatTrackText(song): string;
//   → `${artist} — ${title} · ${album} (${year}) [${genre}]`
//   Single canonical format; reused across seed + propagation + future similarity queries.
```

Default embedding models per provider (resolved in `llm/provider.ts`):
- `ollama` → `nomic-embed-text` (768d, local)
- `openai` / `openai-compatible` → `text-embedding-3-small` (1536d, cheap)
- `google` → `text-embedding-004` (768d)
- `anthropic` → falls back to OpenAI embeddings (Anthropic has no first-party embedding API as of 2026-05); controller logs a warning and requires `OPENAI_API_KEY` for the embedding leg only
- `deepseek` / `openrouter` / `gateway` → whatever embedding model the operator names in `settings.embedding.model`; default falls back to `nomic-embed-text` via Ollama if available

### 6.2 New: `controller/src/music/vector-index.ts`

Wraps `hnswlib-node`. Owns the on-disk format. Single in-process singleton.

```ts
export async function load(): Promise<void>;      // restore from state/embeddings.bin
export async function save(): Promise<void>;       // persist current index
export function add(songId: string, vector: number[]): void;
export function knn(vector: number[], k: number): Array<{ songId: string; similarity: number }>;
export function knnById(songId: string, k: number): Array<{ songId: string; similarity: number }>;
export function has(songId: string): boolean;
export function size(): number;
export function reset(): void;                     // for --reseed
```

Storage shape:
- `state/embeddings.bin` — hnswlib native binary index (~150 MB for 50k @ 768d)
- `state/embeddings-meta.json` — `{ model: "nomic-embed-text", dim: 768, count: 49823, ids: ["abc",...,"xyz"] }`. The ids array is the ordinal → songId map; hnswlib uses integer ordinals internally.

Embedding model mismatch is fatal: if `state/embeddings-meta.json` says `nomic-embed-text` (768d) but settings now say `text-embedding-3-small` (1536d), the index is rejected on load and a friendly error tells the operator to `npm run tag -- --reseed`. (We don't auto-migrate because re-embedding 50k tracks is a several-minute operation the operator should opt into.)

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

Hybrid seed picker. Pure function over `iterateAllSongs()` + `subsonic.getStarred()` + `subsonic.getFrequentAlbums()` + `subsonic.getPlaylists()`.

```ts
export async function selectSeeds(
  totalSongs: number,
  embeddings: Map<string, number[]>,
  alreadyTagged: Set<string>,
  opts: { seedCount: number },
): Promise<string[]>;
```

Selection order:
1. Already-tagged tracks (v1 entries from prior runs) — they count toward the seed pool for free
2. Starred tracks — operator has explicitly flagged them
3. Tracks in playlists whose name contains a vocabulary mood word (`Late Night Drives`, `Rainy Sunday`)
4. Tracks from `getFrequentAlbums` — high-listen tracks deserve high-quality tags
5. K-means cluster centroids over embeddings — fill the remaining seed budget with maximally-diverse picks, ensuring obscure corners of the library aren't skipped

`seedCount` defaults to `max(200, ceil(sqrt(totalSongs)))` — 200 minimum for tiny libraries, scales with size for big ones.

### 6.5 Modified: `controller/src/music/tag-library.ts`

The bulk script becomes the orchestrator of phases 1-4. Today's batched-tagging code becomes the LLM step inside the seed and active-learn phases. Existing CLI flags (`--limit`, `--batch`) are preserved — they apply to the LLM batches. New flags:

- `--seeds N` — override seed count (default `max(200, ceil(sqrt(library)))`)
- `--no-propagate` — only tag seeds, skip propagation (debug)
- `--reseed` — discard `state/embeddings.bin` and re-embed from scratch
- `--max-rounds N` — cap active-learning rounds (default 3)

### 6.6 Modified: `controller/src/music/library.ts`

The persisted record gains optional fields. No consumer changes required:

```jsonc
"<subsonic_id>": {
  "title": "...", "artist": "...", "album": "...",
  "year": 2024, "genre": "Hip-Hop",
  "moods": ["energetic", "night", "driving"],
  "energy": "high",
  "source": "llm" | "propagated" | "uncertain-llm",   // NEW — provenance
  "confidence": 0.82,                                   // NEW — null for source: 'llm'
  "taggerVersion": 3,                                   // NEW — 1=metadata-llm, 2=audio-llm (superseded), 3=embedding-propagated
  "taggedAt": "..."
}
```

`source: 'llm'` is a seed (a direct LLM call). `source: 'propagated'` is a KNN-derived tag. `source: 'uncertain-llm'` is an active-learning round LLM call. This provenance is useful for debugging quality regressions ("the bad moods are all from one cluster's seed → re-tag that seed").

### 6.7 New: `controller/src/routes/library.ts` — `GET /library/similar/:id`

Bonus endpoint, near-zero implementation cost given the index. Returns `k` nearest neighbours by embedding similarity. Powers a future picker source ("similar to current track via library embeddings — completely independent of Last.fm").

### 6.8 Modified: `controller/src/llm/provider.ts`

Add `embedModel(id?)` resolver alongside the existing chat-model resolver, using the same provider registry pattern.

### 6.9 Modified: `controller/package.json`

Add one dependency: `hnswlib-node` (~100 KB, native binding to the HNSW C++ library). No Python, no model downloads, no new compose service.

### 6.10 New: `controller/src/settings.ts` — `settings.embedding`

```ts
{
  embedding: {
    enabled: true,                                // master switch
    provider: null,                               // null = follow settings.llm.provider
    model: null,                                  // null = sensible default per provider
    seedCount: null,                              // null = auto sqrt(library)
    knnNeighbours: 5,
    moodVoteThreshold: 0.6,
    confidenceThreshold: 0.6,
    maxActiveLearningRounds: 3,
  }
}
```

When `enabled: false`, `npm run tag` falls back to today's brute-force batched flow — useful as an escape hatch.

## 7. Data flow

### 7.1 First-ever run (cold library)

1. `npm run tag` starts; `library.load()` finds zero tagged tracks; `vector-index.load()` finds no `embeddings.bin`.
2. **Phase 1 (Embed):** iterate all songs from Navidrome in batches of 64; for each batch, call `embedMany(texts)`; add each `(songId, vector)` to the in-memory hnswlib index. Periodically `vector-index.save()` (every 1000 tracks) so crashes don't lose progress.
3. **Phase 2 (Seed):** `selectSeeds(N)` returns 200 ids; `tagBatch(seeds)` in batches of 25 via the existing PR #157 pipeline; `library.set(...)` each with `source: 'llm'`.
4. **Phase 3 (Propagate):** iterate untagged tracks; for each, `indexKnnById(id, 5)`, `vote(neighbours, library.get)`. If `confidence >= 0.6`, `library.set(...)` with `source: 'propagated'`. Else push to `uncertain[]`.
5. **Phase 4 (Active-learn):** for `round in 1..3`:
   - `tagBatch(uncertain)` via existing pipeline; mark each as `source: 'uncertain-llm'`.
   - Re-run phase 3 over still-untagged tracks. If new `uncertain[]` is small or stable, exit loop.
6. Save final index + moods.json. Log per-phase counts and timings.

### 7.2 Incremental run (library grew)

1. `vector-index.load()` restores existing index. `library.load()` restores existing tags.
2. Iterate Navidrome; for each track:
   - If `index.has(id)` and `library.has(id)`: skip (already known).
   - If `index.has(id)` but not `library.has(id)`: tag via phase 3 directly (KNN propagation).
   - If neither: embed (phase 1), then propagate (phase 3).
3. Same uncertain → LLM loop as cold run.

### 7.3 Embedding model swap (`--reseed`)

1. `vector-index.reset()` deletes the old index file.
2. Cold-run path from §7.1, but `library.load()` may surface existing v1/v2/v3 entries — those are preserved as seeds (their tags are still useful, even if the embedding model changes).

### 7.4 Embedding provider unavailable (e.g., Ollama down on a cloud-only operator)

1. `embeddings.isAvailable()` returns false at startup.
2. `npm run tag` logs `[tag] embeddings unavailable, falling back to brute-force LLM tagger` and runs today's PR #157 flow unchanged.
3. No partial-state corruption; embedding-aware tags would be written only when phase 1 completes successfully.

## 8. Error handling

| Failure | Handler | User-visible outcome |
|---|---|---|
| Embedding provider returns 500 on a batch | Retry once with 1s backoff; on second failure throw | Whole bulk run aborts cleanly; no partial corruption |
| Embedding model dimension mismatch on load | Reject index, demand `--reseed` | Friendly error, no auto-rebuild |
| `embedMany` returns fewer vectors than texts | Throw "embedding count mismatch" | Bulk run aborts cleanly |
| Single track's embedding produces NaN | Skip + log; track stays untagged this round | Picked up by next run or `--reseed` |
| LLM batch fails in seed/uncertain phase | Existing per-track `tagOne` fallback (PR #157) | Same as today; no new failure modes |
| Propagation vote produces empty moods AND null energy | Track marked uncertain → queued for LLM | Same as today's "metadata too thin to tag" |
| All neighbours of a track are themselves untagged | Track marked uncertain (`voting_neighbour_count == 0`) | LLM call in active-learning round; converges over rounds |
| hnswlib-node native build fails on operator's platform | `embeddings.isAvailable()` returns false | Falls back to today's brute-force tagger; warning logged |
| `state/embeddings.bin` corrupted | Load throws; rename to `.bin.corrupt`, log warning, run cold | One slow run; auto-recovers |

## 9. Migration

Existing `moods.json` entries on operators already running the controller:

- v1 (metadata-only, no `taggerVersion` field): preserved as-is. Embedded on first run of the new tagger; counted as seeds.
- v2 (the audio-features path implemented but reverted on this branch): does not exist on any operator's installation (was implemented in this PR but never released). N/A.
- v3 (this PR): new entries get the full `source` + `confidence` + `taggerVersion: 3` shape.

The 66 tracks already tagged on this branch from PR #157 testing → preserved, embedded, used as seeds. The deterministic energy values from this branch's audio-features run never reached this point since we reverted; everything is LLM-derived `{moods, energy}` from the PR #157 batched run.

## 10. Testing

### 10.1 Unit / pure

- `tag-propagator.vote()` — table of `[neighbours, getTags] → expected {moods, energy, confidence}` covering: unanimous agreement, split vote, all-untagged neighbours, tie-breaking, far-away neighbours.
- `embeddings.formatTrackText()` — snapshot tests for the canonical text format.
- `seed-selector.selectSeeds()` — with synthetic embedding inputs, verify diversity coverage (k-means produces seeds in distinct clusters).

### 10.2 Integration (dev stack against real Navidrome)

- **Phase 1 only:** `npm run tag -- --no-propagate --seeds 0` — embed all ~3k tracks in the operator's library; verify `state/embeddings.bin` lands at expected size, `vector-index.size()` matches; no LLM calls fired.
- **Phase 1+2:** `--no-propagate --seeds 50` — embed all, tag 50 seeds via LLM; verify seeds chosen from diverse genres/decades (not just one cluster); verify all 50 land in `moods.json` with `source: 'llm'`.
- **Full run:** `npm run tag` on the same library; verify majority of tracks come back `source: 'propagated'` with confidence > threshold; spot-check 10 tracks where propagation set non-trivial moods — do they match what a human listener would say?
- **Active-learning loop:** verify at least one round of uncertain-LLM fires for a fresh library; verify uncertain set shrinks across rounds.
- **Incremental:** run twice; verify second run embeds zero tracks, KNN-propagates only newly-added tracks (which on the operator's branch will be zero — synthetic test inserts a fake new track).
- **Fallback:** disable embeddings (`settings.embedding.enabled = false`); verify run falls back to PR #157 brute-force flow.

### 10.3 Acceptance criteria

- A bulk run against a real library of N tracks completes in `≤ (N / 600 hours)` wall-time (the 50k → 4h target).
- LLM call count is ≤ `sqrt(N) + N × 0.15` (seed + uncertain budget; 50k → ~7,725 max, target ~2,000).
- Spot-check sample of 20 propagated tracks: at least 16/20 produce moods a human evaluator (operator) considers reasonable. (The bar is "as good as today's metadata-only LLM" — this PR succeeds if propagation matches that bar at 10× lower cost.)
- `npm run lint` passes (eslint + `tsc --noEmit`).
- Existing tags are preserved; `library.songsByMood(mood)` returns identical results pre/post for the same input mood.
- Incremental run on an unchanged library completes in <30s (just iteration + load, no embedding, no LLM).

## 11. Open questions

- **Initial confidence threshold.** 0.6 is a guess; the right number is empirical. The implementation PR should include a small calibration pass: run with threshold 0.5/0.6/0.7, count LLM calls + spot-check quality at each, pick the elbow.
- **Cluster count for k-means seeding.** `sqrt(N)` is a rule of thumb; for very small libraries (<1k) the seed count floor of 200 means we're effectively brute-force tagging anyway, which is fine.
- **Embedding model upgrades.** When a better local embedding model arrives, do we auto-detect drift and offer a re-seed? Likely yes (compare `meta.json.model` to `settings.embedding.model`), but the trigger is a future PR.
- **Storage scaling.** 150MB for 50k tracks at 768d is fine; at 500k tracks (~1.5GB) it starts to matter. Out of scope for this PR but worth tracking. hnswlib supports mmap-loaded indexes if needed.

## 12. Out of scope (future)

These would extend the spec but are deliberately separate PRs:

- **Last.fm tag mapping.** Use `getArtistInfo2.tag[]` to map crowdsourced labels directly into the mood vocab — could deterministically tag ~70% of mainstream tracks with zero LLM calls. Layers on top of this design as an additional seed source.
- **Lyrics-enriched LLM prompts.** Use `getLyricsBySongId` when available to fatten the prompt for uncertain-LLM rounds. Improves the quality of the ~15% of tracks that still need LLM; doesn't change call count.
- **Operator playlist ground truth.** Tracks in playlists named after vocab moods (`Late Night Drives`) inherit those moods as labelled-by-operator. This spec already uses such playlists as seed *priorities*; ground-truth treatment goes further and overrides any propagated tag.
- **Similarity-based picker source.** `library.similarTo(songId, k)` is built into this spec (§6.7) but unused. A future PR adds it to `picker.buildCandidates` as an 8th source — completely Last.fm-independent track recommendation.
- **Per-track re-embedding on title/artist edits.** When the operator fixes a typo in Navidrome, the track's text changes → embedding goes stale. A small `POST /library/reembed/:id` would refresh just that vector.
