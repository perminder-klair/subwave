---
title: Four ways to leave a track
date: 2026-07-03
category: Feature
version: v0.35.0
author: The SUB/WAVE desk
excerpt: DJ mode now has four named transition moves, blend, washout, sweep, and dissolve. The DJ picks the one that fits each pair of tracks, so no two joins sound the same.
---

A crossfade used to be a crossfade, one fixed shape for every pair of songs. DJ mode now knows four different ways to leave one track and arrive at the next, and it chooses between them by how well the two tracks fit.

## The four moves

- **Blend** — for tracks that already sit well together. The outgoing song hands off its bass, then its mids, to the incoming one, and keeps only its highs to the end. The next track comes up from underneath, low end first. For a moment it sounds like one piece of music whose ingredients are quietly swapping.
- **Washout** — a dub echo tail. As the outgoing track fades, its last bar loads into a delay that swells and decays over the new song coming up. That one is the DJ closing a chapter rather than smoothing a seam.
- **Sweep** — the dramatic one. A filter closes down hard over the track you're leaving, choking it into the dark while the new pick rises clean underneath it.
- **Dissolve** — a reverb wash. The outgoing track loses its beat to a diffuse haze and recedes into a big dark room, and the next track walks in through the cloud.

## How to use it

There's nothing new to switch on. The moves ride on DJ mode and an analysed library, the same two things that turn on mixing in the first place:

```
cd controller && npm run analyze
```

Then open admin, go to Personas, and turn on a persona's DJ mode toggle. From there the DJ decides. Compatible tracks tend to get a blend, a real clash gets a sweep or a dissolve, and a washout is the DJ's own call when it wants to sign off a run.

## Why it helps

One fade treats every join the same. Four moves, picked to fit each pair, mean the station rarely leaves a track the same way twice. The seams start to sound like choices.
