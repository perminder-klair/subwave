---
title: "The Cloud Edition"
date: 2026-11-22
category: Announcement
author: Parminder Klair
excerpt: SUB/WAVE now has a paid side, and a page that says so. DJ Brain gives a self-hosted station a model and a voice on one key, and Hosted runs the whole station for you. The self-hosted station stays free and open source.
---

This dispatch is about money, so the plain version comes first. SUB/WAVE stays free and open source, and nothing in your station changes. What is new is a paid way to skip the parts of running one that are homework, and a page on this site, [/cloud](/cloud), that lays it out.

## Why there is a paid side

A SUB/WAVE station needs three things besides your music: a language model to pick the tracks and write the links, a voice engine to read them out, and a server to run it all. The default answer is to run all three yourself, on your own hardware. That is still the answer the project is built around.

It is also the part where people get stuck. A good local model wants a GPU. A cloud model wants an account with a provider and an eye on the bill. Some people have neither the box nor the time. The Cloud Edition is for them.

## DJ Brain: keep your server, rent the brain

Your station stays on your box, with your library, exactly as it is. DJ Brain replaces only the model, and on the bigger plan the voice.

- **Brain**, $6 a month: the model that picks the tracks and writes the links. You bring your own voice engine.
- **Brain Studio**, $19 a month: the model plus 8 hours of DJ voice a month.

You get one key from [my.getsubwave.com](https://my.getsubwave.com/pricing). In the setup wizard's model step, press **Use DJ Brain** and paste it in. Behind the key, the brain answers in the same OpenAI-compatible shape SUB/WAVE already speaks, so nothing in your station is special-cased for it. When we change the model behind it, your station picks up the change without an update.

## Hosted: no server at all

Hosted runs the whole station for you at `your-name.subw.app`: the mixer, the stream, the DJ and its voice, with storage for your music.

- **Hosted**, $29 a month: 20 GB for your music, 10 hours of DJ voice and 150,000 listening hours a month.
- **Hosted Pro**, $49 a month: 100 GB, 30 hours of DJ voice and 400,000 listening hours a month.

A listening hour is one listener for one hour, at any bitrate. The limit is soft: going over it never takes your stream off the air.

Every plan can be paid yearly, which costs ten months instead of twelve. If a station talks more than its plan covers, extra voice hours are $2 each, and only once you have turned them on.

## What changes for SUB/WAVE

Nothing in the software. Self-hosting is still the main way to run SUB/WAVE, and the manual and the setup guides still assume it. Ollama on your own box is still the default brain, and Piper is still the default voice.

On this site you will find a **Cloud** link in the masthead, the [/cloud](/cloud) page, and one line in the stack section of the landing page that points to it. All three show only on getsubwave.com. Every install serves the same pages, and the project has no business selling anything on your domain, so they check which site they are on and stay off yours.

The prices on /cloud are read from the same catalog the checkout uses, so they cannot drift from what you are actually charged. If anything here disagrees with [my.getsubwave.com](https://my.getsubwave.com/pricing), the portal is right.
