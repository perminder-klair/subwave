---
title: Play from Jellyfin, Plex or a folder
date: 2026-11-27
category: Feature
author: Parminder Klair
excerpt: SUB/WAVE is no longer Navidrome-only. Pick Navidrome, Jellyfin, Plex, a source plugin or a demo library on one page, and when you switch, your tags and likes follow the music.
---

Since the first release, SUB/WAVE has had one rule about music: it plays your own library, never a catalogue. Until now that library had to live in Navidrome. A lot of you asked about Jellyfin and Plex instead, and running a second music server just to feed the radio is a hard sell when one is already on your shelf.

So the station now plays from whichever one you run.

<video controls playsinline preload="metadata" poster="/video/play-from-jellyfin-plex-or-a-folder.webp" aria-label="A 35-second animation of a rack of music sources: Navidrome, Jellyfin, Plex, a music folder and an installed plugin. A red cable moves from one source to the next, carrying tags for likes, mood tags, analysis and the blocklist, then feeds several sources into one on-air station">
  <source src="/video/play-from-jellyfin-plex-or-a-folder.mp4" type="video/mp4">
</video>

## Where is your music?

There is a new page in the admin: **Music source**. It opens on one question, *where is your music?*, with a card for each answer:

- **Navidrome**, connected directly, exactly as before. Any Subsonic-compatible server works the same way.
- **Jellyfin**, with its favourites and playlists. You need the server URL and an API key.
- **Plex**, including its sonic analysis for similar tracks when your server has it. You need the server URL and a token.
- **Installed plugins**, for anything else. The example plugin plays a plain folder of files.
- **Demo library**, generated tones with no setup at all.

The setup wizard's first step asks the same question with the same cards. If you don't have a music server ready yet, pick the demo library, hear the DJ, the jingles and the mixer working within minutes, and connect your real library later.

## Switching keeps what you built

A station builds up a lot of knowledge about its library: mood tags, audio analysis, the songs you liked, the ones you blocked. All of it is keyed by track ids, and every server numbers its tracks differently. Moving servers used to mean starting over.

Now a switch is a step of its own. Pick a card and press **Switch to Jellyfin…**, and SUB/WAVE:

1. **Tests the connection first.** A wrong key or a server that doesn't answer stops it there, with the reason, and the station stays on what it plays now.
2. **Tells you what will happen**, including how many songs the new library has, and asks you to confirm.
3. **Moves your library across in the background**, matching every track by artist, title, album and length, with its progress on the page. Tags, analysis, likes and the blocklist follow each track as it is matched.

The station starts playing from the new library the moment you confirm. If the new server is one you set up a few minutes ago and it is still reading its files, SUB/WAVE carries what it can and finishes the move once the scan ends.

Tracks the new library doesn't have are kept out of the rotation, not deleted. Switch back and they return with their tags. When you're sure they're gone, remove them from the Library page.

## For Navidrome stations: nothing changes

If your station plays from Navidrome, it keeps talking to Navidrome directly, the same way it always has. Two things you will notice:

- Your stack gains one service, `router`. It does nothing until you choose a source other than Navidrome. If you update with plain `docker compose pull`, fetch the new compose file first so the service is there. With the CLI, `subwave sync` before `subwave update` does that for you.
- *Settings → Music source* moved to its own page, **Admin → Music source**. Old links and bookmarks forward there.

## Under the hood

Jellyfin, Plex and the rest are served by the **music router**, a small service that speaks the same Subsonic API SUB/WAVE has always used, and answers it from a *source plugin*. That is why nothing else in the station had to change: the DJ, the mixer and the analyzer can't tell which server is behind it.

The Music source page also has three tabs for when you want to look inside:

- **Source channels** shows each source's health, size and response time.
- **Signal path** follows the station's live requests to its library: which source answered, how long it took, and why one failed.
- **Service matrix** shows which features each source supports.

Not every server offers every signal (Plex has no lyrics, a folder of files has no genres), and a missing feature never stops the music. The DJ just has fewer discovery signals to work with.

## Good to know

- **Combining libraries** (Jellyfin and Plex as one station, say) is under *Advanced* and experimental. Nothing is de-duplicated, so an album both servers hold appears twice.
- **Plugins are code** that runs in the router. Install only ones you've read and trust. Writing your own is one manifest and one JavaScript file; the [plugin guide](https://github.com/perminder-klair/subwave/blob/main/docs/music-source-plugins.md) has the contract, a worked example and a conformance kit.

The [Music sources](/manual/music-sources) page in the manual has the details.
