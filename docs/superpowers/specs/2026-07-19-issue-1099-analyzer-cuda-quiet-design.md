# Issue #1099 — CUDA analyzer flavour + quiet-times analysis gate

**Date:** 2026-07-19
**Issue:** [#1099](https://github.com/perminder-klair/subwave/issues/1099) — Support Native GPU / CUDA Acceleration for subwave-analyzer-heavy (CLAP & Demucs)

## Problem

Operators with large libraries and an NVIDIA GPU run `ANALYZER_HEAVY=1` and find CLAP
embeddings + Demucs vocal separation saturating their CPU with 0% GPU utilisation. This is
by design today, not a bug:

- `docker/Dockerfile.analyzer` installs torch/torchaudio from the **CPU wheel index**
  (`--index-url https://download.pytorch.org/whl/cpu`, torch 2.6.0) — the wheels physically
  lack CUDA kernels, so no compose device reservation can enable GPU.
- The worker hardcodes CPU: `apply_model(..., device="cpu")`
  (`controller/scripts/analyze_worker.py:602`); the transformers CLAP model is never moved
  off the default CPU device; the ONNX path pins `CPUExecutionProvider`.

The issue also asks for a **"run at quiet times"** option: defer/pause the library analysis
while listeners are on air, resuming after the stream has been idle for N minutes. This
matters even on CPU-only installs — analysis competes with local LLM/TTS for the same
cores while the station is broadcasting.

Two independent deliverables, one PR (closes #1099):

- **Part A** — a published `subwave-analyzer-cuda` image flavour + device plumbing in the
  analyze worker + a compose GPU overlay.
- **Part B** — a listener-idle gate inside the analysis pass, driven by the existing
  Icecast listener-count infrastructure.

---

## Part A — CUDA analyzer flavour

### Approaches considered

1. **`.env` var switching only** (e.g. `ANALYZER_CUDA=1` mangling the image suffix like
   `ANALYZER_HEAVY` does). Rejected: compose variable substitution can't express the
   *nested* heavy-vs-cuda choice cleanly, and — decisive — a GPU device reservation
   **cannot be toggled from `.env`** in the base compose file at all. GPU wiring needs a
   compose-level block either way.
2. **Compose overlay file** (`docker-compose.analyzer-gpu.yml`) that overrides the analyzer image
   to `-cuda` AND adds the nvidia device reservation. **Chosen** — it's the standard
   compose idiom, keeps the three main compose files untouched, works over both
   `docker-compose.yml` and `docker-compose.byo.yml`, and puts image selection and GPU
   wiring in one place so they can't drift apart.
3. **CUDA in the existing heavy image.** Rejected: cu12 wheels + nvidia runtime libs add
   multiple GB; the lean/heavy split exists precisely to keep the default pulls small.
   CUDA is a third, opt-in flavour.

### Dockerfile changes (`docker/Dockerfile.analyzer`)

New build arg `WITH_CUDA=0`. Only meaningful alongside `WITH_CLAP=1`/`WITH_DEMUCS=1`:

- The torch index URL becomes a variable:
  `cpu` → `https://download.pytorch.org/whl/cpu` (unchanged default),
  `WITH_CUDA=1` → `https://download.pytorch.org/whl/cu124`.
  torch/torchaudio stay pinned at **2.6.0** (cu124 builds of 2.6.0 exist), preserving the
  repo-wide version pin shared with chatterbox in `Dockerfile.tts-heavy`. The
  "one CPU-torch repo-wide" invariant becomes "one torch *version* repo-wide"; the
  Dockerfile comment is updated to say so.
- Base image stays `python:3.11-slim-bookworm`. Modern cu124 wheels vendor the CUDA
  runtime via `nvidia-*-cu12` pip dependencies, so no `nvidia/cuda` base is needed. Host
  prerequisites are only the NVIDIA driver + nvidia-container-toolkit.
- **ONNX CLAP stays CPU** (`onnxruntime`, `CPUExecutionProvider`). The ONNX path is the
  optional `CLAP_MODEL_PATH` custom-export route; `onnxruntime-gpu` brings a fragile
  CUDA/cuDNN version matrix for a path almost nobody uses. The default transformers path
  is what gets CUDA. Noted as a possible follow-up.

### Worker changes (`controller/scripts/analyze_worker.py`)

Small, self-contained device plumbing:

- `resolve_device()`: env `ANALYZE_DEVICE` ∈ `auto` (default) | `cpu` | `cuda`.
  `auto` → `cuda` when `torch.cuda.is_available()` else `cpu`. `cuda` requested but
  unavailable → log a warning, fall back to `cpu` (never fail the pass over device
  selection). Log the resolved device + GPU name once at first model load.
- `ClapEmbedder` (transformers mode): `self.model.to(device)` after load; input tensors
  `.to(device)` in `embed()`; outputs already come back via `.cpu().numpy()`. Same for the
  lazy text tower (`text_model`) and its inputs. ONNX mode unchanged (CPU).
- `VocalActivityDetector`: `apply_model(self.model, wav.unsqueeze(0), device=device)` —
  demucs handles the model/input transfer internally; the output already lands via
  `.cpu().numpy()`.
- CPU-only installs see zero behaviour change: torch without CUDA support returns
  `is_available() == False`, `auto` resolves to `cpu`, and every call site passes the same
  device it effectively used before.

### Published image + CI (`.github/workflows/publish-images.yml`)

New matrix entry:

```
- image: subwave-analyzer-cuda
  dockerfile: docker/Dockerfile.analyzer
  platforms: linux/amd64
  build_args: |
    WITH_CLAP=1
    WITH_DEMUCS=1
    WITH_CUDA=1
```

amd64-only (CUDA wheels are amd64; matches the heavy precedent). The cuda flavour **is**
heavy + CUDA — there is no lean-cuda (librosa alone doesn't use torch, so a GPU lean image
would be pointless).

### Compose overlay (`docker-compose.analyzer-gpu.yml`, new file at repo root)

```yaml
# GPU overlay — run the CUDA analyzer flavour on an NVIDIA host:
#   docker compose -f docker-compose.yml -f docker-compose.analyzer-gpu.yml up -d
# Requires the NVIDIA driver + nvidia-container-toolkit on the host.
services:
  analyzer:
    image: ghcr.io/perminder-klair/subwave-analyzer-cuda:${SUBWAVE_VERSION:-latest}
    build:
      args:
        WITH_CLAP: 1
        WITH_DEMUCS: 1
        WITH_CUDA: 1
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
```

- Composes over the default file or the byo file identically. `ANALYZER_HEAVY` becomes
  irrelevant when the overlay is applied (the image is overridden outright); README notes
  this.
- `mem_limit` stays at the inherited `${ANALYZER_MEM_LIMIT:-6g}` — CUDA host-side
  allocations fit; operators can raise it in `.env` as today.
- `ANALYZE_DEVICE` is not set anywhere by default (`auto` in the worker). The overlay
  documents it in a comment for operators who want to force `cpu` temporarily.
- Added to the CLI embed list (`cli/scripts/embed-assets.ts`) so `subwave init`
  materialises the file; then `npm --prefix cli run embed-assets` and commit
  `cli/src/assets.generated.ts` (CI verify job gates this). A `subwave start --gpu`
  convenience flag is a follow-up, not in scope — CLI users can run the raw
  `docker compose -f … -f …` line the overlay header documents.

### Explicitly unchanged

- **`Dockerfile.aio`** keeps its mirrored CPU analyzer block (a one-click Unraid container
  with GPU passthrough is its own project); a comment points at the sidecar cuda flavour.
- **tts-heavy** is TTS-only and stays CPU.
- Model lazy-loading, weight downloads at runtime, the analyze protocol, and the
  controller-side backend resolution (`ANALYZE_URL` → venv) are all untouched — the CUDA
  image is a drop-in analyzer sidecar.

---

## Part B — quiet-times analysis gate

### Approaches considered

1. **Gate at scheduling time** (don't start a pass while listeners are on). Rejected: a
   pass over a large library runs for hours — start-time gating does nothing when a
   listener tunes in mid-run, which is the reporter's actual complaint.
2. **Per-track gate inside `runAnalysisPass`**. **Chosen** — the pass is already a
   resumable per-track loop with progress reporting; a check between tracks pauses within
   seconds of a listener arriving and covers both entry points (server-spawned tagger
   child AND standalone `npm run analyze`) with one implementation.

### Settings (`controller/src/settings.ts`)

Two new fields under the existing `audio` section, following the embeddings/vocalActivity
precedent exactly:

- `audio.analyzeQuietOnly: boolean` (default `false`) — pause the analysis pass while
  anyone is listening. Env `ANALYZE_QUIET_ONLY=1` wins **on** (never off), mirroring
  `ANALYZE_AUDIO_EMBEDDING`.
- `audio.analyzeQuietMinutes: number` (default `10`, clamped 1–120) — how long the stream
  must be continuously listener-free before the pass starts/resumes.

Both entry points already call `settings.load()` before `runAnalysisPass`, so the child
process reads the toggle without new plumbing.

### Gate mechanics (`controller/src/music/analyze.ts` + new pure helper)

At the top of the per-track loop (and once before the loop starts):

1. If the gate is off → proceed (zero new work on the default path).
2. Fetch the current listener count with a **one-shot** Icecast status check. The pass
   runs in a child process with no `startListenerMonitor()` loop, so it calls
   `listeners.refresh()` + `getListenerCount()` directly (`config.icecast.statusUrl` is
   already reachable from the controller container/CLI env; the Safari dedup logic comes
   for free).
3. `count === 0` → track `quietSince`; proceed only once `now - quietSince ≥
   analyzeQuietMinutes`. Any `count > 0` resets `quietSince`.
4. Not quiet long enough → sleep 30s, re-check. While waiting, emit
   `reportProgress({ phase: 'analyze', label: 'Waiting for quiet (N listening)', … })` and
   a `[analyze]` console line (throttled to one per state change) so the admin Library
   panel shows *why* the pass is stalled rather than a frozen counter.

Decisions inside that flow:

- **Unknown count = proceed.** `getListenerCount()` returns `null` when Icecast is
  unreachable. The DJ gates fail toward "occupied" (a stats outage must never silence the
  DJ); the quiet gate fails the **other** way — if Icecast is down, nobody is streaming
  and CPU is free, and the worst case of a wrong guess is pre-#1099 behaviour (analysing
  while someone listens). A stats outage must never stall the library scan forever.
- **In-flight work finishes.** The gate sits between tracks; a listener arriving mid-track
  lets that one track (seconds) complete. The one-ahead prefetch for track i+1 may already
  be in flight when the gate pauses — it's a download to the shared volume, harmless; the
  pause happens before the *compute* is requested.
- **The gate applies whenever the toggle is on**, including admin-button "Analyse now"
  runs. A pass is hours long; "explicit action bypasses the gate" (the manual-segment
  precedent) doesn't transfer to a job that outlives the click. The operator's bypass is
  turning the toggle off. The admin UI copy states this.
- **Quiet-state timing is a pure helper** (`quietGateDecision({enabled, count, nowMs,
  quietSinceMs, quietMinutes})` → `{action: 'proceed'|'wait', quietSinceMs}`), unit-pinned
  alongside the existing pure-test pattern (`scripts/programme.test.ts` style) so the
  reset/threshold edge cases are locked without needing Icecast in tests.

### Admin UI (`web/components/admin/settings/LibrarySection.tsx`)

A "Run analysis at quiet times" toggle + a quiet-minutes number input next to the existing
audio embeddings / vocal activity controls, persisted through the same `/settings` route
(which already round-trips the `audio` section — extend its validator with the two
fields). Helper text: "Pauses library analysis while anyone is listening; resumes after
the stream has been idle this many minutes. Applies to manual runs too."

---

## Error handling summary

| Failure | Behaviour |
| --- | --- |
| `ANALYZE_DEVICE=cuda` but no GPU visible | Warn once, run on CPU; pass completes |
| CUDA OOM / driver fault mid-track | Existing per-track try/catch records the track as failed, row stays NULL, next run retries; `mem_limit` OOM containment unchanged |
| Icecast unreachable during quiet gate | Count `null` → treated as quiet → analysis proceeds |
| Toggle flipped off mid-pause | Settings are read once per pass (the embeddings/vocal precedent), so the change applies from the next pass; to unstick a paused pass immediately, use the existing tagger Stop button |
| Gate on, listeners never drop to 0 | Pass waits indefinitely with a visible "Waiting for quiet" progress label; Stop button remains the escape hatch |

## Testing & verification

- `npm run lint` in `controller/` and `web/` (the merge gate), plus the new pure test for
  `quietGateDecision` wired into the existing controller test script.
- **Local (this box, AMD GPU — no CUDA):** `docker build --build-arg WITH_CLAP=1
  --build-arg WITH_DEMUCS=1 --build-arg WITH_CUDA=1 -f docker/Dockerfile.analyzer .`
  proves pip resolution (building needs no GPU; only the overlay's device reservation
  needs one at *run* time). Then `docker run` the built image without the reservation and
  drive one analysis under `ANALYZE_DEVICE=auto` — proves the no-GPU fallback resolves to
  CPU and the worker still analyses correctly (no regression).
- **Quiet gate:** dev-stack run with the toggle on — confirm the pass pauses while a
  listener is connected, shows the waiting label in the admin panel, and resumes after the
  configured quiet window.
- **Actual GPU execution cannot be verified in this environment** (no NVIDIA hardware).
  The PR will say so and ask the issue reporter (who has the hardware and the motivation)
  to validate `subwave-analyzer-cuda` from the PR build — mirroring how heavy-image
  changes have been validated before.

## Out of scope / follow-ups

- `subwave start --gpu` CLI flag (overlay is embedded + documented; flag is convenience).
- CUDA execution provider for the ONNX CLAP path (`onnxruntime-gpu`).
- A CUDA AIO flavour.
- ROCm/Metal backends (issue asks for CUDA; the device plumbing keeps the door open).
- Scheduling analysis by wall-clock hours (the listener-idle signal subsumes it).
