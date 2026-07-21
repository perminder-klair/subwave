---
title: Run your station on Plex, or just a folder
date: 2026-07-04
category: Feature
author: The SUB/WAVE desk
excerpt: Your music library is now pluggable. Navidrome is still the default, but you can point SUB/WAVE at a Plex server or a plain folder of files instead.
---

Until now, SUB/WAVE meant Navidrome. It's still the default and still the richest option, but it's no longer the only one. Your music library is now pluggable: pick a source, and the whole station runs on it.

## What's new

Three sources ship. Navidrome or Subsonic, a Plex Media Server, or a plain local folder of audio files. You pick one in the onboarding wizard, or later in admin. Everything downstream (playing tracks, taking requests, tagging, analysis, the library page) works the same on all three. What changes is how much the DJ can learn about your music.

## How to use it

Pick your source in admin, under Settings, Music source. Plex and local read their config from your root `.env`. For Plex, point it at your server:

```
PLEX_URL=http://your-plex:32400
PLEX_TOKEN=xxxxxxxxxxxx
```

For a folder, drop files into `state/music` (or set `MUSIC_DIR` elsewhere) and hit Rescan:

```
MUSIC_DIR=/var/sub-wave/music
```

Switching is safe. Your mood tags and acoustic analysis get matched to the new source by artist and title, so the work you've already done carries across. The full rundown of what each source can serve is in the manual, under Music Sources.

## Why it helps

You don't need a Subsonic server to run SUB/WAVE anymore. Already on Plex? Use it. Just have a folder of files on a drive? That works too. On those sources the mood tagger and acoustic analyzer do the heavy lifting that the Last.fm graph does on Navidrome, so tag and analyze your library and the DJ still picks well. Local is actually the quickest to analyze, since it reads your files straight off disk with nothing to download.
