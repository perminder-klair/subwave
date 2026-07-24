---
title: Run more than one station from a single install
date: 2026-07-24
category: Feature
author: The SUB/WAVE desk
excerpt: Keep several stations in one install, each with its own library, DJs, schedule and settings, and pick which one is on air from the admin sidebar.
---

One install used to mean one station. Not anymore. You can now keep several stations side by side, say a late-night ambient channel next to the daytime one, and choose which of them is broadcasting.

## What's new

Every station gets its own library pool, DJ roster, schedule, jingles and settings, stored as a folder under `state/stations/`. Exactly one station is on air at a time for now; broadcasting several at once, each on its own stream, is on the list for later. Switching restarts the mixer and controller, so listeners drop for about ten seconds and reconnect on their own.

## How to use it

Open admin and look for **Stations** in the System section of the sidebar, or use the new station switcher at the top of the sidebar (the current station's name with a chevron next to it). To create a station, give it a name and pick a starting point:

- **Fresh** starts empty. Make it live and the setup wizard walks you through connecting music and a DJ.
- **Duplicate current** copies your settings, personas, schedule and analyzed library, but starts a clean play history.

The first extra station you create converts the install to the multi-station layout. Your current station keeps playing and nothing about it changes.

To put a different station on air, hit **Make live** (on its card, or straight from the sidebar switcher) and confirm. The page shows a switching screen and reloads once the new station is up.

## Why it helps

The obvious use is a second identity, a weekend jazz channel or a festival pop-up, without renting a second server. The less obvious one is a scratch station: duplicate your real one, point the DJ at a strange prompt, and see what happens. Whatever you break stays inside that station's folder. The station people actually listen to never notices.
