# Plan: true-audio (CLAP) embeddings + sonic journeys

## Why

SUB/WAVE already has a semantic similarity stack, but it works off **text**, not
sound. `embeddings.ts:formatTrackText` embeds `artist — title · album (year)
[genre]` plus Last.fm tags and a lyric excerpt; that vector lands in the
`track_vectors` vec0 table and drives the picker's `embedding-similar` source
(`picker.ts:126`) and the `tracksLikeThis` agent tool.

The consequence: two tracks that *sound* identical but carry thin or mismatched
metadata never come up as neighbours, and a track with no Last.fm coverage and
no lyrics embeds almost entirely on its title/artist string. That's the exact
weak spot CLAUDE.md already calls out — "especially valuable for regional /
non-Western catalogues where Last.fm coverage is thin."

A **CLAP audio embedding** is computed from the waveform itself, so it captures
timbre, instrumentation, production, and energy regardless of metadata. Adding
it as a *second* vector space (not a replacement) gives the picker a real
"sounds like this" signal and unlocks **sonic journeys** — interpolating through
the audio space to build a multi-track arc, which is far more radio-appropriate
than a static mood.

We are well-positioned: the heavy DSP path already exists. `analyze_worker.py`
already downloads a capped slice of each track and decodes it with librosa, and
`analyzer.ts` already runs it in two backends (tts-heavy sidecar + local venv)
with a one-ahead prefetch pipeline. We bolt a CLAP forward-pass onto that same
decode, and add a parallel vec0 table.

## Scope

- **Phase 1 — audio vectors end to end.** Worker emits a CLAP vector; it lands
  in a new `track_audio_vectors` table; the picker gains an `audio-similar`
  source and the agent gains an audio-KNN tool. This is independently shippable
  and immediately improves selection.
- **Phase 2 — sonic journeys.** Build on the Phase-1 vector space: interpolate
  between a start and a destination vibe and pick bridge tracks, wired into the
  existing dj-agent "run" `rankTarget` concept as a vector waypoint.

Phase 2 is worthless without Phase 1's vector space, so they're strictly
ordered. Everything below degrades to today's behaviour when the audio index is
empty (un-analysed library, or analysis backend absent).

---

## Phase 1 — audio embeddings

### 1. Worker: emit a CLAP vector (`controller/scripts/analyze_worker.py`)

- Add an optional model load alongside librosa. Use **LAION-CLAP** (open
  weights, MIT/Apache — no copyleft entanglement) exported to **ONNX** and run
  via `onnxruntime` (CPU), matching the lean-image philosophy; PyTorch is the
  fallback only if ONNX export proves fiddly. Embedding dim is **512**.
- Gate it on an env flag, default off: `ANALYZE_AUDIO_EMBEDDING=1` and
  `CLAP_MODEL_PATH=/path/to/clap.onnx`. When unset or the model is missing, the
  worker behaves exactly as today (bpm/key/intro only) and simply omits the
  embedding field — never a hard failure.
- CLAP expects **48 kHz** mono; the current decode is 22050 Hz. Load a second
  resample for CLAP (or load once at 48k and downsample for librosa). Keep the
  60s `ANALYZE_SECONDS` window — CLAP pools over the clip, 60s is plenty.
- Response shape gains one field:
  ```json
  {"id": "...", "ok": true, "bpm": 122.0, "key": "8A", "intro_ms": 8200,
   "confidence": 0.71, "audio_embedding": [/* 512 floats */]}
  ```
  Omit `audio_embedding` entirely when the model isn't loaded.

### 2. Sidecar: same model, behind the same `/analyze` (`docker/tts-heavy/`)

- `docker/Dockerfile.tts-heavy` already builds the analyzer venv — add
  `onnxruntime` + the CLAP deps there, and bake/download the ONNX model.
