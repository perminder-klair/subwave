# Running Chatterbox TTS on a GPU

Chatterbox is SUB/WAVE's most expressive local voice and its most demanding. On
CPU it pegs every core and still renders slower than real time, so a chatty
station can fall behind. If you have an NVIDIA GPU, there are two ways to put it
to work.

| | Easy route (OpenAI layer) | Native route (sidecar on GPU) |
|---|---|---|
| Image rebuild | **None** | Required (CUDA PyTorch) |
| SUB/WAVE config | Admin UI only | one env var + a compose overlay |
| Voice cloning | Yes, server-side, selected by **voice name** | Yes, per-persona reference WAVs in SUB/WAVE |
| Drop a WAV into `state/voices/` per persona | No (register it on the server instead) | Yes |
| Paralinguistic tags (`[laugh]`, `[sigh]`) | Depends on your server | Yes |
| Daypart speed shaping | No | Yes |
| Where Chatterbox runs | Your own server | SUB/WAVE's `tts-heavy` container |

**Both routes can clone a voice.** The difference is *where the reference clip
lives*: on the easy route you register it on your Chatterbox server and pick it
by name; on the native route you manage reference WAVs inside SUB/WAVE, one per
persona. If you just want one cloned character voice (an Optimus Prime, say) and
no rebuild, the easy route gets you there.

---

## Why the bundled engine is CPU-only

The Chatterbox worker (`controller/scripts/chatterbox_worker.py`) already
supports CUDA: it reads a `CHATTERBOX_DEVICE` env var (`cpu` or `cuda`) and loads
the model onto that device. The `tts-heavy` sidecar exposes this as
`TTS_HEAVY_DEVICE` (`docker/tts-heavy/server.py`), and the compose files already
pass it through:

```yaml
# docker-compose.yml, tts-heavy service
environment:
  - TTS_HEAVY_DEVICE=${TTS_HEAVY_DEVICE:-cpu}
```

The catch: the published `subwave-tts-heavy` image installs **CPU-only PyTorch
wheels** (`docker/Dockerfile.tts-heavy` pins
`--index-url https://download.pytorch.org/whl/cpu`). PyTorch built that way
cannot see a GPU, so even with `TTS_HEAVY_DEVICE=cuda` the worker prints
`CUDA requested but unavailable — falling back to cpu` and runs on the CPU
anyway. Genuinely using the card needs a CUDA PyTorch build *and* the GPU handed
into the container. That's the native route below.

---

## Easy route: your own Chatterbox server over the OpenAI layer

SUB/WAVE's **Cloud** TTS engine speaks the OpenAI speech API, and it accepts an
`OpenAI-compatible` provider that points at any self-hosted server exposing
`/v1/audio/speech`. So you run Chatterbox on your GPU box behind that endpoint
and aim the Cloud engine at it. Nothing in SUB/WAVE is rebuilt.

### 1. Run a Chatterbox OpenAI-compatible server on the GPU host

Use a Chatterbox server that exposes an OpenAI-style `/v1/audio/speech`
endpoint. The community **Chatterbox TTS API** project
(`devnen/Chatterbox-TTS-Server` and similar) does exactly this and ships with
CUDA support. Follow its README to start it on the GPU machine; most default to
port `5000` (or `4123`). Confirm it's up:

```bash
curl http://<gpu-host>:5000/v1/models
```

The host must be reachable **from the controller container**, so use the
machine's LAN or Tailscale IP, not `127.0.0.1`.

### 2. Point SUB/WAVE's Cloud engine at it

In the admin console under **Admin → TTS voice**, choose the **Cloud** engine,
then:

- **Provider** → `OpenAI-compatible (llama.cpp, vLLM, LM Studio)`
- **Server base URL** → `http://<gpu-host>:5000/v1` (include the `/v1` suffix)
- **Model** → the id the server reports at `/v1/models` (often `chatterbox`)

Save. The DJ now renders its voice on your GPU. Assign the Cloud engine per
segment kind if you only want the heavy voice for some moments (e.g. station IDs
on the GPU, routine time checks on local Piper).

### Cloning a voice on this route

The OpenAI speech API has **no field for a per-request reference clip**, so
SUB/WAVE can't hand the server a WAV to clone on the fly the way the native
sidecar does. But it *does* forward the persona's voice **name** (the `voice`
field, sent for `openai-compatible` too; see `cloud-speech.ts`). The popular
Chatterbox API servers let you register a reference clip as a **predefined /
named voice** server-side (drop the WAV into the server's voices folder, give it
a name). So the cloning still happens, just on the server, selected by name:

1. Put your `optimus-prime.wav` reference on the Chatterbox server and expose it
   as a named voice (e.g. `optimus`). Check `/v1/models` or `/v1/audio/voices`
   to confirm the name your server reports.
2. In SUB/WAVE, set that persona's **voice** to `optimus` (Personas page, or the
   Cloud engine's voice field). SUB/WAVE forwards it as the OpenAI `voice`
   parameter and your server renders the cloned voice on the GPU.

