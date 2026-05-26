# Audio-features tagger — design spec

> **SUPERSEDED 2026-05-26 by [embedding-propagated tagger](2026-05-26-embedding-propagated-tagger-design.md).**
>
> This approach (extract BPM+LUFS per track via ffmpeg/aubio inside the controller image, derive `energy` deterministically, enrich the LLM mood prompt with audio numbers) was implemented and smoke-tested against the live Navidrome on 2026-05-26. It worked but the **per-track network cost** (two parallel ffmpeg fetches per track, each pulling ~60s of audio from Navidrome) doesn't scale to large libraries.
>
> **Concrete cost comparison on a 50k-track library:**
>
> | Approach | LLM calls | Wall time | Per-track network cost |
> |---|---|---|---|
> | Today's brute-force batched (PR #157) | ~2,500 (batch=20) | ~28 h | 0 (metadata only) |
> | This (superseded) audio-features path | ~2,500 | ~36 h + ~360 GB pulled | 2 × 60s stream fetches per track |
> | Successor: embedding-propagated | ~150-250 | ~3-4 h | 1 small Navidrome metadata GET per track for enrichment |
>
> So this design was both *slower* and *more bandwidth-hungry* than today's brute-force; the audio grounding was a quality nice-to-have but didn't move the dominant constraint. The successor attacks LLM call *count* — text-embed every track once (free local, no audio fetch), LLM-tag a small seed set, propagate moods to the rest by KNN over the embedding space, spend extra LLM calls only on uncertain residuals.
>
> The text below is preserved as historical context for the design exploration. The implementation work was reverted; no code from this approach is on the branch.

**Status:** superseded
**Date:** 2026-05-26
**Branch context:** follow-up to PR #157 (`perf(controller): bulk tag library tracks in batches of 20`)
**Spec author:** Claude (brainstormed with operator)

## 1. Problem

Today's library tagger (`controller/src/music/tagger-core.ts`) classifies every track using only string metadata: `title | artist | album | year | genre`. The LLM has no audio signal, so:

1. **Energy is a guess.** `Snoop Dogg — Slid Off` is a slow, quiet track; the tagger reads "Snoop Dogg, Hip-Hop" and is biased toward `energetic/medium`. Verified in the bulk-tagger smoke test (60 tracks, batch=20): several visibly miscategorised energy values.
2. **Empty tags on sparse metadata.** Track titles like `13SZN (Intro)` or `12` provide nothing for the LLM to anchor on, so they come back as `(none) [medium]`.
3. **`energy` is not reproducible.** Two runs of the same track against the same model can produce different energy buckets. There is no way to detect or migrate stale energy tags.
4. **No grounding for moods.** Even when the LLM picks moods, it is anchoring on artist priors, not actual audio character. A 140-BPM track and an 80-BPM track by the same artist look identical to the prompt.

## 2. Goal

Add a lightweight, deterministic audio-analysis pass that runs once per unseen track during the library walk (and on `POST /library/retag`), feeding two numbers — BPM and integrated LUFS — into the existing batched tagger flow. The numbers are:

- Used to compute `energy` deterministically (no LLM involvement for that field).
- Included in the LLM prompt as additional grounding for mood selection.
- Persisted alongside the tags so future re-tagging passes can reuse them.

## 3. Non-goals

- **No CLAP / pre-trained audio embeddings.** Out of scope. Considered and rejected as overkill for the current 17-mood vocabulary.
- **No multimodal LLM with audio attachments.** Out of scope. Would break Ollama-default and kill batching.
- **No spectral features** (centroid, ZCR, dynamic range, key, vocal/instrumental ratio). BPM+LUFS is the agreed minimum that captures ~80% of the energy/mood-grounding win without librosa or any Python ML stack.
- **No new compose service.** The audio binaries live inside the existing `controller` image (matches the piper / kokoro precedent).
- **No persistent worker process.** `ffmpeg` and `aubiotempo` are CLI tools; spawn-and-exit per track is acceptable (~30ms spawn dwarfed by ~2-5s analysis).
- **No changes to track selection.** Picker, dj-agent, and `songsByMood` consume `moods.json` exactly as today.

## 4. Architecture

