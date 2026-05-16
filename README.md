# SUB/WAVE

A real internet radio station. Single Icecast stream — every listener hears the same broadcast at the same time. An LLM-driven DJ picks tracks based on what just played, the time of day, weather, festivals, and listener requests; TTS (Piper, Kokoro, or a cloud voice) speaks intros, links, and time-checks between tracks. The station runs a roster of DJ personas — one on air at a time, each with its own name, voice, talk frequency, and skills — and a weekly show schedule can hand any hour to a specific persona. Everything is editable from the `/admin` operator console.

```
                    ┌─────────────────────────────────────────┐
                    │           Listeners (browsers)          │
                    │      <audio src="…/stream.mp3">         │
                    │      PWA-installable; lock-screen       │
                    │      controls via MediaSession API      │
                    └────────────────────┬────────────────────┘
                                         │ HTTP audio
                    ┌────────────────────▼────────────────────┐
                    │              ICECAST                    │
                    │       (broadcast endpoint, CORS on)     │
                    └────────────────────▲────────────────────┘
                                         │ source connection
                    ┌────────────────────┴────────────────────┐
                    │           LIQUIDSOAP                    │
                    │  • polls next.txt / say.txt / intro.txt │
                    │  • smart crossfade w/ full-buffer fade  │
                    │  • dual ducking: heavy (voice) + light  │
                    │    (talk-over links) via smooth_add     │
                    │  • mic chain: compress → echo on TTS    │
                    │  • on_metadata → now-playing.json       │
                    │  • auto.m3u + emergency.mp3 fallback    │
                    │  • brick-wall limiter only (−1 dBFS) —  │
                    │    masters otherwise pass untouched     │
                    │  • hourly archive output                │
                    └────────────────────▲────────────────────┘
                                         │ writes URIs + WAV paths
                    ┌────────────────────┴────────────────────┐
                    │         CONTROLLER (Node.js)            │
                    │  • Express API (admin gate optional in  │
                    │    dev, mandatory in production)        │
                    │  • now-playing watcher (1.5s)           │
                    │  • LLM via AI SDK: request match, DJ    │
                    │    scripts, mood tagging, track picker  │
                    │  • TTS: Piper / Kokoro / Cloud engines, │
                    │    per-persona voice + auto-fallback    │
                    │  • Scheduler + skills: auto.m3u, IDs,   │
                    │    weather, news — gated by frequency   │
                    │  • settings.json: persona roster,       │
                    │    weekly shows, mixer, TTS routing     │
                    │  • /cover/:id proxy for MediaSession    │
                    └─┬──────────┬──────────┬──────────────┬──┘
                      │          │          │              │
                  ┌───▼───┐  ┌───▼────┐ ┌───▼────────┐  ┌──▼──────────┐
                  │  LLM  │  │Navidrm │ │TTS: Piper, │  │ Open-Meteo  │
                  │       │  │Subsonic│ │Kokoro,Cloud│  │  (weather)  │
                  └───────┘  └────────┘ └────────────┘  └─────────────┘

                    ┌─────────────────────────────────────────┐
                    │       NEXT.JS WEB UI (App Router)       │
                    │  • /        — listener page OR landing  │
                    │               (SUBWAVE_HOMEPAGE flag)   │
                    │  • /listen  — always the player         │
                    │  • /landing — always the broadsheet     │
                    │  • /admin   — 7-page operator console   │
                    │               (single sign-in gate)     │
                    │  • PWA: installable, lock-screen        │
                    │    media controls, real cover art       │
                    └─────────────────────────────────────────┘
```

### Marketing landing vs player

`web/app/page.js` reads the `SUBWAVE_HOMEPAGE` env var at request time:

- `SUBWAVE_HOMEPAGE=landing` → renders the broadsheet landing with the live player embedded inline. Set this on the public marketing host.
- `SUBWAVE_HOMEPAGE=player` (default) → renders the fullscreen listener UI directly. Use this on private/Tailscale-only instances that don't need marketing.

