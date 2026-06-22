---
title: One-click install on Unraid
date: 2026-06-22
category: Announcement
version: v0.26.1
author: The SUB/WAVE desk
excerpt: SUB/WAVE is now in the Unraid Community Applications store. Search it in the Apps tab, fill in four fields, and the whole station runs from a single container.
---

SUB/WAVE is now in the Unraid Community Applications store. If you run Unraid, you can install the whole station from the Apps tab the same way you'd add any other container. No compose file to paste, no .env to hand-edit.

## What's new

There's a new all-in-one image. Icecast, Liquidsoap, the DJ controller, the web player and the Caddy front-end all run inside one container on one port. The Apps store only lists single-container apps, so this image is what makes a one-click listing possible. It's the same code as the multi-container setup, just packed together.

## How to use it

Open the Apps tab, search for SUB/WAVE, and hit Install. Four fields to fill in:

- WebUI Port, the host port for the player and stream (7700 by default)
- Appdata, a path on your array or pool like `/mnt/user/appdata/subwave`
- ADMIN_USER and ADMIN_PASS, your admin login
- SITE_URL, set to `http://YOUR-UNRAID-IP:7700`

Apply, then open the WebUI and go to `/onboarding` to point it at your Navidrome server and pick a voice and an LLM. Keep Appdata on your array or pool, not the USB flash. The station's recordings and library cache grow over time, and the flash is the wrong place for that.

No big GPU? That's most Unraid boxes. Install the official ollama container, run `ollama signin` in its console, and pick a cloud model. A small local model works too if you'd rather keep everything on the box.

## Why it helps

Running SUB/WAVE on Unraid used to mean the Compose Manager Plus plugin: paste a compose file, set an .env, pick the right pull option. That route still works, and it's still the one to use if you want the split containers or your own reverse proxy. For everyone else, a search and four fields is a much shorter trip from "I heard about this" to a DJ on the air.