```
                           ┌──────────────────────────────────────────────────┐
                           │              controller container                │
                           │                                                  │
   tag-library.ts          │   for each batch of N unseen tracks:             │
   (one-shot CLI)          │     1. iterateAllSongs() → song metadata          │
                           │     2. audio-features.ts (NEW) per song:          │
   routes/library.ts       │          ├─ exec aubiotempo  → BPM               │
   POST /library/retag     │          └─ exec ffmpeg ebur128 → LUFS           │
                           │        Parallel within a batch.                  │
                           │     3. tagger-core.tagBatch(songs[, features])    │
                           │        LLM picks moods only; energy derived       │
                           │        deterministically from features.           │
                           │     4. library.set(id, { ...meta, moods,          │
                           │           energy, bpm, loudness_lufs,             │
                           │           taggerVersion: 2 })                     │
                           └──────────────────────────────────────────────────┘
                                       │ stream URL fetch (subsonic.getStreamUrl)
                                       ▼
                                  Navidrome (Subsonic API)
```

Load-bearing properties:

- **`audio-features.ts` is a peer of `subsonic.ts`, not a fork of `tagger-core.ts`.** It is feature-extraction-only and knows nothing about moods, the LLM, or the library cache.
- **`energy` leaves the LLM contract entirely.** It is only ever computed by `energyFromFeatures(bpm, lufs)`. When features are unavailable (binaries absent or per-track extraction failure), the record stores `energy: null`. The picker already tolerates null energy (`c.energy || null` in `picker.ts`), so this is a clean degradation. Legacy `taggerVersion: 1` records retain their LLM-derived energy untouched.
- **Existing batch-failure fallback chain stays intact.** Three independent failure surfaces:
  - Audio features fail → enrichment is skipped for that track; tagger-core uses today's metadata-only prompt and LLM-derived energy.
  - LLM batch call fails → existing per-track `tagOne()` replay, unchanged.
  - Both fail → track is recorded as `failed`, processing continues.
- **No persistent worker.** ffmpeg and aubiotempo are spawned per track via `execFile` (not `exec`, no shell, no injection on stream URLs). Each subprocess has a 60s timeout.

## 5. Components

### 5.1 New: `controller/src/music/audio-features.ts`

```ts
export interface AudioFeatures {
  bpm: number;             // integer, rounded
  loudness_lufs: number;   // one decimal
  durationSec: number;
}

export async function getFeatures(streamUrl: string): Promise<AudioFeatures>;
export function energyFromFeatures(bpm: number, lufs: number): 'low' | 'medium' | 'high';
export function isAvailable(): boolean;
```

- `getFeatures()` runs both shellouts in parallel, parses each output, throws on any non-zero exit, timeout, or implausible values (BPM outside `40..220`, LUFS outside `-40..0`).
- `energyFromFeatures()` is pure and exported so the admin debug UI can preview the bucketing curve:
  ```ts
  const tempoScore = bpm < 90 ? 0 : bpm < 130 ? 1 : 2;
  const loudScore  = lufs < -16 ? 0 : lufs < -10 ? 1 : 2;
  const total = tempoScore + loudScore;
  return total <= 1 ? 'low' : total <= 2 ? 'medium' : 'high';
  ```
  Thresholds may be tuned during the implementation PR; this is the starting point.
- `isAvailable()` is `existsSync('/usr/bin/aubiotempo') && existsSync('/usr/bin/ffmpeg')`. Used by the tagger to take the audio path or the metadata-only fallback.
- ffmpeg analyzes only the **first 60 seconds** of the stream (`-t 60 -af ebur128=peak=true -f null -`). Integrated LUFS converges well inside that window, and it caps wall-time on long tracks.

### 5.2 Modified: `controller/src/music/tagger-core.ts`

`TaggableSong` gains an optional `features?: AudioFeatures` field. `tagBatch` and `tagOne` signatures are unchanged (the new field flows through the song object).

Internal changes:

