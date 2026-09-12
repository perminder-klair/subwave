# Spotify as the music source

> **Experimental.** Works end to end in this fork; not a Spotify-endorsed
> integration. It uses [librespot](https://github.com/librespot-org/librespot),
> an open-source Spotify Connect client, whose README says connecting to
> Spotify this way "is probably forbidden by them". You need your own basis
> for using it (a Premium account and, for restreaming, whatever agreement
> covers your station). SUB/WAVE ships no credentials and no audio.

SUB/WAVE's music backend is pluggable (`settings.music.source`). With
`spotify` selected, the AI DJ picks from Spotify's catalog, the picks play on a
Spotify Connect receiver that runs **inside the broadcast container**, and the
audio flows into the same Liquidsoap mixer as always — jingles, DJ talk,
requests, scheduling, the web player and the Icecast stream all keep working.
Nothing runs on your desktop, no virtual audio cable, no OBS.

```
AI DJ picks track B ─▶ controller ─▶ Spotify Web API: play B on "SUB/WAVE"
                                              │
                          broadcast container │
                          ┌───────────────────▼──────────────────────┐
                          │ librespot (Spotify Connect receiver)     │
                          │   └─ PCM ─▶ Liquidsoap music input       │
                          │   └─ events ─▶ spotify-player.json ─▶ controller
                          │ Liquidsoap: + DJ voice + jingles ─▶ Icecast
                          └──────────────────────────────────────────┘
```

## What you need

- A **Spotify Premium** account (Connect playback is Premium-only).
- A **Spotify Developer app** at <https://developer.spotify.com/dashboard>:
  create one, tick *Web API*, and add the redirect URI the admin page shows
  (`<your SITE_URL>/api/settings/spotify/callback`). Copy the client id and
  secret.
- A broadcast image built from this fork (librespot is compiled into it:
  `docker compose build broadcast`, or pull the fork's published image).

## Setting it up

Best done on a **fresh station profile** (see `docs/multi-station.md`): every
music source keeps its own `library.db`, and a Spotify library holds Spotify
track ids where a Navidrome library holds Navidrome ids.

1. **Admin → Settings → Music source** — choose *Spotify*. The mixer needs a
   restart after this (the banner offers it); the mixer boots in Spotify mode
   from then on.
2. Paste the **client id** and **client secret**, *Save credentials*.
3. **Connect Spotify** — you are sent to Spotify's consent screen and back.
   This stores a refresh token in `state/secrets.env` and writes a first
   access token for the receiver to `state/spotify/token`.
4. *Test* should report your account name and `premium`.
5. **Library pool** — paste the playlists the station may draw from (ids,
   `spotify:playlist:` URIs or links, one per line; empty = every playlist the
   account owns or follows) and choose whether saved tracks / albums count.
   *Rebuild pool now* shows how many tracks it found.
6. **Sign the receiver in** (Playback card). This is a second, separate login:
   the receiver (librespot) talks to Spotify as Spotify's own desktop client,
   and a token from your Developer app is refused at the Connect handshake
   (`INVALID_CREDENTIALS`). Spotify sends the browser to
   `http://127.0.0.1:5588/login` afterwards, which is librespot's registered
   redirect, not yours:
   - with `docker compose -f docker-compose.yml -f docker-compose.spotify.yml`
     the controller is published on that loopback port and completes the
     sign-in itself, bouncing you back to the settings page;
   - without the overlay the page fails to load — copy the whole address from
     the address bar into *Finish sign-in*.
   The token lands in `state/spotify/token`; librespot caches reusable
   credentials on its next start and the controller renews the token from its
   refresh token, so this is a one-time step.
7. Restart the mixer if you have not yet. Within a few seconds the receiver
   (named `SUB/WAVE`, or `spotify.deviceName`) appears in your Spotify apps'
   device list, and the station starts playing from the pool. The DJ's picks
   follow. The receiver's name is deliberately not the station name: the
   receiver keeps the name it booted with, and renaming the station must not
   orphan it.

Optional: run the tagger (*Library → Tagging*) over the pool. Text tagging
needs no audio, and it is what gives the picker mood tools on Spotify.

### Environment alternative

For IaC-style installs the three secrets can live in the root `.env`
(`SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN`,
optionally `SPOTIFY_REDIRECT_URI`). Env always wins; the admin fields then
show as env-managed.

## How a track plays

The controller never lets Spotify choose. It commands each track on the
receiver over the Web API, learns from librespot's own events when it
actually started, and then tells the mixer — which inserts a real track
boundary carrying the title/artist/album/id. From there everything is the
station's normal path: `now-playing.json`, the ICY title, the DJ link ducking
the intro, scrobbles, webhooks, the next pick. Autoplay is never enabled on
the receiver.

- **Seam**: the next track is commanded `spotify.seamLeadMs` (default 1.5 s)
  before the current one ends, or the instant the player reports it ended.
  Tracks meet at a hard cut; the DJ's link plays over the incoming intro as
  usual.
- **Nothing picked in time**: the transport plays a random track from the pool
  (the equivalent of `auto.m3u`) and says so in the booth log.
- **Jingles**: automatic and manual jingles work unchanged — they play at the
  boundary, and the receiver simply waits (the pipe back-pressures) and resumes
  from the same sample afterwards.
- **Someone moves playback to a phone**: `spotify.mismatch` decides —
  *reclaim* (default) transfers playback back and plays the DJ's pick once,
  then adopts what is playing if that fails; *follow* adopts immediately and
  publishes the real track so now-playing is never wrong for long.
- **Operator skip** (`/dj/skip`) commands the next pick immediately.

## When Spotify refuses a track

Some tracks will not play on your account — a licence that lapsed in your
country, a release pulled from the catalogue, a regional restriction. **Spotify
gives the station no way to know this in advance.** February 2026 removed
`available_markets` and the `/markets` endpoint, and without a market parameter
the API never fills in `is_playable`, so every track looks playable until it is
tried. The station finds out the same way you would: by pressing play.

What happens then:

1. **It is remembered.** The track id goes into `state/spotify/unplayable.json`
   and is filtered out of every pick path at once — the DJ agent's tools, the
   pool picker, listener-request matching and the transport's own pool fallback.
   Without this the picker simply chose it again on the next cycle; on one real
   run the same track was picked, commanded and refused **212 times in a row**,
   an LLM call and a play command each, with the auto playlist covering the air.
2. **One other release is tried.** The station searches for the same recording
   on a different release — a remaster, a deluxe edition — and plays that
   instead, keeping the DJ's link intact because the title and artist match. A
   live version, a karaoke backing or a remix is never accepted as a substitute.
   That search is a single request, is skipped entirely while Spotify is rate
   limiting the station, and happens at most once per pick.
3. **If there is no playable release, the slot moves on** and the DJ picks
   something else.

Refusals are forgotten after **30 days**, in case the licensing comes back, and
admin → Music source shows the count with a **Forget refused tracks** button if
you want them back sooner. Both are free — the pool snapshot on disk keeps the
rows a refusal only withholds, so nothing has to be re-walked. The one cost is
that a track held back is also absent from the tagger's view of the library, so
it will be re-tagged when it returns.

Turn on **Seam tracing** in the same admin section to watch all of this happen —
every player event, every seam decision, every candidate the substitute search
considered and why it was rejected. It takes effect immediately, needs no
restart, and writes to the controller's container log (`[spotify+]`) and to
`state/logs/events-*.jsonl`, never to the booth log.

## What is different from Navidrome

Spotify exposes no audio file, so everything the acoustic analyzer derives is
off: BPM/key, measured loudness, intro/outro analysis, silence trim, CLAP
"sounds-like" search and sonic journeys, vocal-aware links, stem blends,
ending-aware crossfades and the DJ transition effects (the mixer bypasses
`cross` in this mode). Loudness normalisation comes from Spotify's own
ReplayGain data via librespot instead. Also off: Last.fm similar-songs and the
OpenSubsonic sonic extension (the picker tools for them are simply not
offered), lyrics, Navidrome scrobbling/starring, playlist editing, beds.

Spotify's own **February 2026 API restrictions** take a further slice, for every
app that is not in extended quota mode:

- **an artist's top songs are gone entirely** (`/artists/{id}/top-tracks` was
  removed with no replacement, and `popularity` went with it), so the
  `topSongsByArtist` picker tool is not offered on Spotify;
- **the pool can only be built from playlists this account owns or collaborates
  on** — a followed playlist gives its name and cover but no tracks;
- **search answers ten results a page** instead of fifty, so wide searches page;
- **the account tier is no longer readable**, so *Test* can confirm who you are
  but not that you are Premium. Connect playback still requires it;
- **artist genres arrive gradually.** Spotify tags artists rather than tracks and
  the batch lookup is gone, so genres cost one request per artist. The station
  fills them as a **background drip** (`spotify.quota.genresPerHour`, default
  750), busiest artists first, and remembers the answers on disk
  (`state/spotify/artist-genres.json`) — so coverage climbs over a few hours and
  then costs nothing, surviving restarts. The drip runs on its own rather than
  inside a pool rebuild, so it keeps going between rebuilds and picks itself back
  up after a rate-limit pause. The Library pool card shows the progress. Genre
  shows and genre-based picking sharpen as it fills.

**You cannot leave Development Mode**, and you should not try. Since 15 May 2025
Spotify accepts extended-quota applications only from **organisations** — a
registered business with a launched service and at least 250k monthly active
users. A personal station cannot qualify. Development Mode is fine here: its
user allowlist only needs to hold you.

What binds is the **rolling 30-second request window** — and, since **23 July
2026**, a quota counted per developer **account** rather than per app, shared by
every app that account owns. Spotify publishes no number for either. So the
station does three things instead of retrying harder:

- **it paces itself.** A ceiling on non-critical requests per rolling 30 seconds
  (`spotify.quota.requestsPer30s`, default 90) that **halves whenever Spotify
  refuses one and eases back over quiet windows** — since no figure is published,
  the only correct ceiling is one that finds the real limit. Playback commands
  are exempt and never wait: the music does not stop for a quota.
- **it asks for less.** The pool is saved to disk, so a restart costs nothing,
  and a refresh re-reads only the playlists whose Spotify `snapshot_id` moved —
  a handful of requests where a full walk costs one per fifty tracks. A full walk
  still runs on `spotify.pool.fullWalkHours` (default 24). Albums and searches
  the DJ keeps asking for are remembered too: an album's tracks used to cost a
  request every time a pick looked at it (the picker fans out over five to
  fourteen albums *per track it picks*), and one search is three requests because
  a page holds ten results, so the same query recurring across picks was the
  single largest repeat bill. The Library pool card shows how many are being
  reused.
- **it stops when told.** When Spotify says stop, catalogue requests stand down
  together, the hold is **written to disk so a restart respects it**, and the
  admin page shows the countdown — labelled *rate limit* or *quota*, which are
  different things with different waits.

**A hold is a deadline, and it always counts down.** Playback commands are
exempt from the hold so music never stops — and because they are exempt, their
own refusals are *reported but never allowed to extend it*. (An earlier build
let them, which meant a player command every couple of minutes kept pushing the
deadline out: the station sat locked out for a day, restarts included. If you
are on that build, the symptom is a hold that never reaches zero.) A hold you
believe is wrong can be cleared: **Settings → Music source → Library pool →
Clear hold**, or delete `state/spotify/rate-limit.json` and restart. Clearing
does not make Spotify more willing — it lets the station ask once and find out.

The **Test** button is exempt too. A diagnostic you cannot run during an outage
is a diagnostic you do not have.

Everything else is on: the agent and pool pickers, text tagging and
embeddings over the pool, era filtering (album-level; compilations read as
unknown-year as they do on Navidrome), requests, ducked links/idents/banter/
programmes, jingles, sfx, likes, webhooks, Last.fm/ListenBrainz scrobbling,
all skins, the MCP server.

Settings under `spotify`: `deviceName`, `bitrate` (96/160/320), `pool.*`
(including `pool.fullWalkHours`), `quota.requestsPer30s`, `quota.genresPerHour`,
`seamLeadMs`, `mismatch`. Device name and bitrate are
receiver launch flags and need a mixer restart; the rest apply live.

## Troubleshooting

| Symptom | Where to look | Likely cause |
|---|---|---|
| Emergency loop on air, `/state` says `musicStarved` | `docker compose logs broadcast` (`librespot-run:` lines) | receiver not running: not connected yet, token stale, or the image lacks librespot |
| `librespot-run: no cached credentials and no token file` | admin → Music source → Playback | *Sign the receiver in* has not been done on this station |
| `could not initialize spirc: … INVALID_CREDENTIALS` in the broadcast log | Playback card | the token file holds a Developer-app token (older build) — *Sign the receiver in*; a newer token replaces the stale credential cache |
| Pool builds to **0 tracks**, booth log says `nothing to play … the pool is empty` | admin → Music source → Library pool (it names the reason) | Spotify serves playlist CONTENTS only for playlists the connected account **owns or collaborates on** — a followed or someone else's playlist resolves its name and returns nothing. Put the tracks in a playlist this account owns, or turn on saved tracks/albums |
| `Refresh token revoked` on the RECEIVER, hourly | Playback card | the receiver sign-in has expired — *Sign the receiver in* again. (Fixed at the source since the refresher now persists Spotify's rotated token; a token stranded by an older build still needs one manual re-sign-in) |
| `receiver "…" not among the account's devices` | **`state/logs/librespot.log` in the broadcast container** | the receiver is not logged in. Liquidsoap owns the wrapper's stderr and never forwards it, so that file is the only record of why — `docker exec sub-wave-broadcast tail -50 /var/sub-wave/logs/librespot.log`. An **empty** log is itself the answer: the image has no librespot. `docker compose build broadcast` — the compose file also names a published upstream image, which does not carry it |
| Test can't say whether the account is Premium | — | expected: Spotify removed `product` from `/me` in February 2026. Premium is still required, it just cannot be probed |
| Any Web API call answering **403** on an endpoint that used to work | `docker compose logs controller` (`[spotify] GET … → 403 …`) | the February 2026 Development Mode restrictions removed a slice of the API. The station targets the new surface; a 403 on something else means another endpoint went the same way |
| `rate limited … holding every request for Ns`, once | admin → Music source → Library pool | normal and self-healing: Spotify's rolling 30s window. Every request in the controller stands down together and genre enrichment resumes when it clears. One line per window — a *flood* of 429s means an older build |
| `the developer account's Web API QUOTA is exhausted`, and the card says *quota* not *rate limit* | Library pool card, and your other Spotify apps | a different limit: since July 2026 the Development Mode budget is counted per developer **account** and shared by every app on it. Waiting is the fix — the hold survives a restart on purpose. If it recurs, lower `spotify.quota.genresPerHour`, raise `spotify.pool.fullWalkHours`, or check what else is spending the account's budget |
| A hold that **never counts down**, and is still there after a restart | Library pool card | an older build, where a playback command's own refusal could push the deadline out — and playback is never gated, so it did that forever. Update, then *Clear hold* (or delete `state/spotify/rate-limit.json`) |
| Artist genres stuck at the same number | Library pool card — it now says WHY | the drip is paused or off, and the card says which. Check for a rate-limit/quota line, and that `spotify.quota.genresPerHour` is not 0. It fills continuously in the background — no rebuild is needed and *Rebuild pool now* will not speed it up |
| Banner: *Can't reach Spotify* with a rate-limit reason | — | not an outage and nothing to reconnect. **Do not disconnect or re-enter credentials over a hold** — that rebuilds the pool for no reason. It clears itself |
| Pool card says *from the saved snapshot*, and the tagger reports a skipped prune | Library pool card | expected right after a restart: the pool was restored from disk (which is why the station was playing immediately) and has not been re-checked against Spotify yet. The next refresh clears it. The tagger never deletes against a view it has not confirmed itself |
| Receiver missing from the device list | `spotify.deviceName`, `docker compose logs broadcast` | librespot not authenticated; the name is matched case-insensitively |
| Picks never start, booth log says `no-device` | as above | the receiver is down; picks stay queued until it returns |
| `unavailable` in the booth log | admin → Music source, the refused-tracks line | not playable on this account or market. Expected on any library of size, and self-correcting: the id is remembered so nothing picks it again, one other release is tried, and it is forgotten after 30 days. **Forget refused tracks** puts them back at no quota cost |
| Silence but `/state` transport shows `playing` | `state/spotify-audio.json` | receiver stalled; the transport re-commands after the idle window |
| Doctor: `spotify connectivity` fails | credentials | refresh token revoked — reconnect |

State files: `state/spotify/` (receiver credential cache, token,
`artist-genres.json`, `pool.json`, `rate-limit.json` and `unplayable.json` — all
rebuildable caches, deliberately not in backups; a refusal list in particular
describes ONE account's licensing and would silently remove music if restored
onto another machine. Delete them and the station re-walks),
`state/spotify-player.json` (last player event), `state/spotify-audio.json`
(silence detector), `state/logs/spotify-events.log` (rolling event log),
`state/liquidsoap_music_mode.txt` and `state/liquidsoap_spotify.txt` (mixer
handoffs).

## The fallback nobody should need

If librespot cannot be used, the same architecture takes a different audio
leg: the Spotify desktop app on a Windows host, a virtual audio device, and a
small bridge that pushes the capture into Liquidsoap over its Icecast-source
input (`input.harbor`), with the Web API's playback state standing in for the
player events. That variant is documented in the design plan, not built.
