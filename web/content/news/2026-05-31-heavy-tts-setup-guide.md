---
title: A nudge toward the better-sounding voices
date: 2026-05-31
category: Feature
version: v0.2.0
author: The SUB/WAVE desk
excerpt: If you pick a heavy TTS engine that isn't installed yet, the setup page now tells you exactly how to turn it on instead of quietly falling back to Piper.
---

SUB/WAVE has five voice engines. Two of them, Chatterbox and PocketTTS, sound noticeably more natural than the lightweight default, but they're heavy, so they don't ship switched on. The old behaviour was confusing: pick one of them before it was installed and the station just fell back to Piper without saying why.

## What's new

The setup screen now spots when you've chosen an engine that isn't running yet. Instead of silently reverting, it shows a short guide telling you how to bring that engine up.

## How to use it

Open the admin TTS settings and pick Chatterbox or PocketTTS. If the engine isn't available, you'll see the setup note right there. It points you at the heavy-TTS sidecar, which you start with one command:

```
docker compose --profile tts-heavy up -d
```

That brings up a separate container holding both heavy engines. It shares the same volume as the controller, so once it's running your chosen voice just works, with no extra wiring. Until then the station keeps talking on Piper, so you never go off air while you sort it out.

## Why it helps

You stop guessing. The reason a voice didn't change is now on the screen, with the fix next to it, so getting the good voices going takes a minute instead of a debugging session.
