# Listener Request Flow — End to End

What happens, file by file, when a listener types "something for late-night
driving" into the request drawer and hits **Send to the booth**.

This is the path of a single `POST /request`. For the always-on broadcast
pipeline (auto-DJ picks, scheduled idents, crossfading), see
[`streaming-flow.md`](./streaming-flow.md).

---

## The short version

```
Browser  ──HTTP POST──▶  Caddy  ──▶  Controller  ──Ollama──▶  intent
                                          │
                                          ├─ Subsonic / mood library ─▶ a track
                                          ├─ Ollama ─▶ a spoken intro script
                                          │
                                          ▼
                              queue.push() → drainToLiquidsoap()
                                          │
                          writes  say.txt  (intro WAV path)
                          writes  next.txt (annotated track URI)
                                          │
                                          ▼
                              Liquidsoap polls, plays, mixes
                                          │
                                          ▼
                              Icecast  ──▶  every listener
```

The HTTP response goes back to the requester's browser the moment the track is
queued — it does **not** wait for the song to actually air.

---

## Stage 1 — Browser: collect and submit

| File | Role |
|---|---|
| `web/components/drawers/RequestDrawer.jsx` | The drawer UI — name field, free-text box, context-aware suggestion chips |
| `web/components/PlayerApp.jsx` | Owns `requestText` / `requesterName` state and the `submitRequest()` function |
| `web/lib/adminAuth.js` | Exports `API_URL` (`NEXT_PUBLIC_API_URL` or `/api`) |

The listener types into a `<textarea>` (and an optional name `<input>`).
`submitRequest()` in `PlayerApp.jsx` fires the request:

```js
POST {API_URL}/request
Content-Type: application/json

{
  "text": "something for late-night driving",   // trimmed
  "name": "Sam"                                  // trimmed, optional
}
```

**Data out:** `{ text, name }` — nothing else. No track ID, no mood; the raw
listener words are all the browser sends.

The UI then awaits the JSON response and renders either a `SuccessCard`
(`ack`, `track`, `queuePosition`) or an inline miss banner (`message`).

---

## Stage 2 — Caddy: route to the controller

| File | Role |
|---|---|
| `docker/Caddyfile` | `/api/*` → `controller:7701`, prefix stripped via `handle_path` |

`POST /api/request` from the browser becomes `POST /request` at the controller.
(In dev the browser hits `controller:7701` directly and skips Caddy.)

---

## Stage 3 — Controller: `POST /request` handler

**File: `controller/src/server.js`** (`app.post('/request', …)`)

### 3.0 — Validate and rate-limit

- `text` trimmed and capped at `REQUEST_TEXT_MAX`; empty → `400 { error }`.
- `name` trimmed and capped at `REQUEST_NAME_MAX`; empty → `"anon"`.
- `checkRateLimit(clientIp(req))` — per-IP cooldown + burst window. Over the
  limit → `429 { success:false, message, retryAfter }`.
- If `REQUESTS_DISABLED` → `503`.

Logged via `queue.log('request', …)`.

### 3.1 — Shortcut: "more like this"

If `text` matches `/^more like this$/i`, the LLM is skipped entirely. The
controller takes the current/last track's **artist** and calls
`pickByArtistAndSort()` to grab another song by that artist. Jump to stage 3.4.

### 3.2 — Ollama parses intent

**File: `controller/src/llm/dj.js`** — `matchRequest(text, { listenerName, nowPlaying })`

The raw listener text + the currently-playing track go to Ollama with
`format: 'json'` and a strict schema. Ollama returns:

```js
{
  search_terms: ["…"],   // concrete library values (artist/song/genre) — or []
  mood:         "night", // vibe vocabulary, matches the mood tagger
  intent:       "…",     // short description of what they want
  ack:          "…",     // a one-line on-screen acknowledgement
  artist:       "…",     // for "latest album by X" style queries
  scope:        "song" | "album",
  sort:         "latest" | "oldest" | null
}
```

**Data passed:** listener text + current track in; structured intent out.
Logged via `queue.log('intent', …)`.

### 3.3 — Resolve intent to an actual track

The controller tries pick sources **in priority order** and stops at the first
hit. `recentIds` (last 25 played) is used everywhere to prefer fresh songs.

| Order | Source | When | File |
|---|---|---|---|
| 2a | `pickByArtistAndSort()` | `artist` + (`sort` or `scope:album`) present | `server.js` + `subsonic.js` |
| 2b | `subsonic.search(term)` per term | `search_terms` look like real library values | `controller/src/subsonic.js` |
| 2c | `library.songsByMood(mood)` | LLM gave a `mood` | `controller/src/library.js` (`state/moods.json`) |
| 2d | `subsonic.getSimilarSongs(currentTrack.id)` | vibe-ish + something is playing | `subsonic.js` |
| 2e | `library.songsByMood(dominantMood)` | nothing matched, but the room has a mood (`getFullContext()`) | `controller/src/context.js` |
| 2f | `subsonic.getStarred()` | last-ditch — operator favourites | `subsonic.js` |

If **every** source comes up empty:

```js
res.json({ success:false, message:`Sorry ${requester}, nothing in the crates matched that.` })
```

Otherwise the result is a `pick` (a song object: `id`, `title`, `artist`, …)
and a `pickSource` string, logged via `queue.log('request', 'resolved via …')`.

### 3.4 — Generate the spoken intro

**File: `controller/src/llm/dj.js`** — `generateIntro({ … })`

```js
generateIntro({
  track:        pick,
  context:      await getFullContext(),   // time, weather, festival, mood
  requestedBy:  requester,                // so the DJ can name the listener
  requestText:  text,
  recap:        queue.getDjRecap(),
  recentTracks: queue.getRecentTracks(),
  recentOpeners: queue.getRecentOpeners(),// anti-repeat
})
```

