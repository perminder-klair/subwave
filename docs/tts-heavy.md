# The heavy sidecar: expressive voices + acoustic analysis

SUB/WAVE ships lean. The default install runs the fast, local **Piper** voice
and tags your library from text alone. Two heavier capabilities live in a
single optional container — the **`tts-heavy` sidecar** — and are switched
**off by default**:

1. **Expressive TTS voices** — Chatterbox and PocketTTS, which sound noticeably
   more natural than Piper.
2. **Acoustic analysis** — measuring each track's tempo, key, and loudness, and
   fingerprinting *how it sounds* so the DJ can mix on feel, not just tags. This
   is what powers the energy/pace/loudness signals you see in the
   [Library Observatory](#what-analysis-adds).

Both come from the same container, so **turning either one on is the same
operation**: bring up the `tts-heavy` profile. If your "acoustic engine" shows
as **off**, this page is how you turn it on.

> **The data is never lost when the engine is off.** Your tags and analysis
> live in `state/library.db` (`/var/sub-wave/library.db` inside the container).
> The "acoustic engine on/off" indicator is a *live reachability check* for the
> analysis backend — not a stored setting. When the sidecar is down, existing
> data stays put; you just can't run *new* analysis until it's back up.

> **Only want analysis, not voices?** Acoustic analysis also ships as a
> standalone **`analyzer`** profile — a leaner image (~1.4 GB, or ~370 MB built
> with `WITH_CLAP=0 WITH_DEMUCS=0`) that drops Chatterbox/PocketTTS. Enable it
> with `docker compose --profile analyzer up -d`. Everything below about
> *analysis* applies to it unchanged; the controller checks `ANALYZE_URL` first
> and falls back to the `tts-heavy` sidecar, so either image serves it. See
> [Running analysis without the heavy voices](#running-analysis-without-the-heavy-voices).

---

## Why it's off by default

The sidecar carries PyTorch and the analysis models — it's a multi-gigabyte
image and wants real CPU (or a GPU). Most people running a small radio station
on a NAS or a spare box don't want that weight by default, so SUB/WAVE gates it
behind a Docker Compose **profile**. The controller is *already wired* to talk
to it (`TTS_HEAVY_URL=http://tts-heavy:8080` in all three compose files); the
only thing missing on a default boot is the container itself.

When the profile is off, the URL is unreachable, the controller's `isAvailable()`
probe returns false within ~30s, the DJ falls back to Piper, and the analysis
phase skips cleanly. Nothing breaks — you just get the light path.

---

## Turn it on

The container exists in every compose file under the `tts-heavy` profile. You
enable a profile in one of two ways, depending on how you start the stack.

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

### Running analysis without the heavy voices

If you want the analysis but not Chatterbox/PocketTTS, run the standalone
**`analyzer`** sidecar instead of `tts-heavy`:

```bash
docker compose --profile analyzer up -d
# dev:  docker compose -f docker-compose.dev.yml --profile analyzer up -d
# byo:  docker compose -f docker-compose.byo.yml  --profile analyzer up -d
```

It's the same analysis worker (bpm/key/intro/loudness, CLAP "sounds-like",
Demucs vocals) in a `subwave-analyzer` image that skips the ~5 GB of speech
models. The controller reaches it via `ANALYZE_URL` (defaulted to
`http://analyzer:8080` in all three compose files) and falls back to
`TTS_HEAVY_URL` — so if you already run `--profile tts-heavy`, analysis keeps
working and you don't need this profile. Run **one** of the two; running both
just means the dedicated analyzer wins. Everything in
[Verify it's running](#verify-its-running) applies, swapping `tts-heavy` for
`analyzer` in the container/hostname.

### Running analysis without a sidecar (dev / offline)

The analyzer has a third backend: a **local Python venv** with `librosa`
installed. Point the controller at it with `ANALYZE_PYTHON=/path/to/venv/bin/python`
and it runs analysis in-process, no sidecar needed. This is mainly for
contributors on a dev machine; production should use a sidecar.

---

## Troubleshooting: "acoustic engine is off"

1. **Is the sidecar running?** `docker ps --filter name=tts-heavy`. If nothing
   lists, the profile isn't active — re-read [Turn it on](#turn-it-on). The most
   common miss is restarting the stack *without* the profile (a plain
   `docker compose up -d`, or an Unraid restart with no `COMPOSE_PROFILES` set),
   which leaves the sidecar down.
2. **Is it reachable?** `docker exec sub-wave-controller wget -qO- http://tts-heavy:8080/health`.
   No answer → check the sidecar's logs: `docker logs sub-wave-tts-heavy`.
3. **Did the model still warm up?** First boot downloads model weights into the
   `tts-heavy-*-cache` volumes; the `/health` probe may report not-ready for a
   minute or two on a cold start. Give it time, then re-check the admin panel —
   the probe re-runs every ~30s, so it flips to available on its own.
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
