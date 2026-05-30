# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SUB/WAVE is a personal internet radio station: one Icecast stream, all listeners hear the same broadcast, AI DJ picks tracks and reads scripts between them. See `README.md` for the architecture diagram and rationale.

## Common commands

There are three operator entry points: the **standalone `subwave` CLI** (single binary, no clone, default for new installs), raw `docker compose` (the no-CLI alternative), and `npm start` (contributor convenience inside a cloned repo). All three drive the same compose files and write to the same `state/` layout.

```bash
# --- standalone CLI (default — single binary, no clone, no Node host dep) ---
curl -fsSL https://cli.getsubwave.com | sh   # installs /usr/local/bin/subwave; if TTY, offers to scaffold+start via non-interactive `subwave init --yes` (interactive prompts over a pipe hang Bun's stdin on macOS — oven-sh/bun#13374)
subwave init                              # scaffolds ~/subwave + compose + .env; ends with a "Bring the stack up now?" confirm that chains into `start`
subwave start                             # docker compose up -d; env auto-resolved from preferredEnv (set by init) or filesystem heuristic — no prompt
subwave setup                             # configure Navidrome / LLM / TTS / DJ
subwave logs controller                   # tail any service
subwave self-update                       # re-fetch the binary from the latest release

# --- raw docker (no CLI) ---
./scripts/setup.sh                       # scaffolds a 3-var root .env + state/
docker compose up -d                     # docker-compose.yml (bundled Caddy prod) is the default
# Then visit http://localhost:7700/onboarding to finish Navidrome/LLM/TTS/DJ config.
./scripts/update.sh                      # git pull + rebuild + rolling recreate

# --- production (BYO reverse proxy: Traefik / nginx / existing Caddy) ---
docker compose -f docker-compose.byo.yml up -d

# --- dev (Mac smoke test, requires git clone) ---
docker compose -f docker-compose.dev.yml up -d     # Broadcast (icecast2 + liquidsoap) + Controller (hot-reload via tsx watch)
cd web && npm install && npm run dev               # web UI on :7700, separate process

# Common one-offs
docker compose logs -f controller        # prod default
curl http://localhost:7700/api/health    # liveness via Caddy edge (prod)
```

The CLI resolves its install location via `SUBWAVE_HOME` (priority: `--home` flag → `SUBWAVE_HOME` env → `~/.config/subwave/config.json` → cwd if it has a `docker-compose.yml` → `~/subwave` if it exists → error). That last fallback is what makes `cd subwave-repo && npm start` work for contributors with zero config.

There is no `/skip` endpoint — track-end is the only natural transition. Liquidsoap controls pacing.

**Compose files live at the repo root**, not under `docker/`. Run `docker compose ...` from the repo root; the legacy `cd docker && docker compose ...` pattern is gone (one root `.env` is all the configuration surface there is for boot — everything else lives in `state/settings.json` and is managed by the wizard + admin UI).

**Dev controller hot-reloads; prod controller needs a rebuild.** In the dev compose, `controller/src/` and `controller/scripts/` are bind-mounted into the container and the command is overridden to `tsx watch`, so edits restart the process in-place — no `docker compose build`. In **prod** the controller image `COPY`s source at build time, so `docker compose restart controller` reruns the *same baked-in code* and any change needs `up -d --build controller`. `broadcast` mirrors this split: `radio.liq` is bind-mounted in the dev compose only, so dev edits just need a restart; prod bakes it (and `icecast.xml.template`) into the image and needs a rebuild + recreate.

```bash
docker compose -f docker-compose.dev.yml restart controller  # rarely needed in dev — tsx watch handles src/** edits
docker compose up -d --build controller     # after controller/src/** in PROD
docker compose -f docker-compose.dev.yml restart broadcast   # after radio.liq edits in DEV — bind-mounted, no rebuild
docker compose up -d --build broadcast      # after radio.liq / icecast.xml.template / Dockerfile.broadcast in PROD
```

`web` is a Next.js dev server in local mode (`npm run dev`), so it hot-reloads — no rebuild needed for UI changes during dev. Production builds the web image; treat it like the others there.

No test runner is configured. `controller/` and `web/` each expose `npm run lint` (`eslint . && tsc --noEmit`); CI runs both on every PR via `.github/workflows/lint.yml` and they are the merge gate.

## Architecture

Four cooperating processes with **file-based IPC** through a shared `state/` directory (mounted at `/var/sub-wave` in containers). This is the load-bearing fact about how the system works:

