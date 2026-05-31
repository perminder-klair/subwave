---
title: Teach your DJ a new trick
date: 2026-05-31
category: Feature
version: v0.2.0
author: The SUB/WAVE desk
excerpt: Drop a folder into state/skills and your DJ picks up a new between-track bit, whether a moon phase, a local headline, or whatever you want it to mention.
---

The little things your DJ does between songs, like a weather note, a quick headline, or a daft aside, are what we call skills. A few ship in the box. Now you can write your own, and you don't have to touch the station's code to do it.

## What's new

A skill is one between-track line. The DJ glances at something, then either says a sentence over the intro of the next track or stays quiet. That's the whole job. You add one by dropping a folder into `state/skills/`.

## How to use it

Each skill is a folder with a `SKILL.md` inside. The frontmatter sets the name and how often it can fire; the markdown body is the brief the DJ actually follows: what to say, the tone, when to keep mum.

```
state/skills/
  moon-phase/
    SKILL.md      # frontmatter + the DJ's brief
    tool.mjs      # optional: fetches live data before the DJ speaks
```

There's a ready-made example in the repo at `docs/examples/skills/moon-phase`. Copy it into `state/skills/`, open the admin Skills page, and hit Rescan. Your skill shows up in the list, ready to toggle on.

Want it to react to real data? Add a `tool.mjs` and the DJ can check something live, like tonight's moon or the surf report, before it opens its mouth.

## Why it bothers

Your station starts to sound like yours. The bits between tracks stop being generic and start being the things you actually care about, in the voice you picked.
