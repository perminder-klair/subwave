---
title: Install a skill, a DJ, or a whole show
date: 2026-07-13
category: Feature
author: The SUB/WAVE desk
excerpt: The community catalog is live. Browse skills, DJ personas, and now whole shows other stations have shared, and install any of them from admin without a software update.
---

Community skills and personas used to be baked into each release, so you only saw new ones when you updated the software. That changed. Your station now reads the community catalog live, and shows are in it for the first time.

## What's new

The catalog is one shared place operators publish three kinds of thing:

- Skills, the short between-track segments your DJ can run.
- DJ personas, a full character with its own voice and temperament.
- Shows, new here. A ready-made template: a standing brief plus the music filters that steer it.

Your controller pulls the catalog on its own and refreshes it in the background, so a persona someone merged this morning is installable from your booth this afternoon. No update, no restart.

## How to use it

Open admin and pick Skills, Personas, or Shows. Each panel has a Community button. Click it, browse what people have shared, and hit Install.

- A skill installs switched off. Read it first, enable it when you want it on air.
- A persona joins your roster with a default voice, ready to edit.
- A show installs unscheduled with your active DJ as host. Give it a persona and paint it into the weekly grid.

To share your own, the public pages at `/skills`, `/personas`, and `/shows` each have a Share button. It opens a short form, a bot turns that into a pull request on the catalog, and once a maintainer merges it, every station can install it.

Running your own catalog, or a fork? Point your station at it and everything above reads from there instead:

```
COMMUNITY_CATALOG_URL=https://raw.githubusercontent.com/you/your-catalog/main/catalog.json
```

## Why it helps

A good segment or a well-tuned DJ used to live and die on the one station that built it. Now it can travel. You write a show once and anyone can run it, and their work lands in your admin the same way. The booth gets deeper without you writing a line.
