# Concepts

Seven things that get asked over and over — not because they're broken, but
because the name doesn't tell you what's underneath. Each section says what the
thing is, what changes when you move it, and where the control lives.

> Running a station already? The same material, illustrated, lives in the
> in-app manual at **/manual/concepts**. This page is the repo-side copy for
> someone reading on GitHub before they have a station to click around in.

- [Local Colour (and the other two dials)](#local-colour-and-the-other-two-dials)
- [Candidate pool vs the agent picker](#candidate-pool-vs-the-agent-picker)
- [Playlists vs shows](#playlists-vs-shows)
- [The stem cache](#the-stem-cache)
- [Private player vs stream password](#private-player-vs-stream-password)
- [Dayparts, and why they don't move with the sun](#dayparts-and-why-they-dont-move-with-the-sun)
- [Hearts: what a like actually does](#hearts-what-a-like-actually-does)

---

## Local Colour (and the other two dials)

**Where:** Admin → Personas → *(a persona)* → Behaviour.

Every persona carries three 0–10 dials: **Humour**, **Local Colour** and
**Warmth**. They are not sliders on a mixing desk — nothing scales
proportionally as you drag them. Each dial resolves to one of three bands:

| Value | Band |
| --- | --- |
| 0–3 | low |
| 4–6 | neutral |
| 7–10 | high |

Only a band **away from neutral** appends a sentence to the persona's prompt.
So 4, 5 and 6 are the same setting, and so are 7 and 10.

That is deliberate. A model cannot tell `humour=6` from `humour=7` in a raw
"7/10" instruction, so rather than pretend to a precision that isn't there, the
dial picks one of two style directives:

| Dial | Low band says | High band says |
| --- | --- | --- |
| **Humour** | Play it straight; keep any wit rare and understated. | Lean into dry, playful wit; an aside or a wink is welcome. |
| **Local Colour** | Keep it universal; skip local references and place-specific colour. | Lean on the local setting (the town, the weather, the hour) as texture. |
| **Warmth** | Keep a cool, dry distance; let the music carry the warmth. | Be warm and earnest; speak to the listener like a friend. |

**Local Colour specifically** governs how much the DJ reaches for *where and
when you are* — your town, today's weather, the hour — as material. Turned up,
links start with the drizzle outside; turned down, the same DJ could be
broadcasting from anywhere.

Three things it does **not** do:

- It doesn't add facts. The place name, weather and clock come from the station
  context regardless; the dial only decides whether the DJ leans on them.
- It doesn't invent a second location. Exactly one place name reaches any
  prompt (the on-air location you set under Settings → Station). If the DJ names
  a different city, that's the model improvising, not the dial.
- A persona left at the defaults renders a **byte-identical** prompt to a
  station that never had the dials, which is why upgrading changes nothing.

---

## Candidate pool vs the agent picker

**Where:** Admin → Settings → LLM → **Agentic picker** (`Candidate pool` / `Agent`).

Both end at the same place — one track id, handed to the queue — and both run
inside a session and get logged. They differ in *who does the searching*.

### Candidate pool (off)

The controller builds the shortlist itself, then asks the model once.

It merges up to sixteen sources into one pool — mood matches from the library,
sonically similar tracks, embedding neighbours, the current show's genres and
playlists, starred and frequently-played, recently added, listener favourites,
a wildcard and a little pure random — de-duplicates, applies the recency and
artist filters, caps it, and sends the survivors to the model as a list. The
model makes **one call**: pick one of these.

- One LLM round-trip per track.
- Works on a small local model — there is no tool loop to get lost in.
- Bounded latency, bounded tokens.
- The model can only choose from what the pool already found.

### Agent (on, the default)

The model drives. It gets a toolbox of roughly eighteen discovery tools —
similar songs, tracks like this one, search by sound, search by lyrics, by
mood, by energy, by genre, deep cuts, recently added, top songs by artist,
tracks toward a journey — and searches the library itself over the session's
chat history, then commits its pick with a `done` call.

- Several round-trips per track, so it costs more tokens and more wall-clock.
- Needs a model that is genuinely good at **multi-step, forced tool calling**
  with a context window of at least 16384. Most "the agent stopped without
  calling done" reports are this requirement not being met.
- Bounded by **Agent deadline** (default 45s). On timeout or failure it falls
  back to the candidate pool, so a slot is never lost.

### Which to run

Start on **Agent** if you're on a cloud model or a 12B-class local model. Drop
to **Candidate pool** if picks are slow, if the log shows repeated
`djAgentRepick` loops, or if you're on a 9B-class model — the station still
picks, still writes links, still honours requests.

Two related behaviours worth knowing, whichever you pick:

- **Variety is enforced after the choice, not inside the search.** The
  discovery tools carry no artist filter on purpose — filtering inside them
  gutted the similarity pool on niche catalogues. Instead, a pick that repeats
  an artist from the last few slots triggers a re-pick. So an eight-of-eight
  same-artist candidate set is expected, and the guard is what stops it
  reaching air.
- **The daily token cap degrades in tiers.** Past the soft threshold the
  station drops to the candidate pool and mutes optional segments; at the cap
  it stops calling the model at all and coasts on the fallback playlist. Music
  never stops.

---

## Playlists vs shows

They sound like alternatives. They're layers — a show can *use* playlists.

|  | Playlist | Show |
| --- | --- | --- |
| **What it is** | A named set of tracks | A block of programming on the schedule |
| **Lives in** | Navidrome (SUB/WAVE reads it over Subsonic) | `state/schedule.json`, edited in admin |
| **Has a time** | No | Yes — that's the point |
| **Has a persona / theme / topic** | No | Yes |
| **Where** | Admin → Playlists | Admin → Shows, Admin → Shows → Schedule |

A **playlist** is just tracks. You can build one by hand in Navidrome, or let
the playlist builder assemble one from a description ("late-night driving,
mostly instrumental, 90 minutes") — it merges candidates from the same vector,
mood and similarity machinery the picker uses, then makes one model call to
select and order them into an energy arc.

A **show** is an hour (or several) with an identity: which persona is on air,
which theme the player wears, what the show is about, and a set of music
filters — moods, genres, eras, energies, vocals. The DJ still picks each track
live; the show narrows what it may pick from.

### Where they meet

A show can be **anchored** to one or more playlists. Then:

- **Anchored, not strict** — the playlist union becomes the show's dominant
  source, but the DJ may still reach outside it for a better fit.
- **Anchored + strict** — the playlist union is the show's entire universe.
  Every off-playlist candidate is dropped before ranking.

If a show pins playlists that resolve to nothing (deleted and recreated in
Navidrome, so the id moved), the anchor is **ignored and logged** — including a
note that the strict toggle had no effect. The show still airs; it just airs
unanchored. Re-select the playlists in the show editor to fix it.

### Rules of thumb

- Recurring identity, fixed hour, its own voice → **show**.
- A set of tracks you want to reach for, from anywhere → **playlist**.
- "This hour, only these tracks" → **show anchored to a playlist, strict on**.

---

## The stem cache

**Where:** Admin → Settings → Transitions.

Stem-blend transitions mix the outgoing and incoming tracks by *instrument*
rather than crossfading two finished mixes: the outgoing drums duck out under
the incoming bass, vocals clear before the new vocal enters. Doing that needs
the four separated stems (drums, bass, other, vocals) for both sides of the
seam.

Separating stems takes far longer than the gap between two tracks, so it can't
happen at the seam. The analyzer separates them **during analysis** and writes
a head window (first 40s) and a tail window (last 20s) as FLAC under
`state/stems/<trackId>/`. A transition render is then a fast mix of cached
files.

### The trade-off

The cost is disk, and it is the only cost — the separation is paid for during
analysis whether you keep the output or not.

- Budget one is **~13–25 MB per track**. The ceiling is 25 MB; real caches run
  nearer 13 MB, because stem FLACs are mostly quiet channels and compress hard.
- The default budget is **15 GB**, so roughly 600–1,200 tracks.
- Past the budget, an LRU sweep evicts the least recently used directories.

The thing that surprises people: **a blend needs stems on *both* tracks of a
pair.** With half the library cached, far fewer than half your seams blend —
most fall back to a plain crossfade, which is not a failure, just the ordinary
behaviour. That is the honest reason to raise the budget: coverage of pairs,
not coverage of tracks. `subwave doctor` says this outright, with the track
count your current budget actually holds.

### Sizing it

- **Small library (a few thousand tracks)** — raise the budget until it covers
  the lot and let the analysis pass backfill.
- **Large library (tens of thousands)** — the budget will always bind. Blends
  will land on the tracks that happen to be cached.
- **Short on disk** — turn the cache off. Every seam becomes a crossfade and
  nothing else changes.
- **Moving it to a bigger disk** — bind-mount your disk at
  `<state>/stems`. There is no path setting; the mount is the mechanism.
  Mount it world-writable, or the analyzer (a different uid) can't write to it.

---

## Private player vs stream password

Two independent locks, one shared station password, both under
**Admin → Settings → Station → Privacy**. They're often confused because
turning either one on asks for the same password.

| | Private player | Stream password |
| --- | --- | --- |
| **Hides** | The web pages (`/`, `/listen`) | The audio itself, on every mount |
| **Enforced by** | The web UI | Icecast, via a callback to the controller |
| **Applies** | Live | Enabling/disabling needs a mixer restart; password changes are live |
| **Stops** `curl /stream.mp3` | **No** | Yes |

The short version: **the private player is a curtain, the stream password is a
lock.** The private player hides the interface; the now-playing endpoints stay
public (the player and admin dash need them) and anyone who knows
`/stream.mp3` can still listen. If you want actual gating, you want the stream
password — usually both together, so one prompt unlocks the page and the audio.

A third thing is often mistaken for these two: **HTTP Basic Auth in front of
the whole station**, applied at your own reverse proxy. That is not a SUB/WAVE
feature and it behaves differently — notably for the mobile apps.

Full detail on all three, including how to tune in from VLC, Sonos, hardware
radios and the apps once a password is on:
**[`docs/private-station.md`](private-station.md)**.

---

## Dayparts, and why they don't move with the sun

**Where:** Admin → Moods → Moments.

The station divides the day into eight named periods:

| Period | Hours (station timezone) |
| --- | --- |
| early-morning | 05:00–09:00 |
| morning | 09:00–12:00 |
| midday | 12:00–14:00 |
| afternoon | 14:00–17:00 |
| drive-time | 17:00–19:00 |
| evening | 19:00–22:00 |
| late-evening | 22:00–01:00 |
| after-hours | 01:00–05:00 |

These boundaries are **fixed wall-clock hours in the station's timezone**. They
are not derived from sunrise or sunset, and they are not configurable.

That reads oddly above roughly 55°N or below 55°S, where "evening" is full
daylight in June and pitch dark in December. It's a deliberate trade, for two
reasons. A daypart is a *programming* concept — "drive-time" means the end of
the working day, which is 17:00 whatever the sky is doing — and it has to be
predictable: the schedule, the mood plan and the show grid are all built
against named hours, and boundaries that drifted by three hours across the year
would quietly move your shows.

### What *is* sun-aware

The DJ's own description of the outside world. The station reads whether the
sun is up right now from Open-Meteo and puts that on the prompt, which is what
stops it describing dusk two hours after dark in December — or "the last of the
light" at 21:00 in June. That runs off real solar position at your coordinates,
so it is correct at any latitude. If the weather fetch fails, the flag is
simply absent and the model falls back to inferring from the clock.

### What you can change

Each period's **mood** is yours — Admin → Moods → Moments maps every daypart to
a mood from your vocabulary. So the lever at high latitude is not to move the
boundary but to retune what happens inside it: give a Nordic summer "evening" a
brighter mood than the default wind-down, and let the sun-aware flag keep the
DJ's language honest.

Two related nudges sit on top of the table and are not editable: the small
hours pull the speaking pace down regardless of which period the hour formally
belongs to, and commute windows push it up. A show with a pinned energy
overrides both — a scheduled slot is an explicit operator decision.

---

## Hearts: what a like actually does

There are two hearts, and they are not the same signal.

- **The listener heart**, on the player. One like per apparent listener per
  *airing* — the same song aired again later is likeable again. Listeners have
  no accounts, so "apparent listener" is an HMAC of the IP; the raw address is
  never stored, and everyone behind one NAT shares a key. It's lightweight
  dedup, not identity.
- **The operator heart**, in Admin → Library. Curation, not a taste snapshot.

### What a like does by default

By default, **nothing to rotation.** A like is recorded, it shows up in stats,
and — if Navidrome starring is on — the track is starred in Navidrome. The DJ
does not know about it.

Rotation influence is opt-in: **Admin → Settings → Likes → AI DJ influence → Use likes to influence picks**.
Turned on, the most-liked tracks become one more source feeding the candidate
pool, capped like every other source. It is a weighted preference, never a
lock — the crowd can steer the pool without taking it over. By default that's
the top 10 tracks liked in the last 30 days (both numbers are settings; a
window of 0 means all time).

### Why the two hearts age differently

An operator heart is **exempt from the window and from the record trim**. A
listener like ageing out of the 30-day window is a taste snapshot expiring,
which is correct. An operator like ageing out would be the DJ forgetting
curation you set by hand, which is not.

### Clearing them

Yes. Per track, from the row actions in **Admin → Library**:

- **Un-heart** as the operator — removes only your heart. If it was the last
  like standing and Navidrome starring is on, the track is unstarred there too.
- **Clear likes** — drops the listener likes on that track as well.

Note the asymmetry: un-hearting as the operator leaves listener likes in place;
**Clear likes** removes both.

To wipe the whole store there is no button — it's `DELETE /likes` on the admin
API:

```bash
curl -u "$ADMIN_USER:$ADMIN_PASS" -X DELETE https://radio.example.com/api/likes
```