The landing fetches a public `/api/dj` endpoint for the DJ's name and persona; everything else (now-playing, history, booth log) comes through the same 5-second polling used by the player.

## Why this architecture

Real radio = one stream, synced listeners. That needs a server-side audio mixer. Liquidsoap is the standard tool — what college radio, every small internet station uses. Icecast is the broadcast layer listeners connect to. The controller is the only bespoke piece; Liquidsoap and Icecast just do their well-understood jobs.

## What runs where

- **Icecast / Liquidsoap / Controller / Web / Caddy** — Docker Compose stack. Defaults assume `host.docker.internal` for the local Ollama.
- **LLM** — every model call goes through the Vercel AI SDK, so the provider is swappable from the admin Settings UI: Ollama (homelab default, no key), Anthropic, OpenAI, Google, OpenRouter, or the Vercel AI Gateway. Ollama runs on the host or any reachable host; default model `qwen2.5:7b`. Cloud API keys are read from each provider's standard env var (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY`) — see `controller/.env.example`.
- **Navidrome** — anywhere reachable. Controller talks Subsonic API.
- **Piper** — baked into the controller image, CPU-only. Default voice: `en_GB-alan-medium`. The universal TTS fallback.
- **Kokoro** — also baked into the controller image. Slower (~300–800 ms/line on CPU) but much more natural. British voice subset surfaced in Settings; default `bf_isabella`.
- **Cloud TTS** — optional third engine, routed through the AI SDK to OpenAI or ElevenLabs. Needs an API key (`OPENAI_API_KEY` / `ELEVENLABS_API_KEY`); falls back to a local engine when unconfigured.
- **Web UI** — Next.js dev server on port 7700 (dev) or behind Caddy as part of the prod compose file.

## Directory layout

