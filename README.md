# SUB/WAVE

A real internet radio station. Single Icecast stream — every listener hears the same broadcast at the same time. An LLM-driven DJ picks tracks based on what just played, the time of day, weather, festivals, and listener requests; Piper TTS speaks intros and time-checks between tracks. The DJ has a name, a personality, and a configurable cadence — all editable from a web Settings panel.

```
                    ┌─────────────────────────────────────────┐
                    │           Listeners (browsers)          │
                    │      <audio src="…/stream.mp3">         │
                    └────────────────────┬────────────────────┘
                                         │ HTTP audio
                    ┌────────────────────▼────────────────────┐
                    │              ICECAST                    │
                    │       (broadcast endpoint, CORS on)     │
                    └────────────────────▲────────────────────┘
                                         │ source connection
                    ┌────────────────────┴────────────────────┐
                    │           LIQUIDSOAP                    │
                    │  • polls next.txt / say.txt (1s/0.5s)   │
                    │  • smart crossfade, smooth_add ducking  │
                    │  • on_track → now-playing.json          │
                    │  • auto.m3u + emergency.mp3 fallback    │
                    │  • hourly archive output                │
                    └────────────────────▲────────────────────┘
                                         │ writes URIs + WAV paths
                    ┌────────────────────┴────────────────────┐
                    │         CONTROLLER (Node.js)            │
                    │  • Express API (admin gate optional)    │
                    │  • now-playing watcher (1.5s)           │
                    │  • Ollama: matching, DJ scripts, picks, │
                    │    library mood tagging                 │
                    │  • Piper TTS for spoken segments        │
                    │  • Scheduler: auto.m3u, time/weather/   │
                    │    station-ID — gated by DJ frequency   │
                    │  • settings.json (DJ persona, mixer)    │
                    └─┬──────────┬──────────┬──────────────┬──┘
                      │          │          │              │
                  ┌───▼───┐  ┌───▼────┐ ┌───▼────┐  ┌──────▼──────┐
                  │Ollama │  │Navidrm │ │ Piper  │  │ Open-Meteo  │
                  │       │  │Subsonic│ │  TTS   │  │  (weather)  │
                  └───────┘  └────────┘ └────────┘  └─────────────┘

                    ┌─────────────────────────────────────────┐
                    │       NEXT.JS WEB UI (V3 "Frequency")   │
                    │  • /        — listener page OR landing  │
                    │               (SUBWAVE_HOMEPAGE flag)   │
                    │  • /listen  — always the player         │
                    │  • /landing — always the broadsheet     │
                    │  • /debug   — live diagnostics          │
                    └─────────────────────────────────────────┘
```

### Marketing landing vs player

`web/app/page.js` reads the `SUBWAVE_HOMEPAGE` env var at request time:

- `SUBWAVE_HOMEPAGE=landing` → renders the broadsheet landing with the live player embedded inline. This is what `subwave.zeiq.co` serves.
- `SUBWAVE_HOMEPAGE=player` (default) → renders the fullscreen listener UI directly. Use this on private/Tailscale-only instances that don't need marketing.

The landing fetches a public `/api/dj` endpoint for the DJ's name and persona soul; everything else (now-playing, history, booth log) comes through the same 5-second polling used by the player.

## Why this architecture

Real radio = one stream, synced listeners. That needs a server-side audio mixer. Liquidsoap is the standard tool — what college radio, every small internet station uses. Icecast is the broadcast layer listeners connect to. The controller is the only bespoke piece; Liquidsoap and Icecast just do their well-understood jobs.

## What runs where

- **Icecast / Liquidsoap / Controller** — Docker Compose stack. Defaults assume `host.docker.internal` for the local Ollama.
- **Ollama** — runs on the host (or any reachable host). Default model is `nemotron-3-super:cloud`; swap to anything that supports the `format: json` chat option (`qwen2.5:7b`, `llama3.1:8b`, …).
- **Navidrome** — anywhere reachable. Controller talks Subsonic API.
- **Piper** — baked into the controller image, CPU-only. Voice: `en_GB-alan-medium`.
- **Web UI** — Next.js dev server on port 3000 (dev) or behind Caddy as part of the prod compose file.

## Directory layout

