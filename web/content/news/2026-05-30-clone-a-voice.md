---
title: Make your DJ sound like anyone
date: 2026-05-30
category: Feature
version: v0.2.0
author: The SUB/WAVE desk
excerpt: PocketTTS can now clone a voice from a single WAV. Drop a clip in the voices folder, point a persona at it, and that's the voice on air.
---

Voice cloning used to be a Chatterbox-only party trick. PocketTTS can do it too now, and both engines read their reference clips from the same place. So setting up a custom voice is the same short routine whichever engine you're on.

## What's new

PocketTTS does zero-shot cloning from one reference WAV. There's also a single shared voices folder both heavy engines look in, and the voice picker in admin scrolls properly when you've got a lot of them.

## How to use it

Find a clean clip of the voice you want. A few seconds of clear speech is plenty. Drop the `.wav` into the voices folder:

```
state/voices/morning-host.wav
```

Then open a DJ persona in admin and set its voice to that filename. Save. The next time that persona is on the desk, it speaks in the cloned voice. If a clone ever fails to load, PocketTTS falls back to one of its built-in voices so the segment still airs.

Already had clips in the old `chatterbox-voices/` folder? Leave them. SUB/WAVE still reads that folder, so nothing breaks on upgrade.

## Why it helps

Your station can have a real on-air identity. Give each persona its own voice and the handovers between them actually sound like different people, not the same synth wearing hats.