```
sub-wave/
├── controller/
│   ├── src/
│   │   ├── server.js          # Express entry: middleware + route mounting
│   │   ├── settings.js        # Durable settings (personas, shows, skills,
│   │   │                      # mixer, TTS routing) + renderDjPrompt
│   │   ├── config.js          # Env-derived config (single source of truth)
│   │   ├── context.js         # Time / weather / festival → dominantMood;
│   │   │                      # getDateContext / getClockContext helpers
│   │   ├── routes/            # Express routers by surface: public, request,
│   │   │                      # dj, settings, jingles, debug
│   │   ├── middleware/        # cors, admin auth, request rate-limiting
│   │   ├── music/             # subsonic client, moods.json store, LLM picker,
│   │   │                      # standalone library tagger
│   │   ├── broadcast/         # queue + watcher, scheduler, jingles, dj-gate,
│   │   │                      # liquidsoap telnet control, tagger process
│   │   ├── audio/             # TTS dispatcher + Piper / Kokoro engines
│   │   ├── llm/               # AI SDK layer: provider registry, sdk
│   │   │                      # primitives, DJ prompts, tools, speech, log
│   │   └── skills/            # DJ skills (weather, news, traffic, facts)
│   ├── scripts/
│   │   └── kokoro_worker.py   # Long-lived Python worker (model resident)
│   ├── package.json           # npm run tag → src/music/tag-library.js
│   └── .env.example
├── web/                       # Next.js 15 App Router (PWA)
│   ├── app/
│   │   ├── page.js            # Listener page OR landing (SUBWAVE_HOMEPAGE)
│   │   ├── listen/page.js     # Always the listener
│   │   ├── landing/page.js    # Always the broadsheet
│   │   ├── setup/             # Interactive onboarding walkthrough
│   │   ├── admin/             # 7-page operator console, one sign-in gate
│   │   │   ├── page.js              # /admin → redirects to dash
│   │   │   ├── dash/page.js         # DJ command center
│   │   │   ├── library/page.js      # Search + queue, mood tagger
│   │   │   ├── personas/page.js     # Persona roster editor
│   │   │   ├── skills/page.js       # Autonomous-segment toggles
│   │   │   ├── shows/page.js        # Weekly schedule grid
│   │   │   ├── settings/page.js     # Station config + danger zone
│   │   │   └── debug/page.js        # Read-only system inspector
│   │   ├── manifest.js        # PWA manifest (icons, screenshots, display)
│   │   ├── icon.js / apple-icon.js  # Static launcher tiles
│   │   ├── icons/[size]/route.js    # Adaptive PNG icons
│   │   ├── screenshots/[variant]/route.js  # Install-dialog previews
│   │   └── layout.js          # Viewport-fit cover, Apple PWA metas
│   ├── components/
│   │   ├── PlayerApp.jsx      # Listener shell (audio + drawers)
│   │   ├── TopBar.jsx         # SUB/WAVE · with {djName} · time · weather
│   │   ├── CenterStage.jsx    # Now-playing title block
│   │   ├── Waveform.jsx       # Web Audio analyser, 120-bar render
│   │   ├── TransportBar.jsx   # Tune-in toggle, volume, elapsed, ticker
│   │   ├── DotRail.jsx        # Right-edge rail → queue/history/booth drawers
│   │   ├── BroadcastTicker.jsx # Inline voice+playing transcript
│   │   ├── ServiceWorkerRegister.jsx
│   │   ├── Landing.jsx        # Broadsheet wrapper
│   │   ├── landing/*          # Marketing sections (Masthead, Hero, …)
│   │   ├── admin/             # AdminShell, SettingsPanel, DebugPanel, SignInForm
│   │   ├── setup/             # Setup wizard UI
│   │   ├── drawers/           # Queue · History · Booth · Request
│   │   └── ui/                # Sheet, Toaster, primitives
│   ├── hooks/
│   │   ├── useStationFeed.js  # 5-s polling on /now-playing + /state
│   │   ├── usePlayer.js       # Audio el wrapper, tune in/out, volume
│   │   └── useMediaSession.js # OS lock screen / headphone / car controls
│   ├── public/sw.js           # Minimal service worker (avoids /sw.js 404)
│   └── .env.local             # NEXT_PUBLIC_API_URL / NEXT_PUBLIC_STREAM_URL
├── liquidsoap/
│   └── radio.liq              # Liquidsoap broadcast script (bind-mounted)
├── docker/
│   ├── docker-compose.yml         # Dev variant (no web container, no edge)
│   ├── docker-compose.prod.yml    # Prod (adds web + Caddy, host port 4800)
│   ├── Caddyfile                  # /api → controller, /stream.mp3 → icecast, else → web
│   ├── icecast.xml.template       # Rendered by setup.sh with random passwords
│   ├── Dockerfile.controller      # Node 22 + Piper + Kokoro (Python venv)
│   └── Dockerfile.liquidsoap
├── bin/
│   └── subwave                # `npm run setup` entry — interactive TUI
├── docs/                      # Deeper docs; docs/admin/ is the operator manual
├── mcp-subwave/               # Optional MCP server exposing station controls
├── DEPLOY.md                  # Production single-host deploy guide
├── package.json               # Root manifest: wizard + dev/down/logs/rebuild aliases
├── scripts/
│   ├── setup.mjs              # Interactive setup wizard (@clack/prompts)
│   ├── setup.sh               # Idempotent, no-sudo: state dirs, .env, emergency.mp3
│   ├── generate-jingles.sh    # Render default station idents via Piper
│   ├── generate-bed.sh        # Render warm pink-noise studio bed loop
│   ├── health-check.sh        # On-air probe
│   └── update.sh              # Prod: git pull + rebuild + rolling recreate
└── state/                     # Bind-mounted shared volume
    ├── settings.json          # Persona roster, shows, skills, mixer, TTS routing
    ├── auto.m3u               # Fallback playlist, refreshed every 60 min by default
    ├── jingles.m3u + jingles/ # Pre-recorded TTS stingers
    ├── emergency.mp3          # Pink-noise safety net
    ├── bed.mp3                # Continuous low-level studio bed (optional)
    ├── now-playing.json       # Written by Liquidsoap on every track change
    ├── moods.json             # LLM-tagged library (after running `npm run tag`)
    ├── liquidsoap_*.txt       # Tiny settings files Liquidsoap re-reads on start
    ├── voice/                 # TTS WAVs (auto-cleaned hourly)
    ├── archive/               # Hourly broadcast archives
    └── logs/radio.log
```

