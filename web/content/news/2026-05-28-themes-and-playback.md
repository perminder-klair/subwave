---
title: Your own look, and steadier sound on Firefox
date: 2026-05-28
category: Feature
version: v0.2.0
author: The SUB/WAVE desk
excerpt: Each listener can now flip the player between light and dark for themselves, and a Firefox playback glitch that cut the audio on track changes is fixed.
---

Two changes this week. One you'll see, one you'll hear.

## Pick your own light or dark

The station palette is still yours to set in admin, and that's what shapes the overall look for everyone. But the day-to-day light-or-dark choice is now personal. There's a switcher in the player header and in the admin header.

Tap it to cycle light, dark, or system. System follows your device, so the player goes dark at night with everything else. Your pick is remembered on your device and doesn't change anyone else's view.

## A Firefox fix you'll hear

Firefox had a rough edge with the Opus stream: on some track changes the audio would just go silent until you reloaded. We traced it to how Firefox handled the Opus mount mid-stream.

The fix is simple. Firefox now stays on the MP3 mount, which it handles cleanly through track changes. Chrome, Safari, and the rest still get Opus at roughly half the bandwidth. Nothing for you to do; it's the default now.

## Why it helps

Listeners get a player that matches how they like to read a screen, and Firefox users get music that doesn't drop out between songs. Both are the kind of small thing you only notice when it's wrong.
