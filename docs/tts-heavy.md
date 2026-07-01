# Heavy voices & acoustic analysis

SUB/WAVE ships lean. The default install runs the fast, local **Piper** voice
and tags your library from text alone. Two heavier capabilities go beyond that —
and they're now packaged **separately**, because they have very different
weights:

1. **Acoustic analysis** — measuring each track's tempo, key, and loudness, and
   fingerprinting *how it sounds* so the DJ can mix on feel, not just tags. This
   powers the energy/pace/loudness signals in the
   [Library Observatory](#what-analysis-adds). It runs in the **`analyzer`**
   sidecar, which **starts by default** — so on a normal install it's already on
   and most operators need to do nothing.
2. **Expressive TTS voices** — Chatterbox and PocketTTS, which sound noticeably
   more natural than Piper. These carry multi-gigabyte speech models and stay
   **opt-in**, in the separate **`tts-heavy`** sidecar you turn on yourself.

So the two headings below split accordingly: [the analyzer](#acoustic-analysis-runs-by-default)
is already running, and [turning on the voices](#turn-on-the-voices) is the
one-line change. (The AIO one-click image bundles the analyzer in-process, so it
has analysis too, without a second container.)

> **The data is never lost when the engine is off.** Your tags and analysis
> live in `state/library.db` (`/var/sub-wave/library.db` inside the container).
> The "acoustic engine on/off" indicator is a *live reachability check* for the
> analysis backend — not a stored setting. When the analyzer is down, existing
> data stays put; you just can't run *new* analysis until it's back up.

---

## Acoustic analysis runs by default

Analysis lives in its own **`analyzer`** sidecar (`subwave-analyzer`), which
**starts with the rest of the stack** — no flag, no profile. A default
`docker compose up -d` brings it up next to the controller and web, and the
controller finds it automatically via `ANALYZE_URL=http://analyzer:8080`. After
your first library scan (**admin → Library → Rescan**, tick *re-analyse*), tracks
start getting tempo/key/loudness.

- **Lean & multi-arch by default.** The published image is ~1.1 GB (librosa +
  ffmpeg, **no PyTorch**) and runs natively on amd64 **and arm64**
  (NAS/Pi/Apple-Silicon). It covers bpm/key/intro/loudness.
- **"Sounds-like" + vocals are the heavy opt-in.** CLAP audio embeddings and
  Demucs vocal ranges add a CPU-torch stack (the `-heavy` image is ~1.9 GB) that
  isn't in the lean image. Enable them with **one line in `.env`** —
  [see below](#enabling-sounds-like--vocals-the-heavy-tier).
- **Turn it off.** If you don't want analysis at all, `docker compose stop
  analyzer` (it won't come back until the next explicit `up`).
- **AIO.** The all-in-one image bundles the analyzer *in-process* (a local
  `librosa` venv the controller drives directly), so the one-click container has
  analysis with no second service. (`subwave-aio` is lean; `subwave-aio-heavy`
  bakes CLAP + Demucs.)
- **Fallbacks.** If the `analyzer` service isn't reachable, the controller falls
  back to the `tts-heavy` sidecar (its image carries the full analyze worker),
  then to a [local venv](#running-analysis-without-a-sidecar-dev--offline).

Everything under [What analysis adds](#what-analysis-adds) applies here. The rest
of this page is about the **voices** — a separate opt-in.

### Enabling "sounds-like" + vocals (the heavy tier)

The CLAP "sounds-like" embeddings and Demucs vocal ranges ship in a separate
`subwave-analyzer-heavy` image. Switching to it is one line — **no rebuild**:

```ini
# root .env
ANALYZER_HEAVY=1
```

Then `docker compose up -d` (Compose re-pulls the `analyzer` service as
`subwave-analyzer-heavy`). By install type:

- **Cloned install / CLI / raw compose.** Add the line to `.env` and `up -d`.
  The `subwave setup` wizard also asks ("Enable heavy analysis?") and writes it
  for you.
- **Unraid split-stack (Compose Manager).** Add `ANALYZER_HEAVY=1` to your `.env`,
  **Save**, then **Pull & Up**.
- **Unraid one-click (AIO).** There's no second container to swap — instead point
  the container's **Repository** at `ghcr.io/perminder-klair/subwave-aio-heavy`
  and re-pull.

The heavy image is **amd64-only** (the CPU-torch stack). On an arm64 host also
set `DOCKER_DEFAULT_PLATFORM=linux/amd64` — it runs under emulation (slow, but
analysis is a one-time per-track pass). Model weights download lazily into the
analyzer's HF cache the first time you actually run a sounds-like/vocals rescan.

---

## Voices: why they're off by default

The `tts-heavy` sidecar carries PyTorch and the Chatterbox/PocketTTS speech
models — it's a multi-gigabyte image and wants real CPU (or a GPU). Most people
running a small radio station on a NAS or a spare box don't want that weight by
default, so SUB/WAVE gates the *voices* behind a Docker Compose **profile**. The
controller is *already wired* to talk to it
(`TTS_HEAVY_URL=http://tts-heavy:8080` in all three compose files); the only
thing missing on a default boot is the container itself.

When the profile is off, the URL is unreachable, the controller's `isAvailable()`
probe returns false within ~30s, and the DJ falls back to Piper. Nothing
breaks — you just get the light path. (Analysis is unaffected: it has its own
default-on `analyzer` service, above.)

---

## Turn on the voices

The `tts-heavy` container exists in every compose file under the `tts-heavy`
profile. You enable a profile in one of two ways, depending on how you start the
stack.

### Cloned install / raw `docker compose`

Pass the profile flag on `up`:

```bash
docker compose --profile tts-heavy up -d
# dev:  docker compose -f docker-compose.dev.yml --profile tts-heavy up -d
# byo:  docker compose -f docker-compose.byo.yml  --profile tts-heavy up -d
```

The first start pulls (or builds) the image — expect ~1–2 GB and a few minutes.

### Environments where you can't pass `--profile` (Unraid, Portainer, etc.)

Compose Manager Plus on Unraid and most one-click UIs run `up` for you, so you
can't add a flag. Instead, activate the profile from the **`.env`** with the
standard Compose variable:

```ini
COMPOSE_PROFILES=tts-heavy
```

Then **Pull & Up** the stack as usual. `COMPOSE_PROFILES` is read by Docker
Compose itself, so the sidecar starts without any CLI flag. See
[`unraid.md`](unraid.md#acoustic-analysis--expressive-voices-the-tts-heavy-sidecar)
for the Unraid-specific walkthrough.

---

## Verify it's running

```bash
# Container is up
docker ps --filter name=tts-heavy

# Backend answers (from inside the controller's network)
docker exec sub-wave-controller wget -qO- http://tts-heavy:8080/health
```

In the UI, open **admin → Library** (the tagging panel). The acoustic-coverage
bar reads **off** when the backend isn't reachable and fills in as analysis
runs once it is. For voices, **admin → Settings → TTS** lets you pick Chatterbox
or PocketTTS; if the sidecar isn't up yet, the page shows a short note telling
you to start it.

---

## What analysis adds

With the engine on, run a scan from **admin → Library → Rescan** (tick
**re-analyse** to (re)compute acoustic data). Each track gets:

- **Tempo (BPM)** and **musical key** (Camelot wheel in the Observatory).
- **Loudness** and an **intro length** estimate.
- An **audio "sounds-like" embedding** — a learned fingerprint of the recording
  itself, so the DJ can find neighbours by *sound* rather than only by tag text.

This is what lights up the **Library Observatory** (admin → Observatory) — the
energy ramp, the loudness/tempo histograms, the key wheel, and the audio-vector
heatmap.

### Two extra capabilities, both opt-in

- **Audio "sounds-like" embedding (CLAP)** — gated on `ANALYZE_AUDIO_EMBEDDING`.
  The admin Rescan toggles it per-run; set `ANALYZE_AUDIO_EMBEDDING=1` in your
  root `.env` to make it always-on.
- **Vocal-activity detection (Demucs)** — separates vocal vs instrumental
  energy. Built into the published sidecar image (`WITH_DEMUCS=1`). If you see
  basic BPM/key working but vocal or "sounds-like" data missing, you're likely
  on an **older `tts-heavy` image** built without the full stack — pull the
  latest image and recreate the sidecar.

### Running analysis without a sidecar (dev / offline)

The analyzer has a third backend: a **local Python venv** with `librosa`
installed. Point the controller at it with `ANALYZE_PYTHON=/path/to/venv/bin/python`
and it runs analysis in-process, no sidecar needed. This is mainly for
contributors on a dev machine; production should use a sidecar.

---

## Troubleshooting: "acoustic engine is off"

1. **Is the analyzer running?** `docker ps --filter name=sub-wave-analyzer`. It's
   a default service, so a plain `docker compose up -d` should start it — if
   nothing lists, it was stopped or scaled out. Bring it back with
   `docker compose up -d analyzer`. (On the AIO there's no separate container —
   analysis runs in-process; skip to step 3.) If you only run the `tts-heavy`
   sidecar for its analysis, check `docker ps --filter name=tts-heavy` instead.
2. **Is it reachable?** `docker exec sub-wave-controller wget -qO- http://analyzer:8080/health`
   (or `http://tts-heavy:8080/health`). No answer → check the logs:
   `docker logs sub-wave-analyzer`.
3. **Did the model still warm up?** The first *sounds-like/vocals* run downloads
   CLAP/Demucs weights into the analyzer's HF cache; the `/health` probe may
   report not-ready for a minute or two on a cold start. Give it time, then
   re-check the admin panel — the probe re-runs every ~30s, so it flips to
   available on its own. (Plain bpm/key/loudness needs no download.)
4. **Lost your tags after a restart?** That's a *separate* issue from the engine
   being off — it means `state/` didn't come back on the same path, so the
   controller created a fresh empty `library.db`. See the data-persistence note
   in [`unraid.md`](unraid.md#dont-lose-your-library-on-reboot-pin-state_dir).

---

## Resource notes

The sidecar is CPU-bound by default and works fine for analysis on a modest
box, just slowly. For heavy *voices* (Chatterbox especially) a GPU is the
difference between comfortable and painful — see the in-app
**manual → How the DJ Works** for the per-engine trade-offs. Analysis is a
one-time pass per track (cached in
`library.db`), so even on CPU it's a "let it churn overnight" job, not a
per-broadcast cost.

---

See also: [`unraid.md`](unraid.md) for the Unraid walkthrough, [`deployment.md`](deployment.md)
for the cross-platform deploy matrix, and the in-app **manual → Library
Observatory** for what the analysis data looks like once it's populated.
