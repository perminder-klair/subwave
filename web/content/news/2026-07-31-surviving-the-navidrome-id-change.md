---
title: Keep your library data through Navidrome 0.64
date: 2026-09-14
category: Feature
author: The SUB/WAVE desk
excerpt: Navidrome 0.64 changes track IDs. Reconcile preserves your existing tags, analysis, likes and playlist settings across the migration.
---

[Navidrome 0.64.0](https://github.com/navidrome/navidrome/releases/tag/v0.64.0), released September 12, rewrites its internal IDs into one canonical format. Many track and playlist IDs change value. Everything SUB/WAVE knows about your music is keyed by those IDs.

## What's new

SUB/WAVE now recognises the migration when it happens. The library sync replays Navidrome's exact ID transform against its own records, checks the new track IDs against the live library, and moves everything across in place: mood tags, acoustic analysis (including the dead-air trim measurements), sound embeddings, MusicBrainz years, the stem cache, play history, listener likes, the never-play blocklist and its rules, show playlist pins and playlist sync recipes. Existing tags and measurements are reused. If the Navidrome change never reaches your server, the whole feature stays dormant.

## Upgrading to Navidrome 0.64

Install this SUB/WAVE update before reconciling with Navidrome 0.64. Back up Navidrome’s database and your SUB/WAVE state before upgrading. Then open the SUB/WAVE admin, head to **Library**, and press **Reconcile with Navidrome**. The run reports what happened:

```
Re-linked 9,412 tracks after a Navidrome ID migration
```

A full tagger run does the same job if you'd rather wait for your next scheduled one — but don't leave it for days. Until you reconcile, SUB/WAVE is still asking Navidrome for tracks by their old IDs: DJ picks won't resolve, and the hourly fallback playlist thins out to whatever it can pull live from the server. The time needed depends on your library size.

## Why it helps

A tagged and analysed library is days of accumulated compute: LLM mood tagging, acoustic analysis of every file, sound embeddings, MusicBrainz lookups throttled to one request per second. Before this change, the first reconcile after that Navidrome upgrade would have deleted all of it and started from scratch, and quietly dropped your blocklist and liked tracks too. The migration now preserves the existing data. If an older SUB/WAVE reconcile has already pruned those rows, this update cannot recreate them; recovery needs a pre-migration backup or a new tagging and analysis pass.