- `formatSong()` appends `| BPM: X | LUFS: Y.Y` when features are present; omits when absent. Same prompt template handles both paths.
- `TAGGER_SYSTEM` and `TAGGER_BATCH_SYSTEM` each gain a calibration paragraph:
  > "Each track row includes BPM (tempo in beats-per-minute) and LUFS (integrated loudness in dB; a normal mastering range is -16 to -6, where -6 is very loud and -20 is quiet). Use these to ground mood choices: high BPM with hot LUFS leans energetic/workout/driving; low BPM with quiet LUFS leans calm/reflective/rainy. Numbers describe how the track SOUNDS — do not let them override the genre/lyric signal when they conflict."
- The LLM schema **drops `energy`** for both `tagOne` and `tagBatch`. Both schemas become moods-only:
  ```ts
  export const TagSchema = z.object({ moods: z.array(z.string()).default([]) });
  export const BatchTagSchema = z.object({ results: z.array(TagSchema) });
  ```
- `sanitizeTag` becomes `sanitizeMoods` and returns `string[]`. `tagOne` and `tagBatch` now return `string[]` / `string[][]` respectively (moods only).
- Callers compose `{ moods, energy }` themselves — moods from the LLM, energy from `energyFromFeatures` when features are present, `null` otherwise.

Backward compatibility note: the persisted `{ moods, energy }` shape in `moods.json` is unchanged. Only the LLM contract narrows. Existing `taggerVersion: 1` records keep their LLM-derived energy in place until manually re-tagged.

### 5.3 Modified: `controller/src/music/tag-library.ts`

`flushBuffer()` gains a pre-step that enriches each batch entry with features in parallel:

```ts
if (audioFeatures.isAvailable()) {
  await Promise.all(batch.map(async (song) => {
    try {
      song.features = await audioFeatures.getFeatures(
        subsonic.getStreamUrl(song.id),
      );
    } catch (err) {
      console.warn(`[tag] features failed ${song.id} (${song.title}): ${err.message}`);
    }
  }));
}
```

The per-track write becomes:

```ts
const moods = results ? results[i] : await tagOne(song);   // string[] from either path
const energy = song.features
  ? audioFeatures.energyFromFeatures(song.features.bpm, song.features.loudness_lufs)
  : null;
library.set(song.id, {
  title, artist, album, year, genre,
  moods,
  energy,
  bpm:           song.features?.bpm ?? null,
  loudness_lufs: song.features?.loudness_lufs ?? null,
  taggerVersion: 2,
});
```

`tagOne` is only invoked in the batch-failure fallback path; both paths return moods only. Energy is always derived from features or set to null. One source of truth per field.

CLI flags: existing `--limit N` and `--batch N` unchanged. Optional new `--skip-features` flag to force the metadata-only path for debugging / regression comparison.

### 5.4 Modified: `controller/src/routes/library.ts` (`POST /library/retag`)

Inline single-track retag from the admin UI. Reuses `getFeatures()` + `tagOne()`. Same try-then-fallback shape as the bulk path. No API contract change.

### 5.5 Modified: `controller/src/music/library.ts`

The persisted record gains two optional fields, with no consumer changes required:

```jsonc
"<subsonic_id>": {
  "title": "...",
  "artist": "...",
  "album": "...",
  "year": 2024,
  "genre": "Hip-Hop",
  "moods": ["energetic", "night", "driving"],
  "energy": "high",
  "bpm": 142,                  // NEW — null when features failed or unavailable
  "loudness_lufs": -8.2,       // NEW — null when features failed or unavailable
  "taggerVersion": 2,          // NEW — 1 = metadata-only (legacy), 2 = audio-aware
  "taggedAt": "2026-05-26T..."
}
```

`library.set()` already merges arbitrary fields, so no schema changes. `library.stats()` gains optional rollups (count of records with audio features, mean/median BPM) but this is cosmetic.

A new `library.needsRetag(record)` helper returns `true` when `taggerVersion < 2` — used by an optional `npm run tag -- --upgrade` mode (see §8) to re-tag legacy entries when features become available.

### 5.6 Modified: `docker/Dockerfile.controller`

