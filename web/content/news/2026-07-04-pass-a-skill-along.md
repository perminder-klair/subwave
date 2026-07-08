---
title: Pass a skill to another station
date: 2026-07-04
category: Feature
version: v0.35.0
author: The SUB/WAVE desk
excerpt: Skills can move between stations now. Browse the community catalog in admin, share your own with one button, or hand a zip straight to another operator.
---

You spent three evenings getting a skill's brief just right, and now the DJ lands the line every time. Until now, the only way to give that to a friend's station was to paste the file into a chat and hope they dropped it in the right folder. Skills travel properly now, three ways.

## Take one from the catalog

The admin Skills page has a Community button, next to New skill. It opens a catalog of skills other operators have contributed, shipped inside the controller image, with a credit line under each one (who wrote it, when it landed). Hit Install and it copies into `state/skills/` like any skill of your own. It arrives switched off, so you can read the brief before it goes on air. The catalog only carries prompts, never code, so installing one runs nothing.

## Put yours in

A skill with no `tool.mjs` shows a Share to community button on its edit sheet. That opens a prefilled GitHub issue; a check runs on the name and fields, then a one-file pull request appears for review. Once merged, your skill ships in the next release and turns up in everyone's catalog with your GitHub handle on it.

## Or hand over a zip

For a direct handoff, hit Export on the edit sheet and you get a `.zip` of the whole skill. The other operator brings it in with Import .zip in the Community window. A zip can carry a `tool.mjs`, which is code, so this route is for people you trust. The import lands switched off, and the page flags it when there is a tool inside. Read it before you flip it on.

## Why it bothers

The bits between tracks are where a station gets its personality, and a good brief takes real fiddling to get right. Two community skills are in the catalog already: a two-line micro-poem sparked by the moment, and a warm aside about taping songs off the radio. There's room next to them.