## Quick start (dev)

### Easy way — interactive wizard

Requires Node 20+ and Docker on the host — nothing else.

```bash
npm install
npm run setup
```

The wizard prompts for your Navidrome and Ollama details, writes `controller/.env`, runs `scripts/setup.sh` (icecast.xml, emergency.mp3, bed.mp3, docker/.env), brings up the dev docker stack, installs the web dependencies, waits for the controller to report on-air, optionally renders jingles, and optionally launches `next dev` on :7700 in the foreground.

Other npm scripts wrap the common loops:

| Script | What |
|---|---|
| `npm run setup` | Run the wizard end-to-end (alias: `npm run dev`) |
| `npm run dev:docker` | `docker compose up -d` in `docker/` |
| `npm run dev:web` | `next dev` on :7700 (in `web/`) |
| `npm run rebuild` | `docker compose up -d --build` (after controller source edits) |
| `npm run down` | Stop the docker stack |
| `npm run logs` | Tail docker compose logs |
| `npm run jingles` | Render station idents via Piper (dev compose) |

### Manual

```bash
# 1. Configure + state dir + emergency audio (idempotent)
./scripts/setup.sh
#   → creates state/, generates docker/.env with random Icecast passwords,
#     seeds controller/.env from .env.example, renders state/icecast.xml,
#     generates state/emergency.mp3 (ffmpeg borrowed from the Liquidsoap image)
# Edit controller/.env: NAVIDROME_URL / USER / PASS, OLLAMA_URL / MODEL

# 2. Web dev env (so the Next.js dev server hits the right hosts)
cat > web/.env.local <<EOF
NEXT_PUBLIC_API_URL=http://localhost:7701
NEXT_PUBLIC_STREAM_URL=http://localhost:7702/stream.mp3
EOF

# 3. Bring up the stack
cd docker && docker compose up -d --build

# 4. Web UI
cd ../web && npm install && npm run dev

# 5. Optional — render station idents
./scripts/generate-jingles.sh
```

Open:
- **Listener** — http://localhost:7700
- **Admin console** — http://localhost:7700/admin (admin-gated if `ADMIN_USER`/`ADMIN_PASS` are set)
- **Raw stream** — http://localhost:7702/stream.mp3
- **Icecast status** — http://localhost:7702/status-json.xsl

### Rebuild vs restart

- `controller`'s Dockerfile `COPY`s its source — source edits need `up -d --build controller`.
- `liquidsoap/radio.liq` is **bind-mounted** in both compose files, so script edits only need `docker compose restart liquidsoap` (no rebuild). A rebuild is only needed when `Dockerfile.liquidsoap` itself changes.
- `web` is hot-reloaded by `next dev` in development. The prod image is a Next.js standalone build — rebuild after web changes.

```bash
cd docker && docker compose up -d --build controller     # after controller/src/** edits
cd docker && docker compose restart liquidsoap           # after radio.liq edits
cd docker && docker compose up -d --build liquidsoap     # only if Dockerfile.liquidsoap changes
```

Note: `restart` keeps the existing container's env vars from creation time. For env changes use `up -d` to recreate and re-read `env_file`.

## Production (single host, Caddy edge)