- **Controller → Liquidsoap**:
  - `next.txt` — controller writes one annotated track URI; Liquidsoap polls every 1.0s, drains, and `request.queue.push`es it (`liquidsoap/radio.liq`).
  - `say.txt` — controller writes a WAV path; Liquidsoap polls every 0.5s and feeds it through `voice_queue`, which is **heavy-ducked** (`smooth_add p=0.25`) over the music bus. Used for station IDs, hourly time, weather, and listener-request intros.
  - `intro.txt` — separate channel for between-track auto-DJ links. Liquidsoap polls every 0.5s and feeds it through `intro_queue`, which is **light-ducked** (`smooth_add p=0.40`) so the song that just started stays audible underneath the voice.
  - `auto.m3u` — fallback playlist the controller rewrites every `AUTO_QUEUE_REFRESH_MINUTES` (default 60) for the current mood; Liquidsoap reloads it on file change (`reload_mode="watch"`).
  - `liquidsoap_jingle_ratio.txt` / `liquidsoap_crossfade.txt` — tiny text files written by `settings.update()`. Read once at `radio.liq` startup; changes require a Liquidsoap restart (which the controller can trigger via `/restart-mixer` → telnet `shutdown`).
- **Liquidsoap → Controller / UI**:
  - `now-playing.json` — written from `music_meta.on_metadata(on_meta)`. Hook is on `music_meta` — the **pre-cross** handle captured before `music` is wrapped in `cross(...)`. Hooking the post-cross source fires twice per transition because the custom `dj_transition` passes `initial_metadata=` into both `fade.in` and `fade.out`, freezing the UI one song behind. `on_metadata` is used instead of `on_track` because `on_track` gets swallowed by source switches (request queue → auto playlist).
- **Controller → Web UI**: HTTP. The `useStationFeed` hook (`web/hooks/useStationFeed.js`) polls `/now-playing` and `/state` every 5s.
- **Controller state**: `session.json` — the live DJ session (a chat-history JSON, see `broadcast/session.js`) the controller rewrites as tracks play and the DJ talks; archived sessions land in `state/sessions/<id>.json` on roll. Controller-internal — not read by Liquidsoap.
- **Browsers → Icecast**: direct `<audio src="…/stream.opus">` on modern browsers, `…/stream.mp3` on everything else. `usePlayer` (`web/hooks/usePlayer.ts`) runs `canPlayType('audio/ogg; codecs=opus')` once on mount and picks the Opus mount when supported (`probably`/`maybe`), landing roughly equal-or-better audio at ~half the bandwidth. Both mounts are served by the same Icecast — Liquidsoap parallel-encodes the same `radio` source bus into MP3 192 kbps and Ogg-Opus 96 kbps (`radio.liq` `make_stream_outputs()`). MP3 is the universal fallback for Sonos, hardware internet radios, car receivers, and pre-iOS-17 Safari. The `useMediaSession` hook wires lock-screen / headphone / CarPlay controls to the player, with artwork served from the controller's `/cover/:id` proxy.

Anything that needs to flow between the controller and Liquidsoap must go through one of these files — there is no socket or RPC channel.

### Controller (`controller/src/`, ESM Node.js)

Source is grouped by domain. `server.js`, `config.js`, `settings.js`, and `context.js` sit at the root; everything else lives under `routes/`, `middleware/`, `music/`, `broadcast/`, `audio/`, `llm/`, and `skills/`.

- `server.js` — thin Express entry point: applies middleware and mounts the route modules, then runs the startup block. **`routes/`** splits the API by surface — `public.js` (`GET /health`, `/now-playing`, `/state`, `/dj`, `/cover/:id`), `request.js` (`POST /request`), `settings.js` (`GET /POST /settings`, `POST /restart-mixer`, `POST /auto-pick`), `jingles.js` (`GET /POST /DELETE /jingles[/:filename]`, `POST /tag-library`), `debug.js` (`GET /debug`). **`middleware/`** holds `cors.js`, `auth.js` (the `requireAdmin` Basic-auth gate via `ADMIN_USER` + `ADMIN_PASS`, plus the prod-mandatory startup check), and `ratelimit.js`. CORS is wide open (`*`). **In production (`NODE_ENV=production`, set by `docker-compose.yml` and `docker-compose.byo.yml`) the gate is mandatory** — the controller exits on startup if `ADMIN_USER`/`ADMIN_PASS` aren't set, because the admin surface is too revealing to expose unauthenticated.
- `broadcast/queue.js` — in-memory `upcoming`/`history`/`djLog` plus `drainToLiquidsoap()`, the single writer of `next.txt` (and, via `tts.speak`, `say.txt` for request intros). `announce()` is the single writer of `say.txt` / `intro.txt` for scheduled segments — it picks the target file based on kind (`'link'` → `intro.txt`, everything else → `say.txt`). **All track playback goes through `queue.push()`; all spoken segments go through `queue.announce()`.** Request-intro TTS is written ~250 ms before the track URI so Liquidsoap picks up the voice file first.
- **LLM layer (`llm/`)** — every model call goes through the Vercel AI SDK (`ai` package), so the provider is swappable:
  - `llm/provider.js` — provider registry. Resolves an AI SDK `LanguageModel` from `settings.llm` (`provider` ∈ `ollama` | `openai-compatible` | `anthropic` | `openai` | `google` | `deepseek` | `openrouter` | `gateway`; `model`; optional `apiKey`). `ollama` is the homelab default and needs no key. `openai-compatible` targets any self-hosted OpenAI-compatible server (llama.cpp, vLLM, LM Studio…) via `llm.baseUrl` — it uses the `/v1/chat/completions` endpoint (`provider.chat(id)`), since these servers don't implement the Responses API. Switching provider in the admin UI reroutes every call — no redeploy, no call-site change.
  - `llm/sdk.js` — the three primitives every call uses: `djText` (free-text generation), `djObject` (Zod-validated structured output via `generateText` + `Output.object`), and `djAgent` (a `ToolLoopAgent` tool-loop fed a `messages` array + a step cap, returning schema-validated output — the primitive behind `broadcast/dj-agent.js`).
  - `llm/log.js` — 30-entry ring buffer of recent LLM calls for `/debug`.
  - `llm/tools.js` — AI SDK `tool()` definitions wrapping Subsonic/library music discovery; consumed by the session DJ agent.
  - `llm/speech.js` — the `cloud` TTS engine (AI SDK `generateSpeech` → OpenAI / ElevenLabs).
