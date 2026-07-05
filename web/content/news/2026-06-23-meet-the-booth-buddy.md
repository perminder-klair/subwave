---
title: Meet the booth buddy
date: 2026-06-23
category: Feature
author: The SUB/WAVE desk
excerpt: A small animated mascot now lives on the player, leading the DJ line and reacting to what the DJ is doing. It is off by default; flip it on in admin, then tap it.
---

The player has a new resident. It's a small pixel creature that sits at the head of the DJ line, right in front of whatever the DJ is saying or picking. It breathes and blinks, and its face changes to match what is happening on air.

## What's new

The booth buddy is a tiny mascot drawn entirely in CSS, so it adds nothing to load and picks up your theme colours on its own. It has five moods:

- **On air** — open mouth and a pulsing antenna while the DJ is talking.
- **Curious** — a head tilt and wide eyes while the DJ picks the next track.
- **Content** — a calm face when things are quiet.
- **Sleepy** — droopy eyes and little z's once it's been idle a while.
- **Spooked** — tap it and its eyes blow wide, then it settles back down.

![The booth buddy's five moods, each a small pixel face: content with an even mouth, on air with an open mouth, curious with a head tilt, sleepy with droopy eyes and drifting z's, and spooked with eyes blown wide](/screenshots/booth-buddy.webp)

## How to use it

It ships off, so nothing changes until you switch it on. Open admin, go to Settings, then Station, and find the Booth Buddy card. Flip it to On:

```
Admin → Settings → Station → Booth Buddy → On
```

The change is live. The player picks it up on its next poll, within about five seconds, with no reload and no restart. Turn it back off and the DJ line goes back to its plain marker. One thing worth knowing: tapping the buddy startles it, but tapping the text next to it still opens the booth feed, the same as before.

## Why it helps

It gives the station a face. The DJ line already tells you what the DJ is thinking. The buddy puts a bit of mood and movement next to that, so there is something alive on the player between tracks instead of a static screen. It is cosmetic and off by default, so it is there when you want some character and gone when you don't.