Two binaries added to the existing apt block:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates wget tar \
    python3 python3-venv \
    espeak-ng libsndfile1 \
    ffmpeg aubio-tools \
    && rm -rf /var/lib/apt/lists/*
```

Adds ~120-150MB to the controller image. No new build args, no model downloads, no Python venv. Lighter than the existing kokoro venv (~750MB).

## 6. Data flow

### 6.1 Bulk tag pass — happy path

1. `tag-library.ts` iterates Navidrome songs, filters out already-tagged, buffers up to `BATCH_SIZE` unseen entries.
2. `flushBuffer()` checks `audioFeatures.isAvailable()`.
3. For each buffered entry, in parallel: fetch stream URL → spawn `ffmpeg` (LUFS) and `aubiotempo` (BPM) → parse output → attach `features` to the entry.
4. Call `tagger-core.tagBatch(buffered)`. LLM receives metadata + BPM + LUFS per row, returns `{ results: [{ moods }] }`.
5. For each entry, write `{ ...meta, moods: LLM, energy: deterministic, bpm, loudness_lufs, taggerVersion: 2 }` to `library`.
6. Flush every 25 saves (existing behaviour).

### 6.2 Bulk tag pass — feature failure for one track

- `getFeatures()` throws for track N (e.g., 500 from Navidrome, ffmpeg decode error).
- Track N is logged with a warning. `song.features` stays `undefined`.
- `tagBatch` still runs over the full batch (others have features, N does not). The LLM's prompt for N omits the BPM/LUFS trailer.
- Persisted record for N: `moods` from the batch, `energy: null`, `bpm: null`, `loudness_lufs: null`, `taggerVersion: 2`. The picker handles null energy as today.

### 6.3 Bulk tag pass — LLM batch failure

- Existing fallback chain (PR #157): batch throws → per-track `tagOne()` replay.
- Each replayed `tagOne()` receives the song with `features` attached (when present); the prompt includes the BPM/LUFS trailer for grounding moods.
- Energy is still derived from features (or null), never from `tagOne`. `tagOne` returns moods only.

### 6.4 Inline `/library/retag` — happy path

- Admin UI POSTs a single track ID.
- Route calls `getFeatures()` → `tagOne(song)` → composes `{ moods, energy, bpm, loudness_lufs, taggerVersion: 2 }` → writes to `library`.
- 200 OK with the new record.

### 6.5 `isAvailable() === false` — controller image without the binaries

- E.g., a custom build that strips ffmpeg or aubio-tools.
- Tagger logs `[tag] audio features unavailable, all energy will be null` once at startup.
- All new records get `moods` from the LLM, `energy: null`, `bpm: null`, `loudness_lufs: null`, `taggerVersion: 2`.
- The picker tolerates null energy. Pre-existing `taggerVersion: 1` records retain their LLM-derived energy. The signal is preserved for legacy data and degrades cleanly for new data.

## 7. Error handling

| Failure | Handler | User-visible outcome |
|---|---|---|
| `ffmpeg` not on PATH | `isAvailable()` returns false; tagger logs once at startup | Metadata-only path, no error |
| `aubiotempo` not on PATH | Same | Same |
| Navidrome 500 on stream URL | `getFeatures()` rejects; tagger logs warning per track | Track tagged metadata-only; `bpm/loudness_lufs: null` |
| ffmpeg decode error (corrupt file) | Same | Same |
| BPM outside `40..220` (aubio nonsense) | `getFeatures()` throws "implausible bpm: X" | Same |
| LUFS outside `-40..0` (silence or clipping) | Same | Same |
| ffmpeg/aubiotempo timeout (60s) | `execFile` rejects with `ETIMEDOUT` | Same |
| LLM batch fails (any reason) | Existing per-track `tagOne()` fallback fires | Each track tagged individually (with or without features) |
| Both feature extraction and LLM fail for a track | Track logged as `failed`, `failed++` counter increments; no record written | Same as today's single-track failure path |

No new metric or alert surfaces — the existing `[tag] FAIL` and `[tag] done in Xs. saved=Y failed=Z processed=W` lines cover observability.

## 8. Migration

Existing `moods.json` records have no `taggerVersion`, no `bpm`, no `loudness_lufs`. They're treated as `taggerVersion: 1` (legacy, metadata-only).

Two paths to upgrade:

1. **Passive.** Re-tag-on-touch: `POST /library/retag` from the admin UI always rewrites with `taggerVersion: 2`. Legacy entries stay legacy until manually re-tagged.
2. **Active.** New CLI mode: `npm run tag -- --upgrade [--limit N]` walks the existing `moods.json`, finds entries where `taggerVersion < 2`, and re-tags them in place. Uses the same batched flow as a fresh walk. This is opt-in — operators decide when to spend the LLM credits and CPU time.

The upgrade does not require any data migration script; the field-shape is additive and `library.set()` already accepts arbitrary record shapes.

## 9. Testing

### 9.1 Unit / pure

- `energyFromFeatures()` — table of `[bpm, lufs] → expected bucket`, including boundaries and the all-zero / clipping cases. Pure function, trivial to test.
- `formatSong()` — verify the prompt-row format with and without features. Snapshot is fine.

### 9.2 Integration (in the dev stack)

- **`audio-features.ts` against real Navidrome.** Pick 3 reference tracks of known character (a known-slow ballad, a known-fast dance track, a quiet ambient piece) and assert BPM/LUFS land in expected ranges. These become regression anchors.
- **Full bulk run with features enabled.** `tag-library.ts --limit 60 --batch 20` against the dev library; verify `bpm` and `loudness_lufs` are populated on ≥95% of records, `taggerVersion: 2` on all, no regression in moods quality vs. the PR #157 baseline (visual spot-check).
- **Feature failure injection.** Temporarily break `getFeatures()` (throw early); confirm the metadata-only fallback fires and `bpm/loudness_lufs` land as `null` with `taggerVersion: 2`.
- **`isAvailable() === false` simulation.** Override `isAvailable()` to return false; confirm a clean fallback to today's behaviour with no warnings beyond the one startup log line.

No new test framework. Existing `npm run lint` + manual integration runs in a worktree (matches PR #157's verification approach).

### 9.3 Acceptance criteria

- A bulk-tag run on 60 unseen tracks produces `bpm` and `loudness_lufs` on at least 57/60 (≥95%) records.
- `energy` distribution shifts visibly from today's LLM-driven spread toward a tempo+loudness-grounded one (operator eyeball check — verify a known-slow track lands `low`, a known-banger lands `high`).
- No regression in tag-library wall time of more than 2x vs. the metadata-only path on the same machine (today's 134s/60-tracks baseline → ≤270s acceptable).
- `npm run lint` passes (eslint + `tsc --noEmit`).
- The picker, dj-agent, and `songsByMood` consume the new fields without code changes (they read `moods` and `energy` only).

## 10. Open questions

- **Threshold tuning.** The `energyFromFeatures` curve is a starting point. The implementation PR should include a small calibration pass: sample 30 tracks the operator considers "obviously low/medium/high" by ear, check the bucket assignments, adjust thresholds if needed before merging.
- **Stream URL auth.** `subsonic.getStreamUrl(id)` returns an authenticated URL valid for the controller's Subsonic session. ffmpeg follows redirects and handles HTTPS, so this should "just work" — but worth confirming during implementation against the operator's actual Navidrome (https://music.klair.co) and not just localhost. Cloudflare-fronted origins occasionally 522 on ffmpeg the same way they did on liquidsoap (which is why `radio.liq` uses a custom `subhttp:` protocol that shells out to `curl`); if ffmpeg hits this, the fix is the same — pipe `curl` into `ffmpeg -i pipe:0`.
- **Concurrency cap.** Right now `flushBuffer()` would fan out 20 parallel ffmpeg+aubio pairs (40 subprocesses) per batch. On a quad-core homelab box this could spike load. An implementation-time call: add `pLimit(4)` around the inner loop, or just let it run and tune if it bites. Likely fine — both tools are short-lived and mostly I/O bound on the stream fetch.

## 11. Out of scope (revisit later)

- Audio-derived **mood** (CLAP zero-shot or similar). Future work; would replace the LLM step entirely for moods. Depends on the BPM+LUFS pass working first, since that establishes the audio-fetch + storage plumbing this design needs.
- Pre-filter for **intros/outros/skits/ambient transitions** by duration + title regex. Independent improvement; can land before or after this PR.
- Storing the **model name + prompt version** alongside `taggedAt` (a separate "tag provenance" memo). Useful, but orthogonal to audio features.