```
sub-wave/
├── controller/
│   ├── src/
│   │   ├── server.js          # Express API: public + admin-gated routes
│   │   ├── settings.js        # Durable settings (DJ persona, mixer, weather) + renderDjPrompt
│   │   ├── subsonic.js        # Navidrome client + annotate URI builder
│   │   ├── ollama.js          # Request matching, DJ scripts, LLM picker
│   │   ├── piper.js           # TTS wrapper
│   │   ├── queue.js           # In-memory queue + now-playing watcher; freq-aware DJ links
│   │   ├── picker.js          # LLM-as-DJ next-track picker
│   │   ├── library.js         # moods.json store
│   │   ├── tag-library.js     # Standalone library tagger
│   │   ├── scheduler.js       # auto.m3u refresh + freq-gated time/weather/station-ID
│   │   ├── context.js         # Time / weather / festival → dominantMood
│   │   ├── jingles.js         # Pre-rendered TTS stinger management
│   │   ├── liquidsoap-control.js  # telnet → liquidsoap shutdown for mixer restart
│   │   └── config.js
│   ├── package.json           # npm run tag → src/tag-library.js
│   └── .env.example
├── web/                       # Next.js 15 App Router
│   ├── app/
│   │   ├── page.js            # Listener page (V3 "Frequency" layout)
│   │   └── debug/page.js      # Live diagnostics
│   ├── components/
│   │   ├── TopBar.jsx         # SUB/WAVE · with {djName} · time · weather · ⚙
│   │   ├── CenterStage.jsx    # Now-playing title block
│   │   ├── Waveform.jsx       # Web Audio analyser, 120-bar render
│   │   ├── TransportBar.jsx   # Tune-in toggle, volume, elapsed
│   │   ├── DotRail.jsx        # Right-edge dot rail → drawers
│   │   ├── SettingsDialog.jsx # Admin settings UI w/ Basic-auth sign-in form
│   │   └── drawers/           # Queue · History · Booth · Request
│   └── .env.local             # NEXT_PUBLIC_API_URL / NEXT_PUBLIC_STREAM_URL
├── liquidsoap/
│   └── radio.liq              # Liquidsoap broadcast script
├── docker/
│   ├── docker-compose.yml         # Dev variant (no web container, no edge)
│   ├── docker-compose.prod.yml    # Prod (adds web + Caddy)
│   ├── Caddyfile                  # /api → controller, /stream.mp3 → icecast, else → web
│   ├── icecast.xml.template       # Rendered by setup.sh with random passwords
│   └── Dockerfile.controller      # Node 22 + Piper + voice
├── scripts/
│   ├── setup.sh               # Idempotent, no-sudo: state dirs, .env files, emergency.mp3
│   ├── generate-jingles.sh    # Render default jingles via Piper
│   └── update.sh              # Prod: git pull + rebuild + rolling recreate
└── state/                     # Bind-mounted shared volume
    ├── settings.json          # Persistent settings (DJ persona, mixer, weather)
    ├── auto.m3u               # Fallback playlist, refreshed every 10 min
    ├── jingles.m3u            # Pre-recorded TTS stingers list
    ├── jingles/               # The WAVs themselves
    ├── emergency.mp3          # Pink-noise safety net
    ├── now-playing.json       # Written by Liquidsoap on every track change
    ├── moods.json             # LLM-tagged library (after running `npm run tag`)
    ├── voice/                 # Piper WAVs (auto-cleaned hourly)
    ├── archive/               # Hourly broadcast archives
    └── logs/radio.log
```

## Quick start (dev)

```bash
# 1. Configure + state dir + emergency audio (idempotent)
./scripts/setup.sh
#   → creates state/, generates docker/.env with random Icecast passwords,
#     seeds controller/.env from .env.example, renders state/icecast.xml,
#     generates state/emergency.mp3 (needs ffmpeg on host)
# Edit controller/.env: NAVIDROME_URL / USER / PASS, OLLAMA_URL / MODEL

# 2. Web dev env (so the Next.js dev server hits the right hosts)
cat > web/.env.local <<EOF
NEXT_PUBLIC_API_URL=http://localhost:4000
NEXT_PUBLIC_STREAM_URL=http://localhost:8000/stream.mp3
EOF

# 3. Bring up the stack
cd docker && docker compose up -d --build

# 4. Web UI
cd ../web && npm install && npm run dev

# 5. Optional — render station idents
./scripts/generate-jingles.sh
```

Open:
- **Listener** — http://localhost:3000
- **Debug** — http://localhost:3000/debug (admin-gated if `ADMIN_USER`/`ADMIN_PASS` are set)
- **Raw stream** — http://localhost:8000/stream.mp3
- **Icecast status** — http://localhost:8000/status-json.xsl

### Rebuild ≠ restart

`controller` and `liquidsoap` Dockerfiles `COPY` their source at build time — neither bind-mounts. So `docker compose restart <service>` reruns the *same baked-in code*. For source edits to take effect:

```bash
cd docker && docker compose up -d --build controller     # after any controller/src/** change
cd docker && docker compose up -d --build liquidsoap     # after radio.liq change
```