- `docker/tts-heavy/server.py` `/analyze` returns the new `audio_embedding`
  field when present. No new endpoint; `engines: ['analyze']` still advertises
  capability. (Optionally advertise `'analyze-embedding'` so the controller can
  distinguish a sidecar that can embed from one that can't — see step 4.)

### 3. Storage: a second vec0 table (`controller/src/music/library-db.ts`)

The text index lives in `track_vectors` at the embedding model's dim. Audio
vectors are a different space and a fixed dim, so they get their own table — do
**not** reuse `track_vectors`.

- New migration (`user_version` 2 → 3):
  ```sql
  CREATE VIRTUAL TABLE track_audio_vectors USING vec0(
    id TEXT PRIMARY KEY, embedding FLOAT[512] distance_metric=cosine);
  ```
  512 is fixed by the CLAP model, so no per-model dim negotiation /
  `embedding_meta` dance is needed; a one-row `audio_embedding_meta(model,
  dim, set_at)` is still worth adding for provenance + a future model swap.
- New DB functions mirroring the text ones:
  - `upsertTrackAudioVector(id, vec)` — delete+insert (vec0 upsert pattern).
  - `knnAudioById(id, k)` / `knnByAudioVector(vec, k)` — reuse the existing
    `knnByBuffer` logic against the audio table.
  - `hasAudioVector(id)`, `audioVectorCount()`, and an
    `unanalysedAudioIds(limit)` (LEFT JOIN where `track_audio_vectors.id IS
    NULL`) so the pass is resumable independently of bpm/key.
  - Extend `pruneMissingTracks` and `dropVectors`/reseed to cover the new table.
- `clearAnalysis()` / `--re-analyze` should also clear audio vectors.

### 4. Plumbing: carry the vector through the analyze pass

- `analyzer.ts` `AnalysisResult` gains `audioEmbedding: number[] | null`; both
  `localRequest` and `sidecarRequest` map the new field through (null when
  absent).
- `analyze.ts` `runAnalysisPass`: after `upsertTrackAnalysis`, if
  `a.audioEmbedding` is present, call `db.upsertTrackAudioVector(id, vec)`. The
  existing one-ahead prefetch pipeline is unchanged — we're just consuming one
  more field from the same response.
- Scope selection: keep `needsAnalysisIds` driving the bpm/key pass; the audio
  vector is written opportunistically whenever the response carries it. A track
  analysed before CLAP was enabled gets its vector on the next pass once
  `unanalysedAudioIds` (or an `ANALYSIS_VERSION` bump) re-targets it.

### 5. Expose it: `library.ts`

- `tracksLikeThisAudio(seed, k)` — same title-fallback shape as the existing
  `tracksLikeThis`, but over `knnAudioById`. Returns `[]` when the seed has no
  audio vector (callers fall through, exactly like the text path does today).
- `audioStats()` (or extend `stats()`) with `withAudioEmbedding` for
  `/admin/debug` and the library-coverage view.

### 6. Use it: the picker (`controller/src/music/picker.ts`)

- Add an `audio-similar` source next to `embedding-similar` (the block at
  `picker.ts:126`), capped like the others (`CAP_AUDIO_SIMILAR ≈ 4`):
  ```ts
  if (currentTrack?.id) {
    try {
      const knn = library.tracksLikeThisAudio(currentTrack.id, 15);
      add('audio-similar', sampleWithRecentFallback(knn, recentIds, CAP_AUDIO_SIMILAR));
    } catch {}
  }
  ```
- Keep `embedding-similar` (text) as well — the two are complementary: text
  catches "same scene/era/lyrical theme," audio catches "same sound." The LLM
  still curates the merged pool, so this only *deepens* candidate variety; a
  library with no audio vectors yet behaves identically to today.
- Surface `_similarity` on the candidate the LLM sees (we already pass `source`)
  so the pick reason can lean on it.

### Phase 1 acceptance

- Library with the sidecar/venv + CLAP enabled: `audioVectorCount()` climbs as
  the analyze pass runs; `/admin/debug` shows audio coverage.
- Picker logs show an `audio-similar=N` source in the pool line.
- A track with thin metadata but a clear sound (instrumental, non-English)
  surfaces sonic neighbours via `tracksLikeThisAudio` that `tracksLikeThis`
  misses.
- Backend absent / CLAP disabled / un-analysed library → pool line shows no
  `audio-similar` and behaviour is byte-for-byte today's.

---

## Phase 2 — sonic journeys

Goal: instead of always hugging the current track, let a dj-agent run drift
through the audio space toward a destination vibe over several tracks.

### 1. Interpolation helper (`controller/src/music/journey.ts`, new)

- `interpolate(startVec, endVec, n)` → `n` waypoint vectors, **spherical (slerp)**
  so the path stays on the embedding manifold rather than cutting through
  low-density middle.
- `buildJourney({ startId, endId | endMood, steps })`:
  - Resolve `startVec` (current track's audio vector) and `endVec` (a target
    track's vector, or the centroid of a mood/energy bucket via
    `songsByMood` → average their audio vectors).
  - For each waypoint, `knnByAudioVector(waypoint, k)` and pick the nearest
    candidate that respects the existing recency / artist-cap filters
    (`filterPickerCandidates`) and stays close to the *previous* pick (smooth
    step) while trending toward `endVec`.
  - Return an ordered list of track ids.

### 2. Wire into the existing run machinery (`broadcast/dj-agent.ts`)

- The dj-agent already carries a `rankTarget` (bpm/key) that the pool drifts
  toward. Extend the run state with an optional **vector waypoint**: at run
  start, compute the journey's waypoint sequence; each track event advances one
  step and passes that waypoint into the picker as the audio-KNN anchor (instead
  of, or alongside, the current track).
- Keep it gated and graceful: no audio vectors → no journey → fall back to the
  current bpm/key `rankTarget` behaviour. The journey is an *enhancement* of the
  run, never a new failure mode.

### 3. Optional operator surface

- A `/admin` control or a request verb ("take us from chill toward peak-time
  over the next few tracks") that seeds a journey. Lowest priority — the
  internal run-drift is the high-value part; explicit UI can follow.

### Phase 2 acceptance

- With audio vectors present, a run started with a destination produces an
  audibly graded sequence (each step measurably closer to `endVec` in cosine
  similarity) rather than random pool draws.
- No audio index → identical to today's run behaviour.

---

## Cross-cutting concerns

- **Optionality / image size.** CLAP weights are hundreds of MB to ~2 GB. They
  live **only** in the tts-heavy sidecar (or the operator's local analyzer
  venv), never the controller image — same boundary librosa already respects.
  Default off; opt in via `ANALYZE_AUDIO_EMBEDDING=1`.
- **Cost.** One forward pass per track on the 60s clip we already decode; this
  is a one-time backfill (resumable, like the mood tagger and bpm pass) plus the
  trickle of newly-added tracks. No per-pick cost — KNN is sub-millisecond in
  sqlite-vec.
- **Licensing.** Reimplement the idea against open CLAP weights (LAION-CLAP,
  MIT/Apache). No third-party application code is copied.
- **Versioning.** Reuse `ANALYSIS_VERSION` semantics: bump it (or add an
  independent `AUDIO_EMBEDDING_VERSION`) to re-target stale rows when the model
  changes.
- **No regression contract.** Every new source/tool returns `[]` on an empty
  audio index, and the migration is purely additive. An operator who never
  enables CLAP sees zero behavioural change.

## Suggested commit slices

1. DB: `track_audio_vectors` migration + `upsertTrackAudioVector` /
   `knnAudioById` / `knnByAudioVector` / `unanalysedAudioIds` + prune/reseed
   coverage (no callers yet).
2. Worker + sidecar: CLAP ONNX forward pass behind `ANALYZE_AUDIO_EMBEDDING`,
   `audio_embedding` in the response.
3. Pass + facade: `analyzer.ts` field passthrough, `analyze.ts` write,
   `library.ts` `tracksLikeThisAudio` + stats.
4. Picker: `audio-similar` source + debug coverage surface. **(Phase 1 ships.)**
5. `journey.ts` + dj-agent run waypoint. **(Phase 2.)**
