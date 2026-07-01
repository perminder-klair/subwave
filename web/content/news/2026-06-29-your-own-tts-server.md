---
title: Point your DJ at your own TTS server
date: 2026-06-29
category: Feature
version: v0.30.0
author: The SUB/WAVE desk
excerpt: A new Remote engine lets SUB/WAVE speak through any TTS server you run yourself. It hands back audio over HTTP, so the box can live anywhere on your network.
---

There's a new voice engine called Remote. It points SUB/WAVE at a text-to-speech server you run yourself, anywhere the controller can reach over the network. The audio comes back over the wire, so the server can live on another machine entirely (a spare GPU, a LAN box, a Tailscale host) with no shared folder between them.

## What's new

Until now, self-hosting a TTS engine meant either baking it into the controller image or dressing it up as the tts-heavy sidecar. Remote is the clean way. It speaks a tiny HTTP contract, and you bring whatever model you like: Qwen3-TTS, F5-TTS, CosyVoice, your own.

## How to use it

Open admin, go to TTS voice, and pick Remote. Set the server URL to your endpoint:

```
http://192.168.1.101:5001
```

Use a LAN or Tailscale address the controller container can reach, not `127.0.0.1`. Your server needs two routes:

```
GET  /health  ->  {"ok": true}
POST /speak   ->  {"text": "...", "voice": "..."}  returns WAV audio
```

A persona's Remote voice is free text, forwarded straight to your server: a voice id, a reference filename, whatever it understands. If the URL is blank or the server is down, the station falls back to Piper, so the DJ never goes quiet.

## Why it helps

You can run a big, natural-sounding model on hardware that suits it and keep the controller lean. No image rebuild, no pretending to be another provider. Point it at the box, save, and your DJ speaks through your own server.