Same goes for env changes: `restart` keeps the existing container's env vars from creation time. Use `up -d` to recreate and re-read `env_file`.

`web` is hot-reloaded by `next dev` — no rebuild needed for UI changes during dev.

## Production (single host, Caddy edge)

```bash
sudo STATE_DIR=/var/lib/subwave ./scripts/setup.sh
docker compose -f docker/docker-compose.prod.yml up -d
./scripts/generate-jingles.sh
./scripts/update.sh   # git pull + rebuild + rolling recreate
```

Only Caddy binds a host port (`:80`); Icecast, Controller, Web are internal. Cloudflare is expected in front for TLS (`auto_https off` in the Caddyfile).

## Settings (web UI)

Open **⚙ Settings** in the top-right of the listener page. Everything below is also reachable via `GET /settings` / `POST /settings`.

### DJ persona

- **Name** — shown in the TopBar (`SUB/WAVE with <name>`) and injected into LLM prompts as `{name}`. Required.
- **Talk frequency** — `quiet` / `moderate` / `aggressive`. Maps to:
  - DJ link interval between auto-played tracks (`pickLinkInterval` in `queue.js`).
  - Station ID cadence (once/twice/four times an hour).
  - Hourly time-check and weather-update gating in `scheduler.js`.
  - **Music selection is untouched** — frequency only controls how chatty the DJ is.
- **Soul** — short personality description, injected into the system prompt as `{soul}`. Default is the BBC 6 Music presenter vibe.
- **System prompt template (advanced)** — full editable template. Placeholders: `{name}` (required), `{soul}`, `{station}`, `{location}`. "Reset to default" restores the original.

All persona changes apply live — no mixer restart needed.

### Mixer settings (require Liquidsoap restart)

- **Crossfade duration** (sec)
- **Weather location** — lat / lng / display name (applies live; only crossfade needs the restart)

### Library mood tags

- Track count by mood, last-update timestamp
- Run the tagger with an optional `--limit` ceiling
- Tagger log preview

### Jingles

- **Frequency** — 1 jingle every N music tracks (needs restart)
- Create new TTS stingers from text
- List + delete (built-in default ident is protected)

## Admin auth (optional)

The admin surface is open by default — fine for dev on a private network. To require Basic auth, set both env vars in `controller/.env`:

```
ADMIN_USER=admin
ADMIN_PASS=<something good>
```

Then `docker compose up -d controller` (not `restart`).

What's protected: `/settings` GET+POST, `/restart-mixer`, `/jingles` GET+POST+DELETE, `/auto-pick`, `/tag-library`, `/debug`.

What stays public: `/now-playing`, `/state`, `/request`, `/health`.

The web Settings dialog shows an in-app sign-in form on 401 and caches `base64(user:pass)` in `localStorage["subwave_admin_auth"]`. Click **sign out** in the dialog footer to drop the credentials.

## How the auto-DJ picks tracks

The picker runs **once per track change**, fired by the now-playing watcher. By the time the current track ends, the next one is already sitting in Liquidsoap's `dj_queue`.

Candidate pool, in order of preference:
1. **Mood-tagged tracks** matching `dominantMood` from `state/moods.json`
2. **Any tagged track** if the mood pool is too small
3. **Starred + random** from Navidrome if the library hasn't been tagged

Recently played track IDs (last 25) are filtered out. The LLM gets the last 8 plays (title, artist, moods, energy), the current context, and the candidate pool, and returns `{ id, reason }`. The reason is logged with each pick and visible on `/debug`.

If Ollama is down or returns garbage, the controller logs the error and does nothing — Liquidsoap falls back to `auto.m3u` (refreshed every 10 min from starred + random) so audio never stops.

Toggle the LLM picker:

```bash
curl -X POST http://localhost:4000/auto-pick \
  -H 'Content-Type: application/json' \
  -u admin:secret \                          # only if admin auth is on
  -d '{"on": false}'
```

## Tagging the library

```bash
# Try 50 tracks first to sanity-check tag quality
docker exec sub-wave-controller npm run tag -- --limit 50

# Full library
docker exec sub-wave-controller npm run tag
```

Resumable; saves every 25 tags. Mood vocabulary:

> energetic, calm, reflective, celebratory, romantic, spiritual, focus, workout, driving, cooking, rainy, sunny, night, morning, evening, festival, cultural

Energy: `low | medium | high`. Stats appear on `/debug` once at least one track is tagged.

## Listener requests

```bash
curl -X POST http://localhost:4000/request \
  -H 'Content-Type: application/json' \
  -d '{"text": "something for late-night driving", "name": "klair"}'
```

