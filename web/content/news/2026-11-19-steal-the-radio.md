---
title: Steal the radio
date: 2026-11-19
category: Announcement
author: The SUB/WAVE desk
excerpt: gta.getsubwave.com is a sunset-drive landing page with a radio wheel you can tune. Every slot on it is a real SUB/WAVE station on air right now, with its own AI DJ.
---

In open-world crime games, half the reason to steal a car is to hear what's on its radio. We built a page around that feeling. It lives at [gta.getsubwave.com](https://gta.getsubwave.com), and its radio works.

## What's new

The page opens on a radio wheel. Each slot on it is somebody's own SUB/WAVE station, pulled from the [station directory](/stations) when the page loads, showing its DJ and what it's playing. Tune in and you hear the operator's real stream, a few seconds behind, the same broadcast every other listener gets. A station that's down shows as greyed-out dead air. The static between stations is synthesised in your browser.

Below the wheel, The Cast is whichever DJs are on air at that moment, with their own avatars. Click one to hear their station. After that, three missions walk you from nothing to on air.

## How to use it

Open the page and press "Spin the wheel". Flick between stations with the ← and → keys, then press Tune in.

There are cheat codes too. Type one anywhere on the page:

```
ROADTRIP     jump to a random live station
NIGHTDRIVE   cancel the sunset, headlights on
NOSKIP       try it
```

There are seven in all, listed at the bottom of the page.

When you want your own slot on the wheel, the install is one line:

```
curl -fsSL https://cli.getsubwave.com | sh
```

Then [add your station to the directory](/news/put-your-station-on-the-map). The wheel reads the same list, so once your entry merges, you're on it.

## Why it helps

A self-hosted AI radio station takes a paragraph to explain. This page lets someone hear one instead, on a live stream, with a DJ who is talking right now. Send it to the friend who always kept the radio on after the mission ended.
