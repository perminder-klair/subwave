# Music sources compared

SUB/WAVE's music library is **pluggable**: one active source at a time, chosen
in **Admin → Settings → Music source** (or in the onboarding wizard). Three
sources ship today:

- **Navidrome / Subsonic** (default) — a Subsonic-API streaming server on your
  network. The full-featured source.
- **Local folder** — a plain directory of audio files, no server at all. Drop
  files into `state/music` (or point `MUSIC_DIR` elsewhere) and hit Rescan.
- **Plex** — a Plex Media Server over its HTTP API (`PLEX_URL` + `PLEX_TOKEN`,
  optionally `PLEX_LIBRARY` to pin the music section).

Every part of SUB/WAVE talks to the library through one facade
(`controller/src/music/source.ts`), and each source declares what it can serve
in a capability table (`controller/src/music/sources/capabilities.ts`). When a
source lacks a capability, the facade returns a neutral empty and the DJ's
picker simply never offers the corresponding tool — nothing breaks, the station
just has fewer discovery signals to draw on. This page is the honest rundown of
what each source can and can't do.

## TL;DR

| | Navidrome / Subsonic | Plex | Local folder |
|---|---|---|---|
| Playback, search, browse, genres, random | ✅ | ✅ | ✅ |
| **Mood tagger** | ✅ full | ✅ (no lyrics signal) | ✅ (no lyrics signal) |
| **Acoustic analyzer** (bpm/key/embeddings) | ✅ | ✅ | ✅ (fastest — no download) |
| Last.fm similar-songs graph | ✅ | ❌ | ❌ |
| Sonic similarity (OpenSubsonic) | ✅ | ❌ | ❌ |
| Playlists | ✅ | ✅ | ❌ |
| Starred / loved tracks | ✅ | ✅ (rated ≥3★) | ❌ |
| Top songs per artist | ✅ (Last.fm rank) | ✅ (play count) | ⚠️ shuffled sample |
| Recently-added albums | ✅ | ✅ (`addedAt`) | ✅ (file mtime) |
| Frequently-played albums | ✅ | ✅ (play count) | ⚠️ random sample |
| Artist bio / info | ✅ | ❌ | ❌ |
| Last.fm crowd tags (tagger enrichment) | ✅ | ✅ | ✅ (direct API, needs `LASTFM_API_KEY`) |
| Lyrics | ✅ | ❌ | ❌ |
| Stable track ids | ✅ (server DB) | ✅ (ratingKey) | ⚠️ path-derived (tags survive via metadata matching) |

**Rule of thumb:** Navidrome gives the DJ the richest ear (the Last.fm
similarity graph, bios for on-air patter, lyrics-informed mood tags). Plex
keeps the *listening-history* signals — playlists, ratings, play counts — but
loses the Last.fm graph. The local folder is the floor: tag-derived discovery
only, which makes SUB/WAVE's own mood tagger and acoustic analyzer the primary
smart-selection engine there.

## The core contract — identical on all three

A source is unusable without these, so all three implement the full set:
health ping, song search, artist search, get song / album / artist by id,
genre list, songs-by-genre, random songs (with genre/year filters), album
browsing, whole-library iteration (what the tagger and analyzer walk), a
playable URI for Liquidsoap, cover art, and an audio reference for the
analyzer.

That means the *station itself* — playing music, taking requests, the library
UI, tagging, analysis, the auto playlist — works the same on every source.
What differs is purely the **discovery tier**: the extra signals the DJ's
picker can consult when choosing what to play next.

## Discovery — where they diverge

### Navidrome / Subsonic

Everything is on. Navidrome layers a Last.fm integration over your library, so
the picker gets **similar songs** (the single strongest "what fits next"
signal), **artist info/bios** (the DJ quotes these on air), and **lyrics**
(feeds the mood tagger). Navidrome also implements the OpenSubsonic
**sonic similarity** extension (probed at runtime), plus playlists, stars,
Last.fm-ranked top songs, recently-added and most-played albums.

### Plex

A real server with real listening history, minus the Last.fm layer:

- **On:** playlists, starred (a track rated **3★ or higher** counts as
  starred), top songs per artist (ranked by Plex play count / `viewCount`),
  recently-added (`addedAt`), frequently-played albums (play count).
- **Off:** similar songs, sonic similarity, artist bios, lyrics — the PMS API
  doesn't expose these in a shape the picker can consume.

Configured via `.env`: `PLEX_URL`, `PLEX_TOKEN`, and optionally `PLEX_LIBRARY`
to pin a music section. The URL must be reachable from the **broadcast**
container too — Liquidsoap fetches the audio itself over curl.

### Local folder