- `llm/dj.js` — the DJ **prompt layer** (was `ollama.js`; renamed when the LLM layer moved onto the AI SDK). Builds prompts and hands them to `llm/sdk.js`:
  1. `matchRequest` — structured output: a Zod schema (`search_terms`, `mood`, `intent`, `ack`, plus `artist`/`scope`/`sort`) validates the result; no manual JSON parsing.
  2. `generate*` (intro, link, weather, station ID, hourly) is free-text under a DJ persona system prompt. Each call picks a **random soul** from `settings.dj.souls` (1–10 personas) plus a random narrative **angle**, on top of an opener-anti-repeat list from `queue.getRecentOpeners()`. Hard rules in the prompt template — don't loosen them without reason.
- `broadcast/session.js` — the **stream session**: a runtime instance of the DJ's current run (a scheduled show, or an autonomous block), carrying a `messages` chat history of turns — events, the DJ's replies, track plays, spoken segments, each timestamped. Persisted to `state/session.json`; archived to `state/sessions/<id>.json` on roll. `sessionKeyFor()` derives identity from the active show (`show:<id>`) or from time-period + dominant mood (`auto:<period>:<mood>`); `maybeRoll()` ends + restarts the session when that key changes or it ages past 4 h, carrying a one-line text handoff forward. `windowMessages()` maps the last ~40 turns onto an AI SDK `messages` array (consecutive same-role turns coalesced). `recover()` resumes the persisted session on boot if its key still matches.
- `broadcast/dj-agent.js` — the **session DJ agent**: handles "a track started — pick the next one (+ maybe a link)" (`runTrackEvent`, called by `queue.onTrackStarted`) and "a listener requested X" (`runRequest`, called by `POST /request`). It posts an event turn, then runs a `ToolLoopAgent` over `session.windowMessages()` with the `llm/tools.js` discovery tools; the output (chosen track, optional spoken link/intro) is enqueued and appended back as turns. Gated on `settings.llm.pickerAgent` (default **on**); when off, or on any failure, it falls back to the stateless pool picker + `dj.generateLink` / the `/request` matcher cascade — still inside the session, still logged.
- `music/picker.js` — the stateless **pool picker**, `dj-agent`'s fallback. `pickViaPool()` builds a balanced candidate pool from 7 sources (similar-songs, mood-tagged library, mood-matched playlists, recently-added albums, frequent albums, similar-artist top songs, starred+random fallback), caps/dedupes, and hands ≤18 candidates + the last 8 plays to the LLM (one `djObject` call). Expensive Subsonic calls are memoised for 30 min.
- `music/subsonic.js` — Navidrome client using proper Subsonic salt+token MD5 auth (never plaintext). `getAnnotatedUri(song)` wraps the URI in `annotate:title="…",artist="…",subsonic_id="…":<uri>` so Liquidsoap reports real metadata immediately instead of waiting on stream ID3, and so the `on_metadata` hook can recover the song id for the cover-art proxy. Also exposes `getSimilarSongs`, `getArtistInfo`, `getTopSongs`, `getPlaylists`/`getPlaylist`, `getRecentlyAddedAlbums`, `getFrequentAlbums`, and `getCoverArtUrl` — all used by the picker and `/cover/:id`.
- `settings.js` — durable settings stored at `/var/sub-wave/settings.json`. Validates+persists; on save it also writes the tiny `liquidsoap_*.txt` files Liquidsoap reads on startup. `renderDjPrompt({name, soul, …})` substitutes `{name}/{soul}/{station}/{location}` into the operator-supplied template; the legacy single-string `dj.soul` is migrated forward into `dj.souls[]` on load. **`{name}` is mandatory in the template** — `update()` refuses any custom prompt that drops it, so dialogue can never become anonymous.
- `audio/tts.js` — engine dispatcher across five engines: `piper`, `kokoro`, `chatterbox`, `pocket-tts`, and `cloud` (`llm/speech.js`, AI SDK → OpenAI/ElevenLabs). Per-kind override (`settings.tts.byKind`) falls through to `settings.tts.defaultEngine` (default `piper`). On any failure it falls back to a local engine — `piper` is the universal fallback — so the DJ never goes silent. All callers (`broadcast/queue.js`, `broadcast/jingles.js`, `broadcast/scheduler.js`) go through `tts.speak()` — don't import the engine modules directly.
- `audio/piper.js` — spawns Piper CLI, writes WAV to `config.piper.outDir`, returns the path. Cleans files older than 1 h. Fast path (~30 ms/word).
- `audio/kokoro.js` — manages a persistent Python worker (`controller/scripts/kokoro_worker.py`) that loads the kokoro-onnx model once and stays resident. Slower than Piper (~300–800 ms/line on CPU) but much more natural. `isAvailable()` lets `tts.speak` short-circuit the fallback chain if the venv/model isn't present.
- `context.js` — `getFullContext()` returns `{ time, weather, festival, dominantMood }`. **Priority for `dominantMood` is festival > weather > time** — this is what `refreshAutoPlaylist` and the picker key off. `getDateContext` / `getClockContext` expose day/season/weekend/late-night/commute flags to the DJ prompts. Open-Meteo is cached 30 min; festivals are a hardcoded list keyed to the operator's calendar.
- `broadcast/scheduler.js` — node-cron driver. Auto-playlist refresh every `config.show.autoQueueRefreshMinutes` (default 60). Cron ticks fire at the most aggressive cadence (top of hour, every 15 min, `:00/:15/:30/:45`); `shouldFire(kind)` (in `broadcast/dj-gate.js`) gates each handler on `settings.dj.frequency` (`quiet` / `moderate` / `aggressive`) so quiet stations get the time check every 2 hours and only a `:45` station ID, while aggressive ones get all four idents and a weather update every 15 min. Weather only announces on condition change.
- `broadcast/liquidsoap-control.js` — opens a telnet socket to Liquidsoap on port 1234 and issues the custom `restart` server command, which calls `shutdown()` and lets the container's restart policy bring it back ~3 s later with the new `liquidsoap_*.txt` values applied.
- `music/library.js` / `music/tag-library.js` — `moods.json` store + standalone tagger (`npm run tag [-- --limit N]`). Resumable, saves every 25 tags.
- `broadcast/jingles.js` — pre-rendered TTS stinger management. Writes WAVs into `${STATE_DIR}/jingles/`, rewrites `jingles.m3u`, and updates `jingles.json` (metadata). The `default-id` ident is protected from deletion. `broadcast/tagger.js` tracks the background tag-library child process for the `/tag-library` and `/settings` routes.
- `config.ts` — single source of truth for env-derived config. Defaults point at `localhost`; override every URL via the root `.env`. After `settings.load()` (and after `loadSetupConfig()` for the wizard overlay), `server.ts` mutates `config.*` to apply persisted values — env always wins, settings/wizard overlay fills the gaps.