Returns `introScript` — a free-text line the DJ will read on-air, e.g.
*"Sam wants something for the late-night drive — here's…"*.

### 3.5 — Queue it

```js
await queue.push({ track: pick, requestedBy, intent, introScript });
```

### 3.6 — Respond to the browser

```js
res.json({
  success: true,
  ack:           matched.ack,                 // shown in the SuccessCard
  track:         { title: pick.title, artist: pick.artist },
  queuePosition: queue.upcoming.length,
})
```

This returns **immediately** — the song has not aired yet, it's just queued.

---

## Stage 4 — Queue → Liquidsoap (file-based IPC)

**File: `controller/src/queue.js`**

`push()` appends an item `{ track, requestedBy, intent, introScript, sent:false }`
to `this.upcoming`, then fires `drainToLiquidsoap()` (fire-and-forget).

`drainToLiquidsoap()` walks unsent items and, for each:

1. **If `introScript` is set** — render it to a WAV via `tts.speak(script, { kind:'dj-speak' })`
   (`controller/src/tts.js` → Piper or Kokoro), then:
   ```
   write  config.liquidsoap.sayFile   →  /var/sub-wave/say.txt   (the WAV path)
   sleep 250 ms
   ```
2. **Then the track** — `subsonic.getAnnotatedUri(track)` builds:
   ```
   annotate:title="…",artist="…",subsonic_id="…":subhttp:https://navidrome/…
   ```
   ```
   write  config.liquidsoap.queueFile  →  /var/sub-wave/next.txt
   sleep 1500 ms   (let Liquidsoap's 1s poll read + delete it)
   ```

The 250 ms gap guarantees the **voice file lands before the track URI**, so
Liquidsoap speaks the intro before the requested song starts.

| File written | Path | Contents | Liquidsoap poll |
|---|---|---|---|
| `say.txt` | `/var/sub-wave/say.txt` | absolute path to the intro WAV | every 0.5 s |
| `next.txt` | `/var/sub-wave/next.txt` | the `annotate:`-wrapped track URI | every 1.0 s |

> Note: a request intro goes through `say.txt` (`voice_queue`, heavy duck) —
> it is a solo DJ moment. The `intro.txt` channel (light duck) is used only for
> auto-DJ links between tracks, written by `queue.announce(script, 'link')`.

---

## Stage 5 — Liquidsoap: speak, queue, mix

**File: `liquidsoap/radio.liq`**

- Polls `say.txt` (0.5 s) → reads the WAV path, **deletes the file**, pushes it
  onto `voice_queue` → through `mic_chain` → `smooth_add p=0.25` ducks the music
  hard while the DJ talks.
- Polls `next.txt` (1.0 s) → reads the URI, **deletes the file**,
  `request.queue.push`es it. The `subhttp:` protocol shells out to `curl` to
  fetch the audio from Navidrome.
- The track plays through the crossfade + broadcast bus and out via
  `output.icecast` to `icecast:7702/stream.mp3`.

Track metadata flows back through `now-playing.json` (written by the
`music_meta.on_metadata` hook); the controller and web UI poll it. The
requested song surfaces in the UI's "now playing" / queue views the same way
any other track does.

---

## Data summary — what crosses each boundary

| Boundary | Mechanism | Data |
|---|---|---|
| Browser → Caddy | HTTP `POST /api/request` | `{ text, name }` |
| Caddy → Controller | HTTP `POST /request` (prefix stripped) | `{ text, name }` |
| Controller → Ollama (match) | local HTTP, `format:json` | listener `text` + current track → `{ search_terms, mood, intent, ack, artist, scope, sort }` |
| Controller → Navidrome | Subsonic API (salt+token auth) | search terms / artist / IDs → song objects |
| Controller → Ollama (intro) | local HTTP, free-text | `{ track, context, requestedBy, requestText, recap, … }` → `introScript` |
| Controller → Browser | HTTP response | `{ success, ack, track:{title,artist}, queuePosition }` |
| Controller → Liquidsoap | `say.txt` file | absolute path to intro WAV |
| Controller → Liquidsoap | `next.txt` file | `annotate:…:subhttp:…` track URI |
| Liquidsoap → Controller/UI | `now-playing.json` file | `{ title, artist, album, subsonic_id }` |
| Liquidsoap → Listeners | Icecast MP3 stream | the mixed broadcast audio |

---

## Files touched, by repo location

**Web UI**
- `web/components/PlayerApp.jsx` — `submitRequest()`, request state
- `web/components/drawers/RequestDrawer.jsx` — the form + result rendering
- `web/lib/adminAuth.js` — `API_URL`

**Edge**
- `docker/Caddyfile` — `/api/*` → controller

**Controller**
- `controller/src/server.js` — `POST /request` handler, rate limiting
- `controller/src/llm/dj.js` — `matchRequest()`, `generateIntro()`
- `controller/src/subsonic.js` — `search`, `getSimilarSongs`, `getStarred`, `getAnnotatedUri`
- `controller/src/library.js` — `songsByMood()` over `state/moods.json`
- `controller/src/context.js` — `getFullContext()` (time / weather / festival / dominant mood)
- `controller/src/queue.js` — `push()`, `drainToLiquidsoap()`
- `controller/src/tts.js` — `speak()` → Piper / Kokoro

**Mixer**
- `liquidsoap/radio.liq` — polls `say.txt` / `next.txt`, mixes, broadcasts

**Shared IPC files** (`/var/sub-wave/`)
- `say.txt` — intro WAV path (controller writes, Liquidsoap reads + deletes)
- `next.txt` — annotated track URI (controller writes, Liquidsoap reads + deletes)
- `now-playing.json` — current track (Liquidsoap writes, controller reads)
