---
title: Your DJ knows your library
date: 2026-06-06
category: Feature
author: The SUB/WAVE desk
excerpt: The Library page got a rebuild. One panel shows how much of your music is tagged, tagging runs from a single button, and you browse by mood and energy. Swapping your embedding model no longer wedges it.
---

Your DJ can only play a track once it knows that track's mood and energy. Working that out is what tagging does, and the Library page is where you run it. We rebuilt that page so the whole thing makes sense at a glance.

## What's new

The old page had two control strips that both talked about tagging, and neither said why it mattered. Now there's one panel. It opens with a plain line, "Your DJ knows 92% of your library", and under that sits the count of tagged tracks, how many still need it, and one button to close the gap. Every row shows its moods and energy as small tags, so you can see what tagging actually produces. Browse filters by mood, energy, genre, and year.

## How to use it

Open admin and go to Library. The panel up top tells you your coverage. To tag new tracks, pick a batch size and press Start tagging, then watch the count climb as it works. Click a mood chip or the energy control to browse what's already tagged. If the DJ got a track wrong, press Retag on its row for a fresh decision.

Changed your embedding model lately? Open "Maintenance and re-scan" in the same panel and run "Re-embed all tracks". That used to fail and leave tagging stuck with a dim-mismatch error. Now it drops the old vectors, rebuilds them on the new model, and carries on.

## Why it helps

Tagging is what lets the DJ reach for the right track instead of playing at random. The state of it is now in front of you: what's done, what's left, and a button for the rest. And a model swap no longer paints you into a corner, since you re-embed from the same place.
