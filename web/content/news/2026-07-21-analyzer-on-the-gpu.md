---
title: Big library? Hand the analysis to your GPU
date: 2026-07-21
category: Feature
author: The SUB/WAVE desk
excerpt: A new CUDA analyzer image runs sounds-like and vocal analysis on an NVIDIA card, and a quiet-times switch pauses library scans while anyone is tuned in.
---

This one came straight from a listener request. [Deep analysis](/manual/analysis), the sounds-like fingerprint and the vocal detection, chews through a big library one track at a time on the CPU. If that CPU is also running your local LLM and your voices, the scan and the station end up fighting over the same cores. Two fixes shipped together.

## What's new

There is a third analyzer image, `subwave-analyzer-cuda`. It has everything the heavy image has, but CLAP and Demucs run on an NVIDIA GPU instead of the CPU, and Demucs especially is much faster there.

And for everyone, GPU or not, there is a new quiet-times switch. Turn it on and any analysis run pauses while someone is listening, then resumes once the stream has been empty for a while.

## Put the card to work

One command, no rebuild:

```
docker compose -f docker-compose.yml -f docker-compose.analyzer-gpu.yml up -d
```

The overlay swaps the analyzer to the CUDA image and hands it the GPU. The host needs the NVIDIA driver and the Container Toolkit, nothing else. If the card is not visible, the analyzer notes it in the log and runs on CPU, so nothing breaks while you sort the toolkit out. You can drop `ANALYZER_HEAVY` from `.env` too, the overlay covers it.

## Analyse at quiet times

Open the [Library page](/news/your-dj-knows-your-library) in admin. Next to the sounds-like and vocal controls there is a new row, Quiet times. Enable it and set the idle window, ten minutes by default. A running pass pauses between tracks the moment someone tunes in and shows "Waiting for quiet". Once the room has been empty long enough, it picks up where it left off. It applies to manual runs too, so turn it off if you want a scan right now regardless.

## Why it helps

A big collection gets its model-heavy fingerprint and vocal work off the CPU. Decode and the baseline acoustic measurements still use CPU time, so quiet times remains the way to keep a full rescan from competing with the broadcast. Sounds-like-only backfills skip those already-current baseline measurements and feed each track's windows to CUDA together. It is the same trade [Chatterbox made a month ago](/news/chatterbox-on-the-gpu), this time for the analysis side.

*Update: running the all-in-one image instead of the compose stack? It got [the same CUDA path](/news/one-click-on-the-gpu) a few days later.*