### Liquidsoap (`liquidsoap/radio.liq`)

Pipeline (in order):

1. `dj_queue` (controller-fed `request.queue`) **fallback→** `auto_playlist` (`playlist(reload_mode="watch")`) → `music`.
2. **`music_meta` is captured here**, before the cross. This is what `on_metadata(on_meta)` hooks; hooking the post-cross source fires twice per transition.
3. `cross(duration=crossfade_duration, dj_transition, music)` — low-level `cross` operator (not the high-level `crossfade` wrapper, which silently routes through `simple_transition` and ignores custom callbacks). `dj_transition` builds `fade.out(d, …)` + `fade.in(d, …)` that span the **full** cross buffer, so the two tracks curve past each other at ~−6 dB midpoint and sum to ~unity. Earlier per-transition energy scaling caused audible doubling — don't reintroduce it; vary the cross buffer length instead.
4. Optional **studio bed** — `state/bed.mp3` mixed in at weight `0.02` (~34 dB below music) before voice ducking, so `smooth_add` ducks the bed along with the music when the DJ talks.
5. **Two stacked `smooth_add` ducking layers** — `voice_queue` (heavy, p=0.25) then `intro_queue` (light, p=0.40). Gated talkbax-style, not RMS-keyed: an earlier RMS sidechain follower drove `music_bus` to −91 dB even with the voice queue empty (see git log `f38a9af`). Both voice channels pass through the same `mic_chain` (compress → makeup gain → 40 ms slap echo). HPF and presence shelf are skipped — this Liquidsoap build hits "Early computation of source content-type" on IIR filters fed by `request.queue`.
6. `rotate(weights=[1, jingle_ratio], [jingles, radio])` — one jingle per N music tracks, configurable.
7. `fallback(track_sensitive=false, [radio, emergency])` → `blank.skip(max_blank=5s)`.
8. **Broadcast bus** — brick-wall limiter (ratio 20:1 at −1 dBFS) only. The earlier normaliser, stereo widener, and bus compressor were all removed because they reshaped the masters (pumping on dynamic content, altering the engineer's stereo image, tickling dynamics on loud passages). The limiter stays as a safety net — MP3 encoding generates inter-sample peaks that can exceed the source peak by ~0.5–1 dB, and without a −1 dBFS ceiling, modern masters (peaking at ~−0.3 dBFS TP) would clip in listeners' decoders. It typically does 0 dB of gain reduction on catalogue audio.
9. **Two parallel Icecast outputs** wrapped in a single `stream_on`/`stream_off` control (`make_stream_outputs()`): `%mp3(bitrate=192)` → `localhost:7702/stream.mp3` (universal compatibility floor — Sonos, hardware radios, car receivers, pre-iOS-17 Safari) **and** `%opus(bitrate=96, samplerate=48000, channels=2, application="audio", vbr="constrained")` → `localhost:7702/stream.opus` (modern browsers / VLC / cliamp — equal-or-better quality at ~half the bandwidth, picked automatically by the web player via `canPlayType`). Both mounts share the same `radio` source bus, so they always carry the same audio and the same listener metadata. `stream_off` / `stream_on` shut down or recreate both together. + `output.file(%mp3(bitrate=128), reopen_when={0m0s}, "/var/sub-wave/archive/%Y-%m-%d/%H-00.mp3")` for hourly archives (MP3-only — archives prioritise tooling compatibility).

Also: a custom `subhttp:` protocol shells out to `curl` (installed in `Dockerfile.broadcast`) because Liquidsoap's built-in `http.get.stream` returns spurious 522s on the Cloudflare-fronted Navidrome origin. A telnet server on port 1234 (reachable from the controller as `broadcast:1234` on the compose network) exposes a custom `restart` command.

### Web UI (`web/`)

Next.js 15 App Router with Tailwind. Routes:

- `/` — `PlayerApp` or `Landing`, chosen at request time by `SUBWAVE_HOMEPAGE` (`player` default, `landing` for the marketing host).
- `/listen` — always the player.
- `/landing` — always the broadsheet.
- `/setup` — setup-guide docs (Overview, Prerequisites, Quick Start, Manual Install, Development, Updates).
- `/onboarding` — interactive first-run wizard (the in-browser counterpart to `npm run setup`).
- `/admin`, `/admin/settings`, `/admin/debug` — admin shell. **Single sign-in gate** (`AdminShell` + `useAdminAuth` in `web/lib/adminAuth.js`) replaces the old in-player Settings modal and the standalone `/debug` route. Credentials are cached in `localStorage` as `base64(user:pass)` and dropped on sign-out.

PWA-installable: `app/manifest.js`, `app/icon.js` + `apple-icon.js`, `app/icons/[size]/route.js` for Android adaptive sizes, `app/screenshots/[variant]/route.js` for install-dialog previews (rendered via `next/og` ImageResponse — beware Satori's constraints: only flex/block/none/-webkit-box `display` values, divs with multiple children need an explicit `display: flex`). `web/public/sw.js` is a minimal service worker (just enough to avoid a /sw.js 404 on install). `useMediaSession` wires the OS lock-screen / headphone / car-display controls; **skip is intentionally omitted** on the listener side so a stray AirPods double-tap doesn't skip the song for every listener.

Polling: `useStationFeed` hits `/now-playing` + `/state` every 5s. Stream URL and API base default to same-origin (`/api`, `/stream.mp3`) for the production image; dev overrides via `web/.env.local` (`NEXT_PUBLIC_API_URL=http://localhost:7701`, `NEXT_PUBLIC_STREAM_URL=http://localhost:7702/stream.mp3`).

### Docker layout

Three compose files at the repo root, three deployment shapes:

- **`docker-compose.yml`** — production single-host deploy with bundled Caddy. **This is the default** (`docker compose up -d` on a fresh host does the right thing). Includes `broadcast` (icecast2 + liquidsoap in one container), `controller`, `web` (built from `web/Dockerfile`, Next.js standalone output), and `caddy` (edge router). **Only Caddy binds a host port (`${CADDY_PORT:-7700}:80`)** — Broadcast, Controller, and Web are internal-only and reachable via the proxy. State path is `${STATE_DIR:-./state}` — repo-local by default; override with `STATE_DIR` to relocate it. Cloudflare is expected to terminate TLS in front; Caddy has `auto_https off`. The `controller` service is forced into `NODE_ENV=production`, which makes the admin auth gate mandatory — the container will exit on boot if `ADMIN_USER`/`ADMIN_PASS` aren't in the root `.env`. Caddyfile, radio.liq, icecast.xml.template, and sounds/ are baked into images here, not bind-mounted.
- **`docker-compose.byo.yml`** — production deploy for hosts that already run Traefik, nginx, or their own Caddy. Identical to the default prod file but with the bundled Caddy removed; `web`, `controller`, and `broadcast` bind directly to host ports (`${WEB_PORT:-7700}`, `${CONTROLLER_PORT:-7701}`, `${ICECAST_PORT:-7702}`) for the operator's reverse proxy to front. (Liquidsoap lives inside the broadcast container — it has no public surface.) The web image still expects same-origin `/api` and `/stream.mp3` (it's baked at build time), so the operator's proxy should replicate the route table in `docker/Caddyfile` against a single hostname; split hostnames need a custom web rebuild with `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_STREAM_URL`.
- **`docker-compose.dev.yml`** — "Mac local smoke-test variant". Broadcast + Controller only. Web UI runs separately via `npm run dev`. State is `./state` (repo-local bind mount). Used for local development. Keeps bind mounts for `./liquidsoap/radio.liq`, `./sounds`, and `./controller/src` so dev edits don't need a rebuild (controller runs under `tsx watch`).

**Optional `tts-heavy` profile in all three composes.** A fifth service, `tts-heavy`, is defined in every compose file behind `profiles: ["tts-heavy"]` — it does NOT start unless the operator opts in with `docker compose --profile tts-heavy up -d`. When enabled, it brings up the `subwave-tts-heavy` sidecar that hosts Chatterbox + PocketTTS over HTTP, mounted on the same shared `/var/sub-wave` volume as the controller so WAV outputs are visible to Liquidsoap by path. Off by default keeps the install lean for the majority of operators who only need Piper / Kokoro / cloud TTS.

**Image-first pulls, source-build fallback.** Every service references `ghcr.io/perminder-klair/subwave-{caddy,broadcast,controller,web,tts-heavy}:${SUBWAVE_VERSION:-latest}` alongside a `build:` block. `docker compose up -d` pulls by default; `docker compose build && docker compose up -d` rebuilds locally from source. Pin a release with `SUBWAVE_VERSION` in the root `.env`. Publishing is driven by `.github/workflows/publish-images.yml`, which builds the five images on tag pushes (`v*`) and on manual `workflow_dispatch`.

**Auto-generated Icecast secrets.** The `subwave-broadcast` image bakes `icecast.xml.template` and a supervisor entrypoint (`docker/broadcast-entrypoint.sh`) that resolves `ICECAST_*_PASSWORD` with this precedence: env override → persisted `state/icecast-secrets.env` → freshly generated random hex. Resolved values are written back to `state/icecast-secrets.env` (kept around for operator visibility and to honour the "delete file + restart to rotate" path), then exported into liquidsoap's env before it launches. Because icecast and liquidsoap are now in the same container, the cross-container handshake is gone — the controller no longer needs to coordinate on the secrets at all. To rotate: delete `state/icecast-secrets.env` and restart `broadcast` (then `controller` if you also changed the public hostname / URL).

**Single config surface.** Three required env vars in the root `.env` are all you need to boot: `ADMIN_USER`, `ADMIN_PASS`, `SITE_URL`. Everything else (Navidrome creds, LLM provider/key, TTS engine, DJ persona, station name) is collected by one of two converging wizards:

- **`npm run setup`** — terminal CLI under `cli/src/commands/setup.ts` (Clack prompts, interactive, deeper probes).
- **`/onboarding`** — browser wizard under `web/components/onboarding/*` talking to `controller/src/routes/onboarding.ts` (no clone, no Node needed — the path operators reach after a `curl`-and-`docker compose up` install).

Both write to the same persistence layer: Navidrome creds + the setup-complete timestamp go to `state/setup-config.json`; cloud LLM/TTS API keys go to `state/secrets.env` (mode 0600, sourced into `process.env` on controller boot via `controller/src/setup/secrets.ts`); everything else flows through `settings.update()` into `state/settings.json`. Env vars from the root `.env` always win — the wizard surfaces only fill in fields env doesn't supply. `controller/src/setup/firstRun.ts` decides `needsSetup` (true when neither env nor `setup-config.json` provide Navidrome creds); `/state` exposes that boolean so the player + AdminShell can redirect a fresh operator into `/onboarding`.

The shared `/var/sub-wave` mount in **both** the Broadcast and Controller containers is what makes the file-based IPC work — they must always be mounted to the same host path. (Inside the broadcast container, liquidsoap and icecast share that mount with the supervisor entrypoint and use it for the secrets file, queue files, logs, archive, jingles, etc.)

### Caddy routing (`docker/Caddyfile`)

One origin, three backends:

- `/stream.mp3` → `broadcast:7702` with `flush_interval -1` so the audio stream isn't buffered.
- `/api/*` → `controller:7701`, prefix stripped via `handle_path` so the controller keeps its existing routes (`/now-playing`, `/state`, `/request`, `/dj`, `/cover/:id`, `/health`, plus admin endpoints).
- everything else → `web:7700`.

The web app uses same-origin defaults (`/api`, `/stream.mp3`), so the production image needs no `NEXT_PUBLIC_*` env vars. For dev (separate ports), override via `web/.env.local`.

### Jingles

`state/jingles.m3u` is empty by default. Run `scripts/generate-jingles.sh` after the stack is up — it `docker compose exec`s into the controller container and pipes text through the configured TTS engine (Piper or Kokoro, whichever is bound to the `jingle` kind in settings), writing WAVs into `${STATE_DIR}/jingles/` and rewriting the M3U. Liquidsoap's jingles `playlist(...)` uses `reload_mode="watch"`, so new renders are picked up without a restart.

## Working on this codebase

- Touching the queue/playback path: `queue.drainToLiquidsoap()` is the single writer of `next.txt` (and the request-intro `say.txt`); `queue.announce()` is the single writer of scheduled `say.txt` / `intro.txt`. Request-intro WAVs are written ~250 ms before the track URI so Liquidsoap's 0.5s voice poll picks them up first. Liquidsoap's polling intervals (1.0s for queue, 0.5s for both voice channels) are the upper bound on perceived latency.
- Touching `radio.liq`: the `on_metadata` hook must stay attached to `music_meta` — the **pre-cross** handle. Hooking the post-cross `music` fires twice per transition because `dj_transition` passes `initial_metadata=` into both `fade.in` and `fade.out`. Don't switch to `on_track` either; `on_track` gets swallowed by source switches.
- Touching the crossfade: keep the fade duration equal to the cross buffer (`d = crossfade_duration()` and `fade.out(duration=d, …)` / `fade.in(duration=d, …)`). Shorter fades inside a fixed-width buffer let the outgoing track play at full volume while the incoming is ramping, summing to +6 dB and producing an audible doubling. Vary the cross buffer length (e.g. via `override_duration`) instead.
- Touching ducking: stick with `smooth_add`. An RMS sidechain follower drove `music_bus` to silence (`f38a9af` in git log). `smooth_add` is gated talkbax — it doesn't care how loud the voice is, only whether the channel has signal, which is exactly what a broadcast desk's talk button emulates.
- Touching TTS: callers go through `tts.speak(text, { kind })` — not `piper.speak` / `kokoro.speak` / `chatterbox.speak` / `pocketTts.speak` directly. `tts.js` handles the per-kind engine override and the automatic fallback to the other engine on failure. The Kokoro worker script path defaults to `/app/scripts/kokoro_worker.py` (where `Dockerfile.controller` puts it); set `KOKORO_WORKER` if you're running the controller from a non-default layout (e.g. a single-container build where it lives at `/app/controller/scripts/kokoro_worker.py`).
- **Chatterbox + PocketTTS live in an optional `subwave-tts-heavy` sidecar.** Both are heavy PyTorch engines (Chatterbox Turbo ~2-3 GB, PocketTTS smaller but still drags torch in) that the controller image deliberately doesn't carry. The recommended deployment is the sidecar — a separate `ghcr.io/perminder-klair/subwave-tts-heavy` image started via `docker compose --profile tts-heavy up -d`. The controller is wired with `TTS_HEAVY_URL=http://tts-heavy:8080` in all three compose files unconditionally; when the profile is off, the URL is unreachable, `isAvailable()` reports false, and the dispatcher falls back to Piper. When the profile is on, `controller/src/audio/chatterbox.ts` and `audio/pocketTts.ts` route `speak()` over HTTP to the sidecar, which writes the WAV onto the shared `/var/sub-wave` volume and returns the path — same semantics as the local-spawn path, just with an HTTP hop. See `docker/Dockerfile.tts-heavy` + `docker/tts-heavy/server.py` for the sidecar (FastAPI + a single asyncio.Lock per engine to serialise CPU-bound inference). `controller/src/audio/ttsHeavyClient.ts` is the controller-side client; it caches the result of a 30 s `/health` probe so `isAvailable()` stays synchronous for the dispatcher.
- **Legacy in-process Chatterbox / PocketTTS (still supported).** The `--build-arg WITH_CHATTERBOX=1` / `--build-arg WITH_POCKETTTS=1` blocks in `docker/Dockerfile.controller` still produce a venv at `/opt/{chatterbox,pocket-tts}/venv` inside the controller image. The mode switch in each engine module is purely env-driven: if `TTS_HEAVY_URL` is set, sidecar wins; otherwise the engine spawns its local Python worker (`controller/scripts/chatterbox_worker.py`, `controller/scripts/pocket_tts_worker.py`) over stdio exactly as before. Keep this path working — operators who built custom images on the old pattern shouldn't be forced to switch in a single release.
- **Shared reference-WAV folder.** Chatterbox and PocketTTS both read clone references from `config.voices.dir` (default `<STATE_DIR>/voices`, override via `TTS_VOICE_DIR`; `CHATTERBOX_VOICE_DIR` is honoured for back-compat). `chatterbox.listReferenceVoices()` is the single listing path — `/settings` returns it as both `chatterboxVoices` and `pocketTtsCustomVoices`. The pre-#213 path `<STATE_DIR>/chatterbox-voices/` is still scanned + resolved as a fallback, so existing installs don't need a manual move; logged once at boot if non-empty. On filename clash, the canonical `voices/` copy wins. The shared volume is the same `/var/sub-wave` mount the controller and sidecar already use — no extra mount surface.
- **Chatterbox specifics that survive both modes.** (1) Per-request `reference_wav` enables zero-shot voice cloning — each persona carries its own reference WAV in `tts.voice` (a filename in `config.voices.dir`, default `<STATE_DIR>/voices`), which both the local worker and the sidecar read from the shared volume. (2) Paralinguistic tags (`[laugh]`, `[sigh]`, `[chuckle]`, `[cough]`) render as actual non-verbal sounds, NOT spoken words — `llm/dj.ts` only mentions them in the system prompt when the on-air persona's engine is `chatterbox`, never for piper/kokoro/pocket-tts/cloud (those engines would read the tag as the literal word).
- **PocketTTS specifics that survive both modes.** kyutai-labs' 100M-param CPU-only model, ~6× real-time, ~200 ms TTFB, built-in voices in EN/FR/DE/IT/ES/PT. `tts.voice` accepts either a built-in voice id (`alba`, `anna`, `charles`, `estelle`, `giovanni`, `juergen`, `lola`, `rafael`) OR a `.wav` filename in `config.voices.dir` for zero-shot cloning (issue #213). `controller/src/audio/pocketTts.ts:resolveVoice` does the split; when a clone is requested, `reference_wav` rides alongside the built-in voice (used as a fallback prior if the clone load fails). Unknown built-in ids passing the regex are forwarded to the worker / sidecar, which falls back to its configured default if the model rejects them, so a stale persona value never silences a segment. PocketTTS' raw output has wider dynamic range than Piper/Kokoro — both the local worker and the sidecar RMS-normalise to ~−14.3 dBFS and clip at −0.5 dBFS so spoken loudness matches the other local engines on the music bus. Don't drift the constants between the two implementations.
- Touching Subsonic: keep using `getAnnotatedUri` for anything going to Liquidsoap. Raw stream URLs work but lose metadata until ID3 arrives, and the `on_metadata` hook needs `subsonic_id` so the controller's `/cover/:id` proxy can serve MediaSession artwork.
- LLM calls go through the AI SDK (`llm/sdk.js`). `matchRequest` and the pool picker use `djObject` — the AI SDK validates the response against a Zod schema, so there's no manual JSON parsing or regex recovery to maintain. The provider is whatever `settings.llm` selects; default is the homelab Ollama box, which may be slow but is reliable — don't add aggressive retry.
- Adding an LLM provider: extend `LLM_PROVIDERS` in `settings.js` and the `switch` in `llm/provider.js`. Call sites never name a provider — they call `djText`/`djObject`, which resolve the model through the registry.
- DJ persona: the configured `settings.dj.souls` is an **array** (1–10 entries). `djSystem()` in `llm/dj.js` picks one at random per call. Legacy single-string `dj.soul` is migrated on load. Adding entries broadens the rotation; emptying the array falls back to the seeded defaults in `DJ_SOULS`.
- Festivals in `context.js` are a hand-curated general calendar (Western/UK plus a couple of cross-cultural markers like Diwali and Vaisakhi). Fixed-date only — lunar-shifted holidays (Easter, Eid, Lunar New Year) aren't representable in the current schema. Adding/removing entries changes what the autonomous DJ plays around those dates.
