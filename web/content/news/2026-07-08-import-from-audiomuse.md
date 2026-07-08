---
title: Bring your AudioMuse tags across
date: 2026-07-08
category: Feature
author: The SUB/WAVE desk
excerpt: Already ran AudioMuse-AI over your library? A new importer pulls those moods, BPM, key and energy straight into SUB/WAVE, so you don't tag everything a second time.
---

Plenty of you turned up already having tagged your whole library in AudioMuse-AI, and then found SUB/WAVE wanted to analyse it all over again. Fair complaint. There's now a tool that carries that work straight across instead.

## What's new

A small standalone tool lives under `tools/audiomuse-import`. Point it at your AudioMuse instance and it reads the analysis you already have and writes it into SUB/WAVE's library. Both apps happen to key tracks by the same Navidrome song id, so the match is exact, no guessing by filename. It works even on a fresh SUB/WAVE with an empty library.

## How to use it

Both apps need to point at the same Navidrome. Then:

```
cd tools/audiomuse-import
npm install
AUDIOMUSE_URL=http://your-audiomuse:8000 node import.mjs
```

By default it only fills in blanks, so anything you've already tagged in SUB/WAVE stays put. Add `--dry-run` to see what it would do first, or `--overwrite` to let AudioMuse's data win everywhere.

What comes across: moods, BPM, musical key (as Camelot), energy, and genre. What stays behind: the audio embeddings and the ending and structure data, because SUB/WAVE measures those with a different model than AudioMuse does. So run `npm run analyze` once afterwards to layer the transition and "sounds like" data on top.

## Why it helps

Tagging a big library from scratch is the slow part of getting on air. If you've already done it once in AudioMuse, this gets you a station that knows your music in a couple of minutes rather than a couple of hours.

One catch: it's Navidrome only for now. Jellyfin, Plex, Emby and LMS hand out track IDs from a different system that won't line up.
