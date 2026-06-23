# Running Chatterbox TTS on a GPU

Chatterbox is SUB/WAVE's most expressive local voice and its most demanding. On
CPU it pegs every core and still renders slower than real time, so a chatty
station can fall behind. If you have an NVIDIA GPU, there are two ways to put it
to work.

| | Easy route (OpenAI layer) | Native route (sidecar on GPU) |
|---|---|---|
| Image rebuild | **None** | Required (CUDA PyTorch) |
| SUB/WAVE config | Admin UI only | Dockerfile + compose + env |
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
paralinguistic tags, speed) inside SUB/WAVE's own `tts-heavy` container, at the
cost of a custom image build. You need the
[NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
installed on the host so Docker can pass the GPU through.

### 1. Build the image with CUDA PyTorch

Edit `docker/Dockerfile.tts-heavy` and change the Chatterbox venv's torch
install to a CUDA wheel index that matches your host's driver. Find:

```dockerfile
    /opt/chatterbox/venv/bin/pip install --no-cache-dir --no-build-isolation \
      --index-url https://download.pytorch.org/whl/cpu \
      --extra-index-url https://pypi.org/simple \
      torch torchaudio onnxruntime chatterbox-tts && \
```

and swap the CPU index for a CUDA one, e.g. for CUDA 12.4:

```dockerfile
      --index-url https://download.pytorch.org/whl/cu124 \
```

(Pick the `cuXXX` tag that matches your driver; see
<https://pytorch.org/get-started/locally/>. The image gets larger; the
build-time `rm -rf "$SP/torch/test"` cleanup still applies.)

### 2. Give the container the GPU

Add a device reservation to the `tts-heavy` service in your compose file
(`docker-compose.yml` or `docker-compose.byo.yml`):

```yaml
  tts-heavy:
    # ...existing config...
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
```

### 3. Select the GPU device and bring it up

Set the device flag in your root `.env`:

```bash
echo TTS_HEAVY_DEVICE=cuda >> .env
echo COMPOSE_PROFILES=tts-heavy >> .env
```

Then build the local image (the service defaults to pulling the published
CPU-only image, so you must build explicitly) and start the profile:

```bash
docker compose build tts-heavy
docker compose --profile tts-heavy up -d
```

Confirm the worker grabbed the card. The sidecar log should show
`loading ChatterboxTurboTTS on device=cuda` with no fallback warning:

```bash
docker compose logs -f tts-heavy
```

Voice cloning works exactly as on CPU: drop a reference WAV into
`state/voices/` and select it on the Personas page (see the **Voices & TTS**
page in the in-app manual for the cloning workflow).

> The legacy in-process build (`--build-arg WITH_CHATTERBOX=1` in
> `docker/Dockerfile.controller`) installs CPU PyTorch the same way. To run that
> variant on a GPU, apply the identical CUDA-index swap there and add the same
> device reservation to the `controller` service.

---

## Which should I pick?

- **Want a GPU-backed voice, including one cloned character voice, with no
  rebuild?** Easy route. Register the reference clip on your Chatterbox server
  and select it by name.
- **Want SUB/WAVE to manage a reference WAV per persona, plus paralinguistic
  tags and daypart speed?** Native route, with the custom CUDA build.

Either way the DJ logic is untouched; this only changes *where* the Chatterbox
voice is rendered.
