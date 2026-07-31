---
title: Your library will survive the big Navidrome ID change
date: 2026-07-31
category: Feature
author: The SUB/WAVE desk
excerpt: An upcoming Navidrome release renames almost every track ID in its database. SUB/WAVE now spots the change and carries your tags, analysis, likes and playlists across. One press of Reconcile is the whole upgrade.
---

There is a change coming to Navidrome that would normally hurt. A pending update rewrites nearly every ID in its database into one canonical format, and most track and playlist IDs change value. Everything SUB/WAVE knows about your music is keyed by those IDs.

## What's new

SUB/WAVE now recognises the migration when it happens. The library sync replays Navidrome's exact ID transform against its own records, checks each mapping against the live server, and moves everything across in place: mood tags, acoustic analysis, sound embeddings, MusicBrainz years, the stem cache, play history, listener likes, the never-play blocklist, show playlist pins and playlist sync recipes. Nothing gets re-derived, nothing gets lost. If the Navidrome change never reaches your server, the whole feature stays dormant.

## What to do when the update lands

Upgrade Navidrome as you normally would (back up its database first, their release notes will say the same). Then open the SUB/WAVE admin, head to **Library**, and press **Reconcile with Navidrome**. The run reports what happened:

```
Re-linked 9,412 tracks after a Navidrome ID migration
```

A full tagger run does the same job if you'd rather wait for your next scheduled one. Until you reconcile, the station keeps playing from its hourly fallback playlist, so there is no rush and no dead air.

## Why it helps

A tagged and analysed library is days of accumulated compute: LLM mood tagging, acoustic analysis of every file, sound embeddings, MusicBrainz lookups throttled to one request per second. Before this change, the first reconcile after that Navidrome upgrade would have deleted all of it and started from scratch, and quietly dropped your blocklist and liked tracks too. Now it's a rename.