What you give up versus the native route:

- the in-app **drop-a-WAV-into `state/voices/`** workflow; references live on
  your server instead, so a different persona-per-clone setup is more manual
- **daypart speed shaping** (the `speed` field is omitted for `openai-compatible`)

If you want SUB/WAVE to own the reference clips per persona, use the native
route.

---

## Native route: GPU-enable the bundled sidecar

This keeps the full Chatterbox feature set (reference-WAV cloning,
paralinguistic tags, speed) inside SUB/WAVE's own `tts-heavy` container. No
Dockerfile editing: the Chatterbox torch wheel index is a build arg
(`CHATTERBOX_TORCH_INDEX_URL`), and an opt-in compose overlay
(`docker-compose.tts-heavy-gpu.yml`) carries the GPU device reservation, the
`cuda` device flag, and a forced local build. You need the
[NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
installed on the host so Docker can pass the GPU through.

### 1. Point the build at CUDA wheels

In your root `.env`, set the wheel index to a `cuXXX` tag that matches your host
driver (see <https://pytorch.org/get-started/locally/>):

```bash
echo 'CHATTERBOX_TORCH_INDEX_URL=https://download.pytorch.org/whl/cu124' >> .env
```

This is scoped to the Chatterbox venv. PocketTTS and the analyzer stay on CPU
wheels, so the image only grows by the one CUDA torch it actually needs.

#### RTX 50-series (Blackwell / sm_120)

The index swap alone is **not enough** on a 50-series card. `chatterbox-tts`
hard-pins `torch==2.6.0`, whose CUDA kernels stop at sm_90 — so on Blackwell the
model loads but every synthesis fails with `CUDA error: no kernel image is
available`, surfacing as a 500 from the sidecar. pip won't bump torch past that
exact pin in a single resolve, even with a cu128 index. Set **both** a cu128
index and a newer torch spec to override the pin:

```bash
echo 'CHATTERBOX_TORCH_INDEX_URL=https://download.pytorch.org/whl/cu128' >> .env
echo 'CHATTERBOX_TORCH_SPEC=torch==2.9.1 torchaudio==2.9.1' >> .env
```

`CHATTERBOX_TORCH_SPEC` is reinstalled over chatterbox's deps (kept intact) once
the normal install finishes, so the matching `nvidia-*` cu128 runtime libs come
with it. The worker (`chatterbox_worker.py`) carries the two shims torch 2.9
needs against a 2.6-era chatterbox: it writes WAVs via `soundfile` instead of
`torchaudio.save` (which on torch ≥ 2.8 wants the absent `torchcodec`), and it
coerces librosa's audio output back to `float32` (2.9 rejects the `float64` that
chatterbox's loudness-normalisation introduces). Both are no-ops on CPU and on
older cards.

### 2. Build + start with the GPU overlay

Layer `docker-compose.tts-heavy-gpu.yml` on top of your prod compose file. The
overlay adds the GPU device reservation, sets `TTS_HEAVY_DEVICE=cuda`, and
forces a local build (the published image ships CPU-only torch):

```bash
docker compose -f docker-compose.yml -f docker-compose.tts-heavy-gpu.yml \
  --profile tts-heavy up -d --build
```

(BYO reverse-proxy hosts: swap `docker-compose.yml` for `docker-compose.byo.yml`.)

### 3. Confirm it grabbed the card

The sidecar log should show `loading ChatterboxTurboTTS on device=cuda` with no
fallback warning:

```bash
docker compose logs -f tts-heavy
```

Voice cloning works exactly as on CPU: drop a reference WAV into
`state/voices/` and select it on the Personas page (see the **Voices & TTS**
page in the in-app manual for the cloning workflow).

> The overlay only covers the sidecar. The legacy in-process build
> (`--build-arg WITH_CHATTERBOX=1` in `docker/Dockerfile.controller`) honours the
> same `CHATTERBOX_TORCH_INDEX_URL` / `CHATTERBOX_TORCH_SPEC` build args, but has
> no compose overlay — running *that* variant on a GPU means passing those build
> args yourself plus adding a device reservation on the `controller` service.

> **Legacy NVIDIA runtime?** If `docker compose up` fails the device reservation
> with *"could not select device driver nvidia"*, your host registers the NVIDIA
> runtime in legacy mode. Drop the overlay's `deploy:` block and use
> `runtime: nvidia` with `NVIDIA_VISIBLE_DEVICES=all` instead — the overlay
> comments spell out the swap.

---

## Which should I pick?

- **Want a GPU-backed voice, including one cloned character voice, with no
  rebuild?** Easy route. Register the reference clip on your Chatterbox server
  and select it by name.
- **Want SUB/WAVE to manage a reference WAV per persona, plus paralinguistic
  tags and daypart speed?** Native route, with the custom CUDA build.

Either way the DJ logic is untouched; this only changes *where* the Chatterbox
voice is rendered.
