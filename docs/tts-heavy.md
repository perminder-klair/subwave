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
  bakes CLAP + Demucs, and `subwave-aio-cuda` runs that same pair on an NVIDIA
  GPU.)
- **Fallbacks.** If the `analyzer` service isn't reachable, the controller falls
  back to a [local venv](#running-analysis-without-a-sidecar-dev--offline).
  (`tts-heavy` is TTS-only now — it no longer carries the analyzer.)

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
  and re-pull. (Got an NVIDIA card? Use `subwave-aio-cuda` and pass the GPU
  through instead — [full steps](unraid.md#acoustic-analysis-default-on--expressive-voices-opt-in).)

The heavy image is **amd64-only** (the CPU-torch stack). On an arm64 host also
set `DOCKER_DEFAULT_PLATFORM=linux/amd64` — it runs under emulation (slow, but
analysis is a one-time per-track pass).

### The heavy image needs to reach huggingface.co once

**Model weights are not baked into the image.** The heavy analyzer downloads
CLAP (and Demucs) from `huggingface.co` the first time it is actually asked for
a sounds-like or vocals pass, into the `analyzer-cache` volume mounted at
`/opt/analyzer/hf-cache`. That is a deliberate trade — baking them would add
roughly a gigabyte to an image most people pull over a home connection — but it
does mean the heavy tier has a **one-time outbound network dependency**, and
that dependency is easy to miss because everything else about the station works
offline.

On a host with no outbound reach you'll see this in `docker logs
sub-wave-analyzer`:

```
[analyze] '[Errno 111] Connection refused' thrown while requesting HEAD
https://huggingface.co/laion/clap-htsat-unfused/resolve/main/model.safetensors
[analyze-worker] CLAP load failed
```

The station keeps working — bpm, key, loudness and intros are pure librosa and
need no download — but the sounds-like meter stays at zero. The admin Library
panel says so directly, with the reason, rather than suggesting you switch
image: you're already on the right one.

Three ways out:

- **Let it out once.** The download is a few hundred MB and happens once per
  volume. Once the cache is warm the analyzer never calls out again.
- **Pre-seed the cache from another machine.** The cache is a plain
  [HF cache directory](https://huggingface.co/docs/huggingface_hub/guides/manage-cache).
  On a box that *does* have reach:
  ```bash
  pip install huggingface_hub
  HF_HOME=./hf-cache huggingface-cli download laion/clap-htsat-unfused
  ```
  then copy `hf-cache/` onto the analyzer's volume (`docker cp ./hf-cache/.
  sub-wave-analyzer:/opt/analyzer/hf-cache/`) and restart the analyzer.
- **Point at your own copy.** `CLAP_MODEL` accepts a local path as well as a hub
  id, so a weights directory you already mirror can be used directly.

Once the cause is fixed, **restart whatever is holding the analyzer**. The
failure is remembered until you do — deliberately, because that is what stops
the analysis pass re-attempting the same tracks on every run and reporting the
same "+N tracks missing an audio vector" count forever. Which process that is
depends on your install, and the admin panel names the right one for yours:

- **Sidecar** (the default compose stacks): `docker compose restart analyzer`.
  The failure is remembered inside the analyzer container, across the idle
  worker respawn that used to reset it.
- **AIO, or a local librosa venv**: there is no separate analyzer — the worker
  is a child of the controller and the failure is remembered in the controller
  process, so restart *that* (on the AIO, the container). `docker compose
  restart analyzer` has nothing to act on there.

### Heavy analysis on an NVIDIA GPU (CUDA)

On a host with an NVIDIA card, the heavy stack can run CLAP + Demucs on the GPU
— a big speed-up on deep library ingestion. Audio decode/resampling and the
baseline bpm/key/loudness/structure pass remain CPU work; CUDA accelerates the
model stages rather than replacing the whole analyzer. A sounds-like backfill
over tracks whose baseline analysis is already current skips those baseline
features, and batches each track's CLAP windows into one CUDA model call.

It's a compose overlay, not an `.env` toggle (a GPU device reservation can't be
switched from `.env`):

```bash
docker compose -f docker-compose.yml -f docker-compose.analyzer-gpu.yml up -d
```

That swaps the `analyzer` service to the `subwave-analyzer-cuda` image (heavy +
cu124 torch wheels) and hands it the GPU. Requirements: the NVIDIA driver +
[NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
— nothing else; the CUDA runtime rides inside the image. The worker picks the
device itself (`ANALYZE_DEVICE=auto`): if the GPU isn't actually visible it logs
a warning and falls back to CPU rather than failing the pass. `ANALYZER_HEAVY`
is irrelevant while the overlay is applied — the image is overridden outright.

Running the **all-in-one** container instead? It has no `analyzer` service to
swap, so there's no overlay: pull the `subwave-aio-cuda` tag (the heavy AIO built
on the same cu124 wheels) and hand the container the GPU directly. Steps for
Unraid, including the driver plugin and the extra parameters, are in
[unraid.md](unraid.md#acoustic-analysis-default-on--expressive-voices-opt-in);
anywhere else it's `--gpus all` on your `docker run`. Everything below about
device selection and VRAM applies there unchanged.

Sharing the card with a local TTS or LLM? The worker plays nice: after ~5
minutes with no CLAP/Demucs use it drops its models out of VRAM and reloads
them on the next request (`ANALYZE_IDLE_UNLOAD_S` in `.env` tunes the window;
`0` keeps them resident; CPU-only hosts get the same release with a longer
30-minute default — #1204). The trade: the first heavy request after a release
pays a cold reload from the on-disk cache — a few seconds for CLAP on a typical
box (measured ~2s; a "sounds like ..." search may feel it on slower hardware),
longer for Demucs. If your station leans on sound search and RAM is plentiful,
`ANALYZE_IDLE_UNLOAD_S=0` restores the old always-resident behaviour. A few
hundred MB of CUDA context remain until the analyzer container stops. Pair it with the **quiet times** toggle on the admin
Library page and a long scan pauses — and frees the GPU — whenever listeners
are tuned in.

### Running the analyzer on another machine

Everything above assumes the card is in the same host as the station. If it
isn't — the station lives on a NAS or a mini-PC and the GPU is in a desktop
somewhere else — you do **not** have to move the station, and you certainly
don't have to stop the stack and copy `appdata` to the GPU box and back.

The analyzer is a plain HTTP service, and the controller resolves its backend
from one variable:

```ini
# root .env, on the STATION host
ANALYZE_URL=http://192.168.1.101:8080
```

It probes `{ANALYZE_URL}/health` for the `analyze` capability and, when that
answers, sends analysis there instead of to the local `analyzer` container. Use
a LAN or Tailscale address — `localhost` is the *controller container's*
loopback.

The fast path still uses shared storage: the controller pre-fetches each track
to `/var/sub-wave/analyze-tmp/` and hands that path to the analyzer, overlapping
the next network fetch with the current DSP work. If the remote analyzer cannot
read the path, it now returns a typed refusal and the controller retries that
track by URL. That makes a share-less remote analyzer work, at the cost of the
prefetch overlap.

A same-path state mount is therefore **recommended for throughput, but required
only for stem caching**. Stem rendering writes into `state/stems/`; a remote
machine cannot send those files back through the URL fallback.

So, on the GPU host:

```yaml
# docker-compose.yml on the GPU MACHINE — analyzer only.
services:
  analyzer:
    # -heavy is CLAP + Demucs on the CPU, and is amd64-only. For the GPU, swap
    # in subwave-analyzer-cuda and add the `deploy:` block below.
    image: ghcr.io/perminder-klair/subwave-analyzer-heavy:latest
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      # Optional for ordinary analysis; recommended for the prefetch fast path
      # and REQUIRED for stem caching. It must resolve to the station's state
      # files at this exact path. NFS/SMB is the usual choice; the AIO's
      # equivalent is the appdata share.
      - /mnt/subwave-state:/var/sub-wave
      - analyzer-cache:/opt/analyzer/hf-cache
    # CUDA image only — same reservation docker-compose.analyzer-gpu.yml applies
    # (that file also documents the legacy `runtime: nvidia` fallback).
    # deploy:
    #   resources:
    #     reservations:
    #       devices:
    #         - driver: nvidia
    #           count: all
    #           capabilities: [gpu]
volumes:
  analyzer-cache:
```

Then set `ANALYZE_URL` on the station host and `docker compose up -d`. Sanity
checks, in order:

1. `curl http://<gpu-host>:8080/health` from the **station** host — expect
   `"ok": true` with `analyze` in `engines`.
2. If you configured the shared-state fast path, run
   `docker compose exec analyzer ls /var/sub-wave/analyze-tmp` on the **GPU**
   host while a scan runs. Empty or unreadable means the controller will use
   slower URL downloads; fix the mount before enabling stem caching.
3. Watch the station's analyze log. A one-time `using URL downloads` warning
   confirms the share-less fallback is active. Timeouts are ambiguous — the
   per-track deadline is
   `ANALYZE_REQUEST_TIMEOUT_MS` (120s by default), and reading a long track
   across a slow share *plus* the DSP can outrun it on a link that is otherwise
   working. Raise it before concluding the URL is wrong.

Keep the local `analyzer` service stopped (`docker compose stop analyzer` after
each `up -d`, which restarts it) so you aren't paying for an idle image, and
if you use the shared path, mind that it needs read permission for staged audio
and write permission for stems under the analyzer's user.

> **Not the same as sharing your music library.** Navidrome's music files aren't
> involved here; the shared directory is SUB/WAVE's own `state/`.

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

### Run just one engine (Chatterbox *or* PocketTTS)

Both engines are baked into the `tts-heavy` image, and by default the sidecar
loads **both** on boot. But each one is a separate PyTorch model: loading it
costs RAM, a multi-gigabyte weight download the first time, and 30–60 s of
startup. If your personas only use one engine, tell the sidecar to skip the
other — one line in `.env`, no rebuild:

```ini
# root .env — comma-separated; default is "chatterbox,pocket-tts" (both)
TTS_HEAVY_ENGINES=pocket-tts       # PocketTTS only — Chatterbox never loads
# TTS_HEAVY_ENGINES=chatterbox     # Chatterbox only
```

Then `docker compose --profile tts-heavy up -d` (recreates the sidecar). The
skipped engine's worker never starts, so you reclaim its memory and its cold
load. If a persona is still pointed at the disabled engine, its `/speak` calls
return a clean `503` and the DJ falls back to Piper — nothing goes silent.

`GET /health` on the sidecar reports `enabled: [...]` (what it was told to load)
alongside `engines: [...]` (what's currently ready), so you can confirm the
selection took. An empty or all-typo value falls back to loading both, so a bad
entry never silently disables all heavy TTS.

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
  energy.

Both ship only in the **heavy** analyzer image (`subwave-analyzer-heavy`). If you
see basic BPM/key working but vocal or "sounds-like" data missing, you're on the
lean analyzer — enable the heavy tier with `ANALYZER_HEAVY=1`
([above](#enabling-sounds-like--vocals-the-heavy-tier)), not by pulling `tts-heavy`.

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
   If it never warms up, the download itself is the usual reason — see
   [the heavy image needs to reach huggingface.co once](#the-heavy-image-needs-to-reach-huggingfaceco-once).
   `/health` reports it: `analyze_audio_capable: false` alongside an
   `analyze_audio_error` naming the cause.
4. **Same track count every run?** "audio backfill: +90 already-analysed tracks
   missing an audio vector", the same 90, forever, means the pass is re-targeting
   tracks it can't fill. Either the model isn't loading (step 3 — the admin panel
   now names the reason), or those specific files fail to decode. The Library
   panel lists the failing tracks with their errors once any track has failed
   three times, and stops retrying them until you clear the list.
5. **Lost your tags after a restart?** That's a *separate* issue from the engine
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