```bash
./scripts/setup.sh    # state defaults to <repo>/state (override with STATE_DIR)
docker compose -f docker/docker-compose.prod.yml up -d
./scripts/generate-jingles.sh
./scripts/update.sh   # git pull + rebuild + rolling recreate
```

Only Caddy binds a host port (`4800:80`); Icecast, Controller, Liquidsoap, and Web are internal. Cloudflare is expected in front for TLS (`auto_https off` in the Caddyfile).

**Production hardens the admin gate**: the controller image runs with `NODE_ENV=production`, which makes `ADMIN_USER` + `ADMIN_PASS` mandatory. The controller will refuse to boot without them — `/admin`, `/settings`, `/jingles`, `/debug`, and the tagger endpoint are too revealing to leave unauthenticated on a public deploy.

## PWA / mobile

The web app ships as an installable PWA:

- **Add to home screen / Install** works on iOS and Chromium — comes from `app/manifest.js`, `app/icon.js`, `app/apple-icon.js`, `app/icons/[size]/route.js`, and `app/screenshots/[variant]/route.js` (ImageResponse-rendered install-dialog previews).
- **OS media controls** are wired via the MediaSession API in `useMediaSession`. Lock screen, AirPods, CarPlay, and Bluetooth headphones get the current title / artist / **real album cover art** (proxied through the controller's `/cover/:id` so Subsonic credentials stay server-side). Play/pause toggle tunes the stream in/out. Skip is intentionally omitted on the public listener — a stray AirPods double-tap shouldn't skip the song for every other listener.
- **Safe-area handling** — `viewport-fit: cover` plus `env(safe-area-inset-*)` padding on the top/transport bars, so installed mode on notched iPhones clears the Dynamic Island and home indicator.
- **Service worker** — minimal stub at `web/public/sw.js` so installs don't 404 on `/sw.js`.

## Admin console (`/admin`)

The operator console is a seven-page shell behind a single sign-in gate (`AdminShell` + `useAdminAuth`). `/admin` redirects to the Dash. The full operator manual lives in [`docs/admin/`](docs/admin/README.md).

| Page | What it's for |
|---|---|
| **Dash** (`/admin/dash`) | DJ command center — speak on air, fire any segment, skip the current track, flip the autonomous toggles, watch the live booth. |
| **Library** (`/admin/library`) | Search Navidrome and queue tracks directly; run the mood tagger. |
| **Personas** (`/admin/personas`) | The roster of DJ identities — name, soul, voice, talk frequency, skills. |
| **Skills** (`/admin/skills`) | Toggle the autonomous between-track segments (weather, news, …) station-wide. |
| **Shows** (`/admin/shows`) | The weekly schedule grid — assign shows to hours of the week. |
| **Settings** (`/admin/settings`) | Station config — TTS engine, LLM provider, mixer, jingles, danger zone. |
| **Debug** (`/admin/debug`) | Read-only system inspector — health, logs, recent LLM calls, state files. |

Most changes apply live: Personas, Skills, Shows, the LLM provider, station location, and the TTS fallback engine all take effect on the next spoken line or next pick. Crossfade duration and jingle ratio need a mixer restart (a ~3–5 s broadcast drop), flagged in the Settings danger zone. API keys are never entered in the UI — cloud LLM and TTS keys are read from `controller/.env`.

### Personas

The station keeps a roster of 1–12 personas; **one is on air at a time**, and a scheduled show can hand its hour to a different one. Each persona owns:

- **Name** — shown in the player (`SUB/WAVE with <name>`) and injected into LLM prompts as `{name}`. Required.
- **Soul** — a short personality sketch injected as `{soul}`. Layered with a random narrative "angle" and opener-anti-repeat so back-to-back lines differ in register.
- **Talk frequency** — `quiet` / `moderate` / `aggressive`. Controls DJ link interval, station-ID cadence, and skill gating. **Music selection is untouched** — frequency only controls how chatty the DJ is.
- **Voice** — the TTS engine + voice for this persona's spoken lines.
- **Skills** — which autonomous segments this persona may run.

The system prompt template (advanced) is editable per station — placeholders `{name}` (required), `{soul}`, `{station}`, `{location}`. Legacy single-DJ `settings.json` files (a `dj` block with `souls[]`) are migrated forward into the persona roster on load.

### Skills

A skill is an autonomous between-track segment — weather, news, traffic, random facts, web search. A skill fires only when it is **enabled** station-wide (on this page) **and assigned** to the persona on air. Each skill has its own cooldown; the persona's talk frequency gates timing. **Run now** fires one immediately, bypassing every gate.

### Shows

A show is a reusable programme — a name, topic, owning persona, and music mood — assigned to one-hour cells in a Mon–Sun grid. When the current hour has a show, its persona goes on air, its mood overrides the autonomous mood, and its topic is fed to the DJ as the theme. Empty hours run autonomously.

### TTS engines

Three engines, with a per-persona override and automatic fallback:

- **Piper** — fast local path (~30 ms/word); the universal fallback.
- **Kokoro** — local, slower but more natural; British voice subset surfaced in the UI.
- **Cloud** — routed via the AI SDK to OpenAI or ElevenLabs; needs an API key.

Each persona picks its own engine + voice (Personas page). The station-level default engine (Settings) renders jingles and is the fallback when a persona's engine fails. If the chosen engine errors, `tts.speak` retries on a local engine so the DJ never goes silent.

### Mixer & jingles

- **Crossfade duration** / **jingle ratio** — require a mixer restart.
- **Station location** — name / lat / lng; applies live, drives weather and `{location}`.
- **Jingles** — create TTS stingers from text, list and delete (the built-in default ident is protected).

## Admin auth

The admin surface is open by default in dev — fine for local iteration on a private network. To require Basic auth, set both env vars in `controller/.env`:

```
ADMIN_USER=admin
ADMIN_PASS=<something good>
```

Then `docker compose up -d controller` (not `restart`). The prod compose file forces `NODE_ENV=production`, which makes both vars mandatory — the controller exits on startup if either is missing.

What's protected: every admin endpoint — `/settings`, the `/dj/*` command-center routes, `/jingles`, `/restart-mixer`, `/stream-start`, `/stream-stop`, `/auto-pick`, `/tag-library`, `/debug`.

What stays public: `/now-playing`, `/state`, `/request`, `/dj`, `/cover/:id`, `/health`.

The `/admin` UI shows an in-app sign-in form on 401 and caches `base64(user:pass)` in `localStorage`. There's a sign-out control inside the shell.

## How the auto-DJ picks tracks

The picker runs **once per track change**, fired by the now-playing watcher. By the time the current track ends, the next one is already sitting in Liquidsoap's `dj_queue`.

Candidate pool (mixed and capped at 18, then de-duped):

1. **Similar songs from the current track** — strongest contextual signal (`getSimilarSongs2`, Last.fm adjacency)
2. **Mood-tagged library** — tracks matching `dominantMood` from `state/moods.json`
3. **Mood-matched Navidrome playlists** — operator's hand curation (any playlist whose name contains the mood word)
4. **Recently-added albums** — surfaces new music without needing tags
5. **Frequent albums** — scrobble-backed favourites
6. **Similar-artist top songs** — adjacency through Last.fm artist graph (`getArtistInfo2` → `getTopSongs`)
7. **Starred + random** — final fallback if everything above is empty

Recently-played track IDs (last 25) are filtered out everywhere. Expensive lookups (playlists, recent/frequent albums, similar-artist) are memoised for 30 min so the per-pick load stays in single digits.

The LLM gets the last 8 plays (title, artist, moods, energy), the current context, and the candidate pool, and returns `{ id, reason }`. The reason and the candidate source label are both logged and visible on `/admin/debug`. An opt-in **agent path** (`settings.llm.pickerAgent`) instead hands the LLM the music-discovery tools in `llm/tools.js` and lets it search the library itself, falling back to the pool path on any failure.

If the LLM is down or returns garbage, the controller logs the error and does nothing — Liquidsoap falls back to `auto.m3u` (refreshed every 60 min by default from the same broad source mix) so audio never stops.

Toggle the LLM picker:

```bash
curl -X POST http://localhost:7701/auto-pick \
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

Energy: `low | medium | high`. Stats appear on `/admin/debug` once at least one track is tagged.

## Listener requests

```bash
curl -X POST http://localhost:7701/request \
  -H 'Content-Type: application/json' \
  -d '{"text": "something for late-night driving", "name": "Alex"}'
```

Flow: the LLM parses intent → resolves it across several pick strategies (artist+sort like "latest album by X", search-term match, mood library, similar-to-current, dominant-mood, starred) → generates a contextual DJ intro that can weave the listener's own words into the announcement → TTS renders the intro WAV → both pushed to Liquidsoap. The intro plays through the heavy-duck `voice_queue` so the music drops well underneath.

Special cases handled directly: `more like this` plays another track by the current artist; rate-limiting returns a friendly 429 with `Retry-After`.

User requests jump to the front of the controller's `upcoming` queue. **Caveat:** an LLM pre-pick already sitting in Liquidsoap's `dj_queue` will still play before your request — it can't be cancelled from outside without telnet/server hooks.

The web Request drawer renders a success card on match (with the DJ's ack + queue position) and auto-closes after ~2.8 s; on no-match it shows an inline error so you can retry without losing the textbox contents.

## Scheduler & skills

A node-cron driver fires the scheduled segments; the persona on air and its talk frequency (`quiet`/`moderate`/`aggressive`) gate most of them:

| When | What |
|---|---|
| Top of every hour | Time-check — `quiet` every 2nd hour, `moderate`/`aggressive` every hour |
| `:00`/`:15`/`:30`/`:45` | Station ID — `quiet` `:45` only, `moderate` `:15`+`:45`, `aggressive` all four |
| Every 5 min | Skills tick — the registry picks at most one eligible skill (weather, news, traffic, random facts, web search); per-skill cooldown + frequency + persona assignment gate it |
| Every `AUTO_QUEUE_REFRESH_MINUTES` (default 60) | `auto.m3u` refresh for the current mood |
| Hourly | Old voice WAV cleanup |

Plus randomised DJ links between auto-played tracks — interval scales with frequency (`quiet` 8-20 tracks, `moderate` 1-9 / 10-15, `aggressive` 1-3).

Voice routing:
- **Solo voice** (station ID, hourly, weather, skills, listener-request intros) goes through `voice_queue` → **heavy duck** (`smooth_add` p=0.25, music drops to ~25%).
- **Talk-over links** between auto tracks go through `intro_queue` → **light duck** (p=0.40, ~40%) so the song you just queued stays audibly underneath.

## Endpoints (controller, port 7701)

Public:

| Method | Path | What |
|---|---|---|
| GET | `/health` | Liveness |
| GET | `/now-playing` | `{ nowPlaying, context, dj: { name }, listeners }` |
| GET | `/dj` | Public DJ + station info for the landing page |
| GET | `/state` | Queue snapshot — `{ current, upcoming, history, djLog }` |
| GET | `/cover/:id` | Cached proxy for Subsonic cover art (MediaSession) |
| POST | `/request` | Listener request — `{ text, name? }` |

Admin (gated when `ADMIN_USER`/`ADMIN_PASS` are set; mandatory in production):

| Method | Path | What |
|---|---|---|
| GET / POST | `/settings` | Read or update station config — personas, shows, skills, mixer, TTS routing |
| POST | `/dj/*` | Command-center actions — `say`, `segment`, `skill`, `skip`, `queue-track`, `search`, `recent`, … |
| POST | `/restart-mixer` | Telnet → Liquidsoap shutdown → container restart |
| POST | `/stream-start`, `/stream-stop` | Take the broadcast on / off air |
| GET / POST / DELETE | `/jingles[/:filename]` | Manage pre-rendered TTS stingers |
| POST | `/auto-pick` | Toggle the LLM picker |
| POST | `/tag-library` | Kick off the mood tagger as a background process |
| GET | `/debug` | Everything-at-a-glance JSON |

## Stopping it

```bash
npm run down
# or, manually:
cd docker && docker compose down
```

State (`settings.json`, `moods.json`, voice WAVs, archives) is persisted in `./state/` by default, in both dev and prod (override prod with `${STATE_DIR}`). Restart anytime with `npm run dev:docker` (or `docker compose up -d`).

## Known caveats

- **Pre-picked AI tracks play before subsequent listener requests** (see [Listener requests](#listener-requests)).
- **Mood biasing only works after `npm run tag`.** Until then the picker pulls from similar-songs, recently-added, frequent, similar-artist, and starred without a tag filter.
- **Liquidsoap log can grow unbounded.** `state/logs/radio.log` has no rotation configured.
- **No listener-facing skip** — Liquidsoap controls pacing; track-end is the natural transition. An operator can force-end the current track from the admin Dash (`POST /dj/skip`), but there is no public skip — a stray AirPods tap shouldn't skip the song for everyone.
- **Admin auth uses Basic auth over HTTP** — fine behind Cloudflare/Caddy with TLS, but don't expose port 7701 raw to the internet.
- **Kokoro adds ~30 s of cold-start latency** on the first segment after a controller boot while the model loads in the Python worker. Subsequent calls reuse the resident process.

## Customisation (code-level, beyond Settings)

Things you can change without touching code now live in the `/admin` console (personas, shows, skills, mixer, TTS routing, weather, jingles). Everything below still requires editing source:

- **Mood vocabulary** — `MOOD_VOCAB` in `controller/src/music/tag-library.js` (and the matching `mood` enum in the request-matcher's system prompt).
- **Picker behaviour** — `PICKER_SYSTEM` in `controller/src/llm/dj.js` defines the selection criteria; per-source caps (`CAP_SIMILAR`, `CAP_MOOD_LIBRARY`, …) live at the top of `controller/src/music/picker.js`.
- **Show clock** — `getTimeContext()` in `controller/src/context.js` maps hour-of-day to mood/vibe; `getDateContext` / `getClockContext` expose day/season/commute flags to the DJ prompts.
- **Festival calendar** — hardcoded list in `controller/src/context.js`.
- **Bitrate / format** — `output.icecast(%mp3(bitrate=192, …))` in `liquidsoap/radio.liq`.
- **Mic chain / ducking / broadcast bus** — all in `liquidsoap/radio.liq`. Bind-mounted, so changes only need `docker compose restart liquidsoap`.
- **Piper voice** — `PIPER_VOICE` / `PIPER_VOICE_CONFIG` env in `controller/.env` (paths inside the container).
- **Kokoro defaults** — `KOKORO_*` env in `controller/.env` (model, voices, default voice, speed). The Settings UI overrides the voice per-station.

## Tooling references

- [Liquidsoap docs](https://www.liquidsoap.info/doc-2.2.5/) — `crossfade`, `smooth_add`, `request.queue`, `playlist`
- [Icecast 2.4 docs](https://icecast.org/docs/icecast-2.4.1/)
- [Subsonic API](http://www.subsonic.org/pages/api.jsp) — Navidrome implements `1.16.1`
- [Piper TTS](https://github.com/rhasspy/piper)
- [Kokoro TTS](https://github.com/thewh1teagle/kokoro-onnx)
- [Open-Meteo](https://open-meteo.com/) — free, no API key

## Contributing

Bug reports, ideas, and pull requests are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md).
Security issues should be reported privately per [`SECURITY.md`](SECURITY.md).

## License

SUB/WAVE is released under the [MIT License](LICENSE).
