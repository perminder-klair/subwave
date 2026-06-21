---
title: Run Chatterbox on your nvidia card
date: 2026-06-21
category: Spotlight
author: The SUB/WAVE desk
excerpt: The tts-heavy sidecar ships CPU-only, but with a small rebuild you can move Chatterbox onto an nvidia card for faster voice synthesis. Here is the index swap, the compose change, and the one caveat.
---

The heavy TTS sidecar ships CPU-only on purpose. The PyTorch wheels inside it are the CPU build, which keeps the image from ballooning by several gigabytes. That is the right default for most boxes. But if you just moved your Docker host to a machine with a real nvidia card, you can put Chatterbox on it and get faster voice synthesis. It takes a small rebuild.

## What you're changing

The image installs CPU PyTorch from a pinned wheel index. To use the card you swap that index for a CUDA one, pass the GPU into the container, and flip one env var. There is already a `TTS_HEAVY_DEVICE` switch waiting for this. On the stock image it falls back to CPU, because the torch inside has no CUDA, so the rebuild is what makes the switch real.

## Build a CUDA image

Open `docker/Dockerfile.tts-heavy` and find the Chatterbox venv block. Change its torch index from the CPU wheels to a CUDA build that matches your driver, for example CUDA 12.4:

```
--index-url https://download.pytorch.org/whl/cu124 \
```

That is the only line in that block you need to touch. PocketTTS and the analyzer can stay on CPU.

## Pass the GPU into the container

Install the nvidia-container-toolkit on the host so Docker can see the card. Then give the `tts-heavy` service a GPU reservation in your compose file:

```yaml
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: all
          capabilities: [gpu]
```

Set the device to cuda in your root `.env`:

```
TTS_HEAVY_DEVICE=cuda
```

Rebuild and bring the sidecar back up:

```
docker compose --profile tts-heavy up -d --build tts-heavy
```

The worker logs which device it loaded on. Look for `loading ChatterboxTurboTTS on device=cuda` in the container logs. If CUDA is not actually reachable it logs `cpu` instead and keeps working, so you never lose the voice while you sort the card out.

## One caveat

Only Chatterbox follows `TTS_HEAVY_DEVICE`. PocketTTS and the audio analyzer stay on the CPU no matter what. So this is worth doing if Chatterbox is your DJ voice, where it is the heaviest of the engines and the card buys you the most. On PocketTTS it changes nothing.
