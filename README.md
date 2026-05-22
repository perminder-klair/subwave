# SUB/WAVE

**A personal internet radio station.** One Icecast stream, one broadcast —
every listener hears the same thing at the same time. An AI DJ picks the
tracks, writes the links, and reads station idents, the time, and the weather
between songs. Listeners can request music in plain language; the DJ matches
it, intros it, and queues it.

It is *radio*, not a playlist. There is no per-listener shuffle, no skip
button, no "up next for you." You tune in and hear whatever is on.

## Live demo

- **Landing page** — [radio.klair.co](https://radio.klair.co/)
- **Demo player** — [radio.klair.co/listen](https://radio.klair.co/listen)

## Screenshots

**The listener player** — one shared broadcast, with in-app song requests.

<img src="web/public/screenshots/listen.webp" alt="Player — the listener player on /listen" width="640">

<img src="web/public/screenshots/player-request-song.webp" alt="Player — request a song" width="260">

**The admin console** — where the operator runs the station.

| | |
|---|---|
| <img src="web/public/screenshots/admin-dash.webp" alt="Admin — Dash: live status, queue, booth log" width="100%"> | <img src="web/public/screenshots/admin-personas.webp" alt="Admin — Personas: the DJ roster" width="100%"> |
| **Dash** — live status, the queue, the booth log | **Personas** — the DJ roster, each with its own voice |
| <img src="web/public/screenshots/admin-shows.webp" alt="Admin — Weekly schedule grid" width="100%"> | <img src="web/public/screenshots/admin-skills.webp" alt="Admin — Skills: what the DJ does between tracks" width="100%"> |
| **Shows** — a 24×7 schedule you paint | **Skills** — what the DJ does between tracks |
| <img src="web/public/screenshots/admin-stats.webp" alt="Admin — Stats: LLM and TTS usage" width="100%"> | <img src="web/public/screenshots/admin-debug.webp" alt="Admin — Debug: health, logs, LLM calls" width="100%"> |
| **Stats** — LLM and TTS usage at a glance | **Debug** — health, logs, recent LLM calls |

## Why it's built this way

A playlist is a list you control. Radio is a broadcast you join. SUB/WAVE
deliberately chooses the second model:

- **One shared stream.** A single Icecast mount everyone connects to. The
  shared-moment quality is the point — it's the difference between a jukebox
  and a station.
- **No skip.** Track-end is the only natural transition. The DJ — human-curated
  personas plus an LLM — owns pacing, not the listener. (Operators *can* skip
  via the admin API; listeners cannot.)
- **AI as the DJ, not the catalogue.** The music is your own library (served by
  Navidrome over the Subsonic API). The LLM curates, sequences, and talks — it
  doesn't generate the music or replace your taste.
- **Self-hosted and swappable.** Runs on one Linux box behind Cloudflare. The
  LLM provider is swappable at runtime (Ollama, Anthropic, OpenAI, Google,
  OpenRouter, Vercel AI Gateway) with no redeploy.

## Architecture

Four cooperating processes. The load-bearing design fact: the **controller**
and **Liquidsoap** talk only through files in a shared `state/` directory —
there is no socket or RPC channel between them.

```
                                  ┌───────────────────────────┐
   Navidrome  ◀── Subsonic API ───│        Controller         │
   (your music library)           │   (Node.js / Express)     │
                                  │                           │
   LLM provider ◀── AI SDK ───────│  • AI DJ: picks tracks,   │
   (Ollama / Anthropic / …)       │    writes links & idents  │
                                  │  • session + scheduler    │
   Open-Meteo ◀── weather ────────│  • text-to-speech (TTS)   │
                                  │  • HTTP API (:7701)       │
                                  └─────────────┬─────────────┘
                                                │  file-based IPC
                                   shared state/ │  next.txt · say.txt
                                                │  intro.txt · auto.m3u
                                                ▼  now-playing.json
                                  ┌───────────────────────────┐
                                  │        Liquidsoap         │
                                  │  • queue → auto-playlist  │
                                  │  • crossfade + voice duck │
                                  │  • jingles, limiter       │
                                  │  • encodes MP3            │
                                  └─────────────┬─────────────┘
                                                │ source connect
                                                ▼
                                  ┌───────────────────────────┐
                                  │   Icecast  (:7702)        │──▶ /stream.mp3
                                  └───────────────────────────┘
                                                ▲
   Browser / PWA ◀── audio ───────────────────┘
   (Next.js web UI :7700, polls controller for now-playing)

   Production: Cloudflare ─HTTPS─▶ host :80 (Caddy) ─▶ web · controller · icecast
```

### The four processes

| Process | What it does |
|---|---|
| **Controller** (`controller/`, Node/Express) | The brain. Runs the AI DJ — picks tracks, writes links/idents, matches listener requests, runs the cron scheduler, renders TTS. Exposes the HTTP API. |
| **Liquidsoap** (`liquidsoap/radio.liq`) | The mixing desk. Builds the audio pipeline: request queue → auto-playlist, crossfades, ducks voice over music, mixes jingles, brick-wall limiter, encodes to MP3. |
| **Icecast** | The transmitter. Serves the single `/stream.mp3` mount to every listener. |
| **Web UI** (`web/`, Next.js 15) | The receiver. Player, marketing landing page, setup walkthrough, and an admin shell for settings/debug. PWA-installable with OS lock-screen controls. |

### File-based IPC

Everything that flows between the controller and Liquidsoap goes through one
of these files in `state/`:

| File | Direction | Purpose |
|---|---|---|
| `next.txt` | controller → LS | Next annotated track URI. LS polls every 1.0s. |
| `say.txt` | controller → LS | WAV path for a spoken segment (station ID, time, weather, request intro). Heavy-ducked over music. |
| `intro.txt` | controller → LS | WAV path for a between-track DJ link. Light-ducked so the new song stays audible. |
| `auto.m3u` | controller → LS | Fallback playlist for the current mood, rewritten hourly. |
| `now-playing.json` | LS → controller/UI | Current track metadata, written from Liquidsoap's metadata hook. |

The web UI polls the controller over HTTP (`/now-playing`, `/state` every 5s).
Browsers pull audio directly from Icecast.

## Quick start (local dev, Mac smoke test)

The operator CLI's **setup wizard** handles the whole first boot — preflight
checks, Navidrome + LLM + admin credentials (each probed live), the env files,
`scripts/setup.sh` (icecast.xml + studio audio), and `docker compose up -d`.
From the repo root:

```bash
npm install            # CLI runtime deps (the tsx loader)
npm start -- setup     # interactive wizard — pick "dev"
npm run dev:web        # web UI on :7700 — a separate, hot-reloading process
```

In dev the wizard runs Icecast + Liquidsoap + Controller in Docker; only the
Next.js web UI runs as a separate host process. You'll need a reachable
**Navidrome** instance and an **LLM provider** — the homelab default is a local
**Ollama** box (no API key needed); the wizard collects and probes both.

Running the steps by hand instead — see *Common commands* in
[`CLAUDE.md`](CLAUDE.md).

The same CLI doubles as the console for running the station. Run `npm start`
for a status-aware menu; every menu action is also a one-shot subcommand —
append it after `npm start --`:

```bash
npm start                       # interactive operator console (status-aware menu)
npm start -- setup              # first-boot wizard — Navidrome, LLM, admin, env files
npm start -- status             # compose env, services, now-playing, recent events
npm start -- doctor             # full diagnostic sweep
npm start -- start dev          # docker compose up -d (dev or prod)
npm start -- restart liquidsoap # plain restart (radio.liq is bind-mounted)
npm start -- restart controller # rebuild + recreate (source is COPY-d at build)
npm start -- logs controller    # tail one service
npm start -- play               # SUB/WAVE TUI — the terminal player
npm start -- listen             # open the web player in a browser
npm start -- admin              # open the admin console in a browser
npm start -- stop               # docker compose down (confirms first)
```

## Production deploy

Single Linux host, Cloudflare terminating TLS, Caddy routing to four internal
services. The same setup wizard covers first boot — run it on the host and
pick **"prod"**:

```bash
npm install
npm start -- setup     # prod mode — runs scripts/setup.sh, builds and starts
                       # the prod stack, waits for /health, offers to render jingles
```

See **[`DEPLOY.md`](DEPLOY.md)** for the full walkthrough — host prerequisites,
secrets, Cloudflare setup, updates, and backup.

## Repository layout

```
controller/        Node.js controller — the AI DJ brain
  src/llm/         LLM layer (AI SDK): provider registry, prompts, tools
  src/broadcast/   queue, session, DJ agent, scheduler, jingles
  src/music/       Subsonic client, pool picker, library tagging
  src/audio/       TTS engines: Piper, Kokoro, Chatterbox, cloud
  src/routes/      HTTP API split by surface (public, request, settings, …)
liquidsoap/        radio.liq — the Liquidsoap mixing pipeline
web/               Next.js 15 web UI (player, landing, admin, setup)
tui/               Terminal player — the listener UI, in your terminal
docker/            Two compose files (dev + prod), Caddyfile, Dockerfiles
scripts/           setup, jingle generation, update, health check
mcp-subwave/       MCP server — lets an agent request songs / drive the DJ
cli/               Operator CLI (TS, run via tsx loader — no build step)
bin/subwave        Operator CLI entry — setup, status, doctor, lifecycle, play
```

## Notable details

- **Controller code needs a rebuild, not a restart** — its source is `COPY`d at
  image build time. `radio.liq` is bind-mounted, so a Liquidsoap restart is
  enough after editing it.
- **The LLM provider is swappable at runtime** from the admin UI — every model
  call goes through the Vercel AI SDK.
- **There is no `/skip` for listeners.** Track-end is the only natural
  transition; operators have an admin-only skip endpoint.
- Several areas (queue/playback path, `radio.liq`, the crossfade, voice
  ducking, the LLM layer) have **non-obvious constraints** that are easy to
  regress. Read the relevant note in **[`CLAUDE.md`](CLAUDE.md)** before
  touching them.

## Documentation

- **[`DEPLOY.md`](DEPLOY.md)** — production deployment, updates, backup.
- **[`CLAUDE.md`](CLAUDE.md)** — deep architecture reference and the
  non-obvious constraints behind each subsystem.
- **[`CONTRIBUTING.md`](CONTRIBUTING.md)** — how to contribute.
- **[`SECURITY.md`](SECURITY.md)** — reporting security issues.
- **[`mcp-subwave/README.md`](mcp-subwave/README.md)** — the MCP server.

## License

[MIT](LICENSE).