No server, so anything that needs an account, a database, or an external graph
is off: no similar songs, no playlists, no stars, no bios, no lyrics.
What remains is derived from the files themselves:

- **Recently-added** uses file mtime — genuinely useful.
- **Top songs per artist** is a shuffled sample of that artist's tracks, and
  **frequent albums** is a random album sample — heuristics that keep the
  picker's prompts working, not real popularity data.
- Tags (`artist`, `album`, `genre`, `year`, embedded art) are read at scan
  time; a sidecar `cover.jpg`/`folder.png` next to the files also works.

Scans are cheap after the first pass: the scanner diffs on `(mtime, size)`
against a persisted cache, so restarts and rescans only stat files. Rescan
from **Admin → Settings** (or `POST /library/local/rescan`); a periodic rescan
also runs in the background.

## The mood tagger on each source

The tagger (`npm run tag`, or admin → Library) walks the whole library through
the facade and asks the LLM to assign mood tags, enriching each track with
external context first. It runs on **all three sources**; two enrichment
inputs differ:

| Tagger input | Subsonic | Plex | Local |
|---|---|---|---|
| File tags (artist/album/genre/year) | ✅ | ✅ | ✅ |
| Last.fm crowd tags | ✅ | ✅ | ✅ |
| Lyrics excerpt | ✅ | ❌ | ❌ |

- **Last.fm crowd tags work everywhere** — deliberately. The tagger doesn't ask
  the music server for them; it calls the Last.fm REST API directly
  (`controller/src/music/lastfm.ts`) with your `LASTFM_API_KEY` (the same key
  used for scrobbling; enrichment doesn't require scrobbling to be on). So Plex
  and local libraries get the same crowd-tag signal as Navidrome.
- **Lyrics are Subsonic-only.** On Plex and local the facade returns an empty
  string and the tagger simply tags without the lyrics signal — slightly
  coarser mood calls on lyric-heavy material, nothing else.

## The acoustic analyzer on each source

The analyzer (the `analyzer` sidecar — bpm, musical key, intro length,
loudness, and in the heavy tier CLAP "sounds-like" embeddings and Demucs vocal
ranges) has **full parity on all three sources**. It only needs library
iteration plus an audio reference, and both are core:

- **Subsonic and Plex** hand back a **URL**; the controller downloads each
  track to a capped temp file on the shared volume ahead of the DSP so network
  fetch overlaps compute.
- **Local** hands back the **file path directly** — the analyzer reads it off
  the shared mount with no download step at all, making local the fastest
  library to analyze. (The analyzer only ever deletes its own temp downloads,
  never a path a source returned — your files are safe.)

This parity is load-bearing: on Plex and local, where the Last.fm
similar-songs graph is unavailable, **mood tags + acoustic embeddings are what
keep the DJ's picks intelligent**. If you run those sources, running the
tagger and analyzer isn't optional polish — it's the discovery engine.

## What the DJ actually loses per source

The picker builds its candidate pool from several legs and the DJ agent gets a
toolbox filtered by capability, so degradation is graceful:

- **On Navidrome**: similar-songs and sonic-similarity legs dominate; bios and
  lyrics colour the on-air scripts.
- **On Plex**: the similarity legs vanish; playlists, stars, and play-count
  ranking take their place, alongside mood/embedding picks.
- **On local**: only genre, random, recently-added, artist and
  mood/embedding-based legs remain. The picker still works — it just leans
  entirely on what the tagger and analyzer have built.

No call site branches on the source id; tools the source can't serve are
never offered to the LLM, so the DJ never wastes a turn calling a dead tool.

## Caveats when switching sources

- **Track-id stability.** Mood and analysis rows are keyed by track id.
  Subsonic ids come from the server's database and Plex ids are ratingKeys —
  both stable. **Local ids are derived from the file's relative path**, so
  moving or renaming a file re-mints its id. Reconcile absorbs this: an
  orphaned row is matched to the live track with the same artist/title/album
  (one-to-one, duration-checked) and its tags, analysis and embeddings are
  carried to the new id before anything is pruned. The same rescue applies
  when a Navidrome full rescan re-mints its ids.
- **Reconcile migrates first, then prunes for the *active* source.** After a
  source switch, rows whose metadata matches between the two sources carry
  their tags and vectors across; rows the active source can't match are
  removed. Re-tag/re-analyze whatever didn't match (sources that tag the same
  files differently — a different album name, say — won't line up).
- **Reachability spans containers.** Whatever serves the audio must be
  reachable from the **broadcast** container (Liquidsoap fetches tracks
  itself) and, for analysis, from the **analyzer**. The local folder must be
  bind-mounted at the *same* path into controller, broadcast **and** analyzer
  (the default `state/music` already is).
