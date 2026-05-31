---
title: The DJ runs on whatever brain you give it
date: 2026-05-18
category: Spotlight
author: The SUB/WAVE desk
excerpt: SUB/WAVE talks to a local Ollama model out of the box, with no API key. Want a cloud model instead? Switch provider in admin and every call reroutes, no redeploy needed.
---

The DJ's banter, its track picks, the way it reads the room: all of that comes from a language model. SUB/WAVE doesn't lock you to one. You choose which model thinks for your station, and you can change your mind whenever.

## What you get by default

Fresh installs talk to a local [Ollama](https://ollama.com) box. It needs no API key and nothing leaves your network, so the station works fully offline and fully private from the first boot. A homelab model is slower than a cloud one, but it's reliable and it's yours.

## How to switch

Open admin, go to the LLM settings, and pick a provider:

- Ollama (local, the default)
- Any OpenAI-compatible server (llama.cpp, vLLM, LM Studio) by pasting its base URL
- OpenAI, Anthropic, Google, DeepSeek, OpenRouter, or the Vercel AI Gateway

Drop in a model name and an API key if the provider needs one, then save. That's it. Every call the DJ makes reroutes to the new model immediately, whether that's picking the next track, writing an intro, or matching a request. No rebuild, no restart, no code change.

## Why it matters

You get to tune the trade-off yourself. Run a small local model and keep everything on your own hardware. Or point it at a sharper cloud model when you want quicker, wittier links between songs. Same station, different brain, swapped in under a minute.
