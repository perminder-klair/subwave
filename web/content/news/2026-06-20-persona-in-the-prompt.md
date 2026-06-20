---
title: Why our DJ's personality lives in the prompt, not the model
date: 2026-06-20
category: Spotlight
author: The SUB/WAVE desk
excerpt: You could fine-tune a DJ's voice into a model's weights. We didn't. The persona is config you can swap in a minute, and stock local models already run the picker well.
---

There's a clever project called Linden that trains a whole radio-DJ personality straight into a model's weights. One model, one voice, trained in. We looked hard at doing the same for SUB/WAVE, then went the other way. Here's why, and the testing that backed the call.

## Persona is config, not weights

A SUB/WAVE DJ is a set of "souls": short written personalities you edit in admin. Keep up to ten and the DJ picks one at random per turn, so the station never settles into a single note. Change a soul, save, and the next link comes out in the new voice. No training run, no model swap, no redeploy.

Bake a persona into the weights instead and you get exactly one DJ, welded to exactly one model. That cuts against the whole point: pick your own voice, and pick your own brain, separately.

## We tested the cheaper path

Skip the fine-tune and the open question is whether a plain local model is good enough to run the DJ. So we measured it. On locca, two stock models (gemma-4-12b and qwen3.5-9b) both ran the track picker reliably. While benchmarking we also caught a routing quirk that made every pick do one wasted model call, and fixing it cut picker time by roughly half.

## Why it helps

You keep both freedoms. Swap the persona from admin in under a minute, and swap the model underneath it whenever you like, from a local box to a cloud one and back. The DJ you hear is yours to rewrite, not a voice frozen into a download.