Flow: Ollama parses intent → searches Navidrome → picks best match → generates contextual DJ intro → Piper renders intro WAV → both pushed to Liquidsoap. The intro plays over the track's first few seconds (sidechain-ducked by `smooth_add`).

User requests jump to the front of the controller's `upcoming` queue. **Caveat:** an LLM pre-pick already sitting in Liquidsoap's `dj_queue` will still play before your request — it can't be cancelled from outside without telnet/server hooks.

The web Request drawer renders a success card on match (with the DJ's ack + queue position) and auto-closes after ~2.8 s; on no-match it shows an inline error so you can retry without losing the textbox contents.

## Scheduler segments

The DJ talk-frequency setting gates these (`quiet`/`moderate`/`aggressive`):

| When | What | quiet | moderate | aggressive |
|---|---|---|---|---|
| Top of every hour | Time-check | every 2nd hour | every hour | every hour |
| `:00`/`:15`/`:30`/`:45` | Station ID | `:45` only | `:15` + `:45` | all four |
| Every 15 min (on change) | Weather update | `:00` only | `:00` + `:30` | every 15 min |
| Every 10 min | `auto.m3u` refresh | always | always | always |
| Hourly | Old voice WAV cleanup | always | always | always |

Plus randomised DJ links between auto-played tracks — interval scales with frequency (`quiet` 8-20 tracks, `moderate` 1-9 / 10-15, `aggressive` 1-3).

All speak through the same `voice_queue`, which ducks the music briefly via `smooth_add(p=0.25)`.

## Endpoints (controller, port 4000)

Public:

| Method | Path | What |
|---|---|---|
| GET | `/health` | Liveness |
| GET | `/now-playing` | `{ nowPlaying, context, dj: { name } }` |
| GET | `/state` | Queue snapshot — `{ current, upcoming, history, djLog }` |
| POST | `/request` | Listener request — `{ text, name? }` |

Admin (gated when `ADMIN_USER`/`ADMIN_PASS` are set):

| Method | Path | What |
|---|---|---|
| GET / POST | `/settings` | Read or update DJ persona / mixer / weather |
| POST | `/restart-mixer` | Telnet → Liquidsoap shutdown → container restart |
| GET / POST / DELETE | `/jingles[/:filename]` | Manage pre-rendered TTS stingers |
| POST | `/auto-pick` | Toggle the LLM picker |
| POST | `/tag-library` | Kick off the mood tagger as a background process |
| GET | `/debug` | Everything-at-a-glance JSON |

## Stopping it

```bash
cd docker && docker compose down
```

State (`settings.json`, `moods.json`, voice WAVs, archives) is persisted in `./state/`. Restart anytime with `docker compose up -d`.

## Known caveats

- **Pre-picked AI tracks play before subsequent listener requests** (see [Listener requests](#listener-requests)).
- **Mood biasing only works after `npm run tag`.** Until then the picker uses starred + random.
- **Liquidsoap log can grow unbounded.** `state/logs/radio.log` has no rotation configured.
- **`/skip` endpoint is not implemented** — Liquidsoap controls pacing. Track-end is the only natural transition.
- **Admin auth uses Basic auth over HTTP** — fine behind Cloudflare/Caddy with TLS, but don't expose port 4000 raw to the internet.

## Customisation (code-level, beyond Settings)

Things you can change without touching code now live in the Settings dialog. Everything below still requires editing source:

- **Mood vocabulary** — `MOOD_VOCAB` in `controller/src/tag-library.js` (and the matching `mood` enum in the request-matcher's system prompt).
- **Picker behaviour** — `PICKER_SYSTEM` in `controller/src/ollama.js` defines the selection criteria.
- **Show clock** — `getTimeContext()` in `controller/src/context.js` maps hour-of-day to mood/vibe.
- **Festival calendar** — hardcoded list in `controller/src/context.js`.
- **Bitrate / format** — `output.icecast(%mp3(bitrate=192, …))` in `liquidsoap/radio.liq`.
- **Piper voice** — `PIPER_VOICE` env in `controller/.env` (paths inside the container).

## Tooling references

- [Liquidsoap docs](https://www.liquidsoap.info/doc-2.2.5/) — `crossfade`, `smooth_add`, `request.queue`, `playlist`
- [Icecast 2.4 docs](https://icecast.org/docs/icecast-2.4.1/)
- [Subsonic API](http://www.subsonic.org/pages/api.jsp) — Navidrome implements `1.16.1`
- [Piper TTS](https://github.com/rhasspy/piper)
- [Open-Meteo](https://open-meteo.com/) — free, no API key
