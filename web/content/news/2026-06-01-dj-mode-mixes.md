---
title: Your DJ now mixes the tracks
date: 2026-06-01
category: Feature
author: The SUB/WAVE desk
excerpt: Turn on DJ mode and the station shapes each crossfade to the two tracks' tempo and key, lands its talk before the vocals, and drops the odd riser on a big jump. It needs an analysed library.
---

DJ mode used to change what the DJ said. It teased the next track and called back to things from earlier in the hour. Now it changes how the tracks join. The station mixes them.

## What's new

When a persona is in DJ mode, the crossfade stops being one fixed length. Two tracks that share a tempo and key lock into a short, tight blend. A clash gets a longer wash that hides the seam. On a big jump up in tempo, the DJ can drop a riser across the join. It also times its between-track line to finish before the vocals come in, and it will string together a short run of tracks that drift in tempo with the time of day.

## How to use it

First, analyse your library so the station knows each track's tempo, key, and intro length:

```
cd controller && npm run analyze
```

Watch the "acoustic analysis · bpm/key" meter on the Library tab in admin fill up. The blends only fire on tracks that have been analysed, so more coverage means more mixing.

Then turn it on. Open admin, go to Personas, and pick a persona. Switch on its DJ mode toggle, the one that reads "Work the desk like a real DJ." It's set per persona, so one host can mix and back-announce while another stays a quiet between-track narrator. Save when you're done.

For the riser flourishes, open Settings, go to the Sound FX tab, and leave "Enable sound effects" on. They fire sparingly, only on the transitions that earn them.

## Why it helps

A fixed ten second fade treats every pair of songs the same. This reads the tempo and key and shapes each join to fit. Compatible tracks slide together. A clash gets a longer wash, and the DJ talks over the intro instead of the vocals. The station starts to sound like a set instead of a shuffle.
