# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SUB/WAVE is a personal internet radio station: one Icecast stream, all listeners hear the same broadcast, AI DJ picks tracks and reads scripts between them. See `README.md` for the architecture diagram and rationale.

## Common commands

Three operator entry points, all driving the same compose files + `state/` layout: the **standalone `subwave` CLI** (single binary, no clone — default for new installs), raw `docker compose` (no-CLI alternative), and `npm start` (contributor convenience inside a clone).

```bash
# --- standalone CLI (single binary, no clone, no Node host dep) ---
curl -fsSL https://cli.getsubwave.com | sh   # installs /usr/local/bin/subwave; offers to scaffold+start
subwave init        # scaffolds ~/subwave + compose + .env; chains into start
subwave start       # docker compose up -d; env auto-resolved, no prompt
subwave setup       # configure Navidrome / LLM / TTS / DJ
subwave logs controller
subwave self-update

# --- raw docker (no CLI) ---
./scripts/setup.sh                       # scaffolds 3-var root .env + state/
docker compose up -d                     # docker-compose.yml (bundled Caddy prod) is the default
# then visit http://localhost:7700/onboarding to finish Navidrome/LLM/TTS/DJ config
./scripts/update.sh                      # git pull + rebuild + rolling recreate

docker compose -f docker-compose.byo.yml up -d     # prod, BYO reverse proxy (Traefik/nginx/Caddy)

# --- dev (Mac smoke test, requires git clone) ---
docker compose -f docker-compose.dev.yml up -d     # Broadcast (icecast2+liquidsoap) + Controller (tsx watch)
cd web && npm install && npm run dev               # web UI on :7700, separate process

docker compose logs -f controller        # prod default
curl http://localhost:7700/api/health    # liveness via Caddy edge (prod)
```

The CLI resolves its install location via `SUBWAVE_HOME` (priority: `--home` → `SUBWAVE_HOME` env → `~/.config/subwave/config.json` → cwd if it has a `docker-compose.yml` → `~/subwave` if it exists → error). The cwd fallback is what makes `cd subwave-repo && npm start` work with zero config.

There is no `/skip` endpoint — track-end is the only natural transition. Liquidsoap controls pacing.

**Compose files live at the repo root**, not under `docker/`. One root `.env` is the entire boot config surface — everything else lives in `state/settings.json`, managed by the wizard + admin UI.

**Dev hot-reloads; prod needs a rebuild.** In dev compose, `controller/src/`, `controller/scripts/`, and `radio.liq` are bind-mounted and the controller runs `tsx watch`, so edits restart in-place. In **prod** images `COPY` source at build time, so `restart` reruns the *same baked-in code* — changes need `up -d --build`.

```bash
docker compose -f docker-compose.dev.yml restart controller  # rarely needed — tsx watch handles src/** edits
docker compose -f docker-compose.dev.yml restart broadcast   # after radio.liq edits in DEV (bind-mounted)
docker compose up -d --build controller     # after controller/src/** in PROD
docker compose up -d --build broadcast      # after radio.liq / icecast.xml.template / Dockerfile.broadcast in PROD
```

`web` runs as a Next.js dev server (`npm run dev`) and hot-reloads in dev; prod builds the web image and needs a rebuild like the others.

No test runner. `controller/` and `web/` each expose `npm run lint` (`eslint . && tsc --noEmit`); CI runs both on every PR (`.github/workflows/lint.yml`) and they are the merge gate.

## Architecture

Four cooperating processes with **file-based IPC** through a shared `state/` dir (mounted at `/var/sub-wave` in containers). This is the load-bearing fact about how the system works — there is no socket or RPC channel between controller and Liquidsoap.

- **Controller → Liquidsoap**:
  - `next.txt` — controller writes one annotated track URI; Liquidsoap polls every 1.0s, drains, and `request.queue.push`es it.
  - `say.txt` — WAV path; polled every 0.5s, fed through `voice_queue`, **heavy-ducked** (`smooth_add p=0.25`). Station IDs, hourly time, weather, request intros.
  - `intro.txt` — between-track auto-DJ links; polled every 0.5s, fed through `intro_queue`, **light-ducked** (`smooth_add p=0.40`) so the song that just started stays audible under the voice.
  - `auto.m3u` — fallback playlist the controller rewrites every `AUTO_QUEUE_REFRESH_MINUTES` (default 60) for the current mood; Liquidsoap reloads on file change (`reload_mode="watch"`).
  - `liquidsoap_*.txt` (jingle_ratio, crossfade, opus_enabled) — tiny files written by `settings.update()`, read once at `radio.liq` startup. Changes need a Liquidsoap restart (controller triggers via `/restart-mixer` → telnet).
- **Liquidsoap → Controller / UI**:
  - `now-playing.json` — written from `music_meta.on_metadata(on_meta)`. The hook must stay on `music_meta`, the **pre-cross** handle captured before `music` is wrapped in `cross(...)`. Hooking the post-cross source fires twice per transition (because `dj_transition` passes `initial_metadata=` into both `fade.in` and `fade.out`), freezing the UI one song behind. `on_metadata` is used instead of `on_track` because `on_track` gets swallowed by source switches (request queue → auto playlist).
- **Controller → Web UI**: HTTP. `useStationFeed` (`web/hooks/useStationFeed.js`) polls `/now-playing` + `/state` every 5s.
- **Controller state**: `session.json` — the live DJ session (chat-history JSON, see `broadcast/session.js`); archived to `state/sessions/<id>.json` on roll. Controller-internal, not read by Liquidsoap.
- **Browsers → Icecast**: direct `<audio>` on `…/stream.opus` (Blink) or `…/stream.mp3` (everything else). `usePlayer` (`web/hooks/usePlayer.ts`) probes `canPlayType('audio/ogg; codecs=opus')` once and upgrades to Opus only on a definitive `'probably'` **and** non-iOS, non-Firefox (both choke on Icecast's chained-Ogg page boundary at a crossfade — issues #168/#215). Opus is **off by default** (see Liquidsoap step 9), so the probe usually 404s and the hook falls back permanently to MP3 for the session. MP3 is the universal floor (Sonos, hardware radios, car receivers, pre-iOS-17 Safari). `useMediaSession` wires lock-screen / headphone / CarPlay controls, artwork from the controller's `/cover/:id` proxy.

### Controller (`controller/src/`, ESM Node.js)

Grouped by domain: `server.js`, `config.js`, `settings.js`, `context.js` at the root; everything else under `routes/`, `middleware/`, `music/`, `broadcast/`, `audio/`, `llm/`, `skills/`.

- `server.js` — thin Express entry: applies middleware, mounts routes, runs startup. **`routes/`** splits the API by surface: `public.js` (`/health`, `/now-playing`, `/state`, `/dj`, `/cover/:id`), `request.js` (`POST /request`), `settings.js` (`/settings`, `/restart-mixer`, `/auto-pick`), `jingles.js`, `debug.js`. **`middleware/`** holds `cors.js` (wide open `*`), `auth.js` (the `requireAdmin` Basic-auth gate via `ADMIN_USER`/`ADMIN_PASS`), `ratelimit.js`. **In prod (`NODE_ENV=production`, set by both prod compose files) the gate is mandatory** — the controller exits on boot if `ADMIN_USER`/`ADMIN_PASS` aren't set.
- `broadcast/queue.js` — in-memory `upcoming`/`history`/`djLog` + `drainToLiquidsoap()`, the **single writer of `next.txt`** (and request-intro `say.txt` via `tts.speak`). `announce()` is the **single writer of scheduled `say.txt`/`intro.txt`** (picks target by kind: `'link'` → `intro.txt`, else `say.txt`). All track playback goes through `queue.push()`; all spoken segments through `queue.announce()`. Request-intro TTS is written ~250ms before the track URI so Liquidsoap picks up the voice file first.
- **LLM layer (`llm/`)** — every model call goes through the Vercel AI SDK (`ai` package), so the provider is swappable with no call-site change:
  - `llm/provider.js` — registry. Resolves a `LanguageModel` from `settings.llm` (`provider` ∈ ollama | openai-compatible | anthropic | openai | google | deepseek | openrouter | gateway; `model`; optional `apiKey`). `ollama` is the homelab default, no key. `openai-compatible` targets self-hosted servers (llama.cpp, vLLM, LM Studio) via `llm.baseUrl` + `/v1/chat/completions`.
  - `llm/sdk.js` — three primitives: `djText` (free text), `djObject` (Zod-validated structured output), `djAgent` (a `ToolLoopAgent` tool-loop — the primitive behind `broadcast/dj-agent.js`).
  - `llm/log.js` — 30-entry ring buffer of recent calls for `/debug`. `llm/tools.js` — `tool()` defs wrapping Subsonic/library discovery for the DJ agent. `llm/speech.js` — the `cloud` TTS engine (AI SDK `generateSpeech` → OpenAI/ElevenLabs).
- `llm/dj.js` — the DJ **prompt layer**. Builds prompts and hands them to `llm/sdk.js`: `matchRequest` (structured output, Zod-validated) and `generate*` (intro/link/weather/station-ID/hourly, free text). Each free-text call picks a **random soul** from `settings.dj.souls` + a random narrative angle, on top of an opener-anti-repeat list from `queue.getRecentOpeners()`. Hard rules live in the prompt template — don't loosen without reason.
- `broadcast/session.js` — the **stream session**: the DJ's current run as a `messages` chat history of timestamped turns. Persisted to `state/session.json`; archived on roll. `sessionKeyFor()` derives identity from the active show (`show:<id>`) or time-period+mood (`auto:<period>:<mood>`); `maybeRoll()` ends+restarts when that key changes or it ages past 4h. `windowMessages()` maps the last ~40 turns to an AI SDK `messages` array; `recover()` resumes on boot if the key still matches.
- `broadcast/dj-agent.js` — the **session DJ agent**: `runTrackEvent` (track started → pick next + maybe a link) and `runRequest` (listener requested X). Posts an event turn, runs a `ToolLoopAgent` over `session.windowMessages()` with `llm/tools.js`, enqueues the output and appends it back as turns. Gated on `settings.llm.pickerAgent` (default **on**); off or on any failure, falls back to the stateless pool picker + `dj.generateLink` / the `/request` matcher — still inside the session, still logged.
- `music/picker.js` — the stateless **pool picker** (dj-agent's fallback). `pickViaPool()` builds a balanced pool from 7 sources (similar-songs, mood-tagged library, mood playlists, recently-added/frequent albums, similar-artist top songs, starred+random), caps/dedupes to ≤18 candidates + last 8 plays, one `djObject` call. Expensive Subsonic calls memoised 30 min.
- `music/subsonic.js` — Navidrome client, proper Subsonic salt+token MD5 auth (never plaintext). **`getAnnotatedUri(song)`** wraps the URI in `annotate:title=…,artist=…,subsonic_id=…:<uri>` so Liquidsoap reports metadata immediately (not waiting on ID3) and the `on_metadata` hook can recover the song id for `/cover/:id`. Also `getSimilarSongs`, `getArtistInfo`, `getTopSongs`, `getPlaylists`, `getRecentlyAddedAlbums`, `getFrequentAlbums`, `getCoverArtUrl`. **`isStationArchive(song)`** is the guard that keeps SUB/WAVE's own hourly archive mixdowns (path `archive/YYYY-MM-DD/HH-00.mp3`) out of selection/enumeration when a co-located Navidrome scans the archive dir — every song-returning function filters through it, so the picker/tagger/library UI never see junk `HH-00` "tracks" (issue #273). The `state/archive` dir should not be inside the Navidrome music library; the broadcast entrypoint also drops a `.ndignore` there as belt-and-suspenders.
- `settings.js` — durable settings at `/var/sub-wave/settings.json`. Validates+persists; on save also writes the `liquidsoap_*.txt` files. `renderDjPrompt({name, soul, …})` substitutes into the operator template; legacy `dj.soul` string is migrated into `dj.souls[]` on load. **`{name}` is mandatory in the template** — `update()` refuses any custom prompt that drops it.
- `audio/tts.js` — engine dispatcher across `piper`, `kokoro`, `chatterbox`, `pocket-tts`, `cloud`. Per-kind override (`settings.tts.byKind`) falls through to `settings.tts.defaultEngine` (default `piper`). On any failure falls back to a local engine (`piper` is the universal fallback) so the DJ never goes silent. **All callers go through `tts.speak(text, {kind})`** — never the engine modules directly.
- `audio/piper.js` — Piper CLI, WAV to `config.piper.outDir`, cleans files >1h. Fast (~30ms/word). `audio/kokoro.js` — persistent Python worker (`controller/scripts/kokoro_worker.py`) holding the kokoro-onnx model resident; slower (~300–800ms/line CPU) but more natural. `isAvailable()` short-circuits the fallback chain if the venv/model is absent.
- `context.js` — `getFullContext()` → `{ time, weather, festival, dominantMood }`. **`dominantMood` priority is festival > weather > time** — what `refreshAutoPlaylist` and the picker key off. Open-Meteo cached 30 min; festivals a hardcoded fixed-date list (lunar holidays aren't representable).
- `broadcast/scheduler.js` — node-cron. Auto-playlist refresh every `autoQueueRefreshMinutes` (default 60). Ticks fire at the most aggressive cadence (`:00/:15/:30/:45`); `shouldFire(kind)` (`broadcast/dj-gate.js`) gates each handler on `settings.dj.frequency` (quiet/moderate/aggressive). Weather only announces on condition change.
- `broadcast/liquidsoap-control.js` — telnet to Liquidsoap port 1234, custom `restart` command (`shutdown()` + restart policy brings it back ~3s later with new `liquidsoap_*.txt` values).
- `music/library.js` / `music/tag-library.js` — `moods.json` store + resumable standalone tagger (`npm run tag [-- --limit N]`, saves every 25). `broadcast/jingles.js` — pre-rendered TTS stinger management (WAVs into `${STATE_DIR}/jingles/`, rewrites `jingles.m3u`/`jingles.json`; `default-id` protected from deletion). `broadcast/tagger.js` tracks the background tagger child process.
- `config.ts` — single source of truth for env-derived config. Defaults to `localhost`; override every URL via root `.env`. After `settings.load()` + `loadSetupConfig()`, `server.ts` mutates `config.*` to apply persisted values — **env always wins**, settings/wizard fills the gaps.

### Liquidsoap (`liquidsoap/radio.liq`)

Pipeline in order:

1. `dj_queue` (controller-fed `request.queue`) **fallback→** `auto_playlist` (`playlist(reload_mode="watch")`) → `music`.
2. **`music_meta` captured here**, before the cross — this is what `on_metadata` hooks (see Architecture).
3. `cross(duration=crossfade_duration, dj_transition, music)` — low-level `cross` (not the high-level `crossfade` wrapper, which ignores custom callbacks). `dj_transition` builds `fade.out(d) + fade.in(d)` spanning the **full** cross buffer so tracks curve past each other at ~−6 dB midpoint and sum to ~unity. Earlier per-transition energy scaling caused audible doubling — don't reintroduce it; vary the buffer length instead.
4. Optional **studio bed** — `state/bed.mp3` at weight `0.02` before voice ducking, so `smooth_add` ducks it with the music.
5. **Two stacked `smooth_add` ducking layers** — `voice_queue` (heavy, p=0.25) then `intro_queue` (light, p=0.40). Gated talkbax-style, NOT RMS-keyed: an earlier RMS sidechain follower drove `music_bus` to −91 dB even with the voice queue empty (git `f38a9af`). Both voice channels pass through `mic_chain` (compress → makeup → 40ms slap echo). HPF/presence shelf skipped — this build hits "Early computation of source content-type" on IIR filters fed by `request.queue`.
6. `rotate(weights=[1, jingle_ratio], [jingles, radio])` — one jingle per N tracks.
7. `fallback(track_sensitive=false, [radio, emergency])` → `blank.skip(max_blank=5s)`.
8. **Broadcast bus** — brick-wall limiter (20:1 at −1 dBFS) only. Normaliser/widener/bus-compressor were all removed (they reshaped the masters). The limiter is a safety net for MP3 inter-sample peaks; typically 0 dB of reduction on catalogue audio.
9. **Parallel Icecast outputs** (`make_stream_outputs()`, wrapped in one `stream_on`/`stream_off`): `%mp3(192)` → `/stream.mp3` (**always served** — universal floor) and, when enabled, `%opus(96, 48kHz)` → `/stream.opus`. Opus is gated on `opus_enabled` from `liquidsoap_opus_enabled.txt` (**off by default**; opt in via admin → Settings → Opus stream, mirroring the `archive_enabled` pattern — only an explicit `"true"` enables it). When off, no Opus output is created (no encoder, no resample). Both mounts share the same `radio` bus. Plus `output.file(%mp3(128), reopen_when={0m0s}, "/var/sub-wave/archive/%Y-%m-%d/%H-00.mp3")` for MP3-only hourly archives.

Also: a custom `subhttp:` protocol shells out to `curl` (Liquidsoap's `http.get.stream` returns spurious 522s on the Cloudflare-fronted Navidrome origin). Telnet server on port 1234 (reachable as `broadcast:1234`) exposes the custom `restart` command.

### Web UI (`web/`)

Next.js 15 App Router + Tailwind. Routes:

- `/` — `PlayerApp` or `Landing`, chosen at request time by `SUBWAVE_HOMEPAGE` (`player` default).
- `/listen` (always player), `/landing` (always broadsheet), `/setup` (docs), `/onboarding` (first-run wizard, the in-browser counterpart to `npm run setup`).
- `/admin`, `/admin/settings`, `/admin/debug` — admin shell behind a **single sign-in gate** (`AdminShell` + `useAdminAuth` in `web/lib/adminAuth.js`). Credentials cached in `localStorage` as `base64(user:pass)`, dropped on sign-out.

PWA-installable (`app/manifest.js`, `app/icon.js`, dynamic icon/screenshot routes via `next/og` ImageResponse — mind Satori's constraints). `useMediaSession` wires OS lock-screen / headphone / car controls; **skip is intentionally omitted** on the listener side so a stray AirPods double-tap doesn't skip for everyone.

Stream URL + API base default to same-origin (`/api`, `/stream.mp3`) for the prod image; dev overrides via `web/.env.local` (`NEXT_PUBLIC_API_URL=http://localhost:7701`, `NEXT_PUBLIC_STREAM_URL=http://localhost:7702/stream.mp3`).

### Docker layout

Three compose files at the repo root, three deployment shapes:

- **`docker-compose.yml`** — prod single-host with bundled Caddy. **The default.** `broadcast` (icecast2+liquidsoap), `controller`, `web`, `caddy`. **Only Caddy binds a host port** (`${CADDY_PORT:-7700}:80`); the rest are internal. State path `${STATE_DIR:-./state}`. Cloudflare terminates TLS (`auto_https off`). `controller` is forced `NODE_ENV=production` → admin gate mandatory. Configs baked into images, not bind-mounted.
- **`docker-compose.byo.yml`** — prod for hosts with their own Traefik/nginx/Caddy. Same as default minus bundled Caddy; `web`/`controller`/`broadcast` bind host ports (`${WEB_PORT:-7700}`, `${CONTROLLER_PORT:-7701}`, `${ICECAST_PORT:-7702}`). The web image is baked for same-origin `/api` + `/stream.mp3`, so the operator's proxy must replicate `docker/Caddyfile`'s route table on one hostname; split hostnames need a web rebuild with `NEXT_PUBLIC_*`.
- **`docker-compose.dev.yml`** — Mac local smoke-test. Broadcast + Controller only (web runs separately via `npm run dev`). State `./state`. Bind-mounts `radio.liq`, `sounds/`, `controller/src` so dev edits need no rebuild.

**Optional `tts-heavy` profile** in all three composes — a `tts-heavy` sidecar (`profiles: ["tts-heavy"]`, does NOT start unless `docker compose --profile tts-heavy up -d`) hosting Chatterbox + PocketTTS over HTTP on the shared `/var/sub-wave` volume. Off by default keeps the install lean.

**Image-first pulls, source-build fallback.** Every service references `ghcr.io/perminder-klair/subwave-{caddy,broadcast,controller,web,tts-heavy}:${SUBWAVE_VERSION:-latest}` alongside a `build:` block. `up -d` pulls; `build && up -d` rebuilds. Publishing via `.github/workflows/publish-images.yml` on tag pushes (`v*`).

**Auto-generated Icecast secrets.** The broadcast entrypoint (`docker/broadcast-entrypoint.sh`) resolves `ICECAST_*_PASSWORD`: env override → persisted `state/icecast-secrets.env` → freshly generated hex, then writes back and exports into liquidsoap's env. icecast + liquidsoap share one container, so there's no cross-container handshake. To rotate: delete `state/icecast-secrets.env` and restart `broadcast`.

**Single config surface.** Three required root `.env` vars boot the stack: `ADMIN_USER`, `ADMIN_PASS`, `SITE_URL`. Everything else is collected by two converging wizards — `npm run setup` (terminal, `cli/src/commands/setup.ts`) and `/onboarding` (browser, `web/components/onboarding/*` → `controller/src/routes/onboarding.ts`). Both persist to the same layer: Navidrome creds + setup timestamp → `state/setup-config.json`; cloud LLM/TTS keys → `state/secrets.env` (mode 0600, sourced on boot via `setup/secrets.ts`); everything else → `settings.update()` → `state/settings.json`. **Env always wins**; wizards only fill gaps. `setup/firstRun.ts` decides `needsSetup` (no Navidrome creds from env or config); `/state` exposes it so the player + AdminShell redirect a fresh operator to `/onboarding`.

The shared `/var/sub-wave` mount in **both** Broadcast and Controller is what makes the file-based IPC work — they must always map to the same host path.

### Caddy routing (`docker/Caddyfile`)

One origin, three backends: `/stream.mp3` → `broadcast:7702` (`flush_interval -1`, unbuffered); `/api/*` → `controller:7701` (prefix stripped via `handle_path`); everything else → `web:7700`. The web app uses same-origin defaults, so the prod image needs no `NEXT_PUBLIC_*`.

### Jingles

`state/jingles.m3u` is empty by default. Run `scripts/generate-jingles.sh` after the stack is up — it `exec`s into the controller, pipes text through the configured TTS engine, writes WAVs into `${STATE_DIR}/jingles/`, rewrites the M3U. The jingles `playlist(...)` uses `reload_mode="watch"`, so new renders need no restart.

## Working on this codebase

- **Queue/playback path**: `queue.drainToLiquidsoap()` is the single writer of `next.txt` (+ request-intro `say.txt`); `queue.announce()` is the single writer of scheduled `say.txt`/`intro.txt`. Request-intro WAVs are written ~250ms before the track URI so the 0.5s voice poll picks them up first. Poll intervals (1.0s queue, 0.5s voice) are the upper bound on perceived latency.
- **`radio.liq` `on_metadata`**: keep it on `music_meta`, the pre-cross handle (post-cross fires twice; `on_track` gets swallowed by source switches). See Architecture.
- **Crossfade**: keep fade duration equal to the cross buffer (`d = crossfade_duration()`, `fade.out(d)` / `fade.in(d)`). Shorter fades inside a fixed buffer let the outgoing track play full while the incoming ramps, summing to +6 dB (audible doubling). Vary the buffer length instead.
- **Ducking**: stick with `smooth_add`. An RMS sidechain follower drove `music_bus` to silence (`f38a9af`). `smooth_add` is gated talkbax — it cares only whether the channel has signal, not how loud.
- **TTS**: callers go through `tts.speak(text, {kind})`, never the engine modules. `tts.js` handles per-kind override + automatic fallback. The Kokoro worker path defaults to `/app/scripts/kokoro_worker.py`; set `KOKORO_WORKER` for non-default layouts.
- **Subsonic**: keep using `getAnnotatedUri` for anything going to Liquidsoap — raw URLs lose metadata until ID3 arrives, and the `on_metadata` hook needs `subsonic_id` for `/cover/:id` artwork.
- **LLM**: calls go through the AI SDK (`llm/sdk.js`); `matchRequest` + pool picker use `djObject` (Zod-validated, no manual JSON parsing). Default provider is the homelab Ollama box — reliable but maybe slow; **don't add aggressive retry**. Adding a provider: extend `LLM_PROVIDERS` in `settings.js` + the `switch` in `llm/provider.js`; call sites never name a provider.
- **DJ persona**: `settings.dj.souls` is an array (1–10); `djSystem()` picks one at random per call. Legacy `dj.soul` string is migrated on load. Emptying the array falls back to seeded `DJ_SOULS`.
- **Festivals** (`context.js`): hand-curated, fixed-date only (Western/UK + a few cross-cultural markers). Lunar holidays (Easter, Eid, Lunar New Year) aren't representable in the current schema.

### Heavy TTS engines (Chatterbox + PocketTTS)

Both are heavy PyTorch engines the controller image deliberately doesn't carry by default. Two modes, **env-switched**: if `TTS_HEAVY_URL` is set, the engine routes `speak()` over HTTP to the sidecar (which writes the WAV onto the shared volume and returns the path); otherwise it spawns a local Python worker over stdio. Both paths must keep working.

- **Sidecar (recommended)**: `subwave-tts-heavy` image, started via `--profile tts-heavy`. Controller wired with `TTS_HEAVY_URL=http://tts-heavy:8080` in all three composes; when the profile is off the URL is unreachable, `isAvailable()` is false, dispatcher falls back to Piper. See `docker/Dockerfile.tts-heavy` + `docker/tts-heavy/server.py` (FastAPI, one asyncio.Lock per engine). Client: `controller/src/audio/ttsHeavyClient.ts` (caches a 30s `/health` probe so `isAvailable()` is synchronous).
- **Legacy in-process** (still supported): `--build-arg WITH_CHATTERBOX=1` / `WITH_POCKETTTS=1` build a venv at `/opt/{chatterbox,pocket-tts}/venv`; workers at `controller/scripts/{chatterbox,pocket_tts}_worker.py`.
- **Shared reference-WAV folder**: clone references live in `config.voices.dir` (default `<STATE_DIR>/voices`, override `TTS_VOICE_DIR`; `CHATTERBOX_VOICE_DIR` honoured for back-compat). `chatterbox.listReferenceVoices()` is the single listing path (`/settings` returns it as both `chatterboxVoices` and `pocketTtsCustomVoices`). Pre-#213 `<STATE_DIR>/chatterbox-voices/` still scanned as fallback. The same folder holds **custom Piper voices** (#230): a `<name>.onnx` + `<name>.onnx.json` pair; `piper.resolvePiperVoice()` resolves a persona's `tts.voice` against it, falling back to the default voice if absent.
- **Chatterbox specifics**: (1) per-request `reference_wav` enables zero-shot cloning (each persona's `tts.voice` is a filename in `config.voices.dir`). (2) Paralinguistic tags (`[laugh]`, `[sigh]`, `[chuckle]`, `[cough]`) render as non-verbal sounds — `llm/dj.ts` only mentions them in the system prompt when the on-air engine is `chatterbox` (other engines would speak the literal word).
- **PocketTTS specifics**: kyutai-labs 100M CPU model, ~6× real-time. `tts.voice` accepts a built-in id (`alba`/`anna`/`charles`/`estelle`/`giovanni`/`juergen`/`lola`/`rafael`) OR a `.wav` filename for cloning (#213); `pocketTts.ts:resolveVoice` splits them. The shared worker (`pocket_tts_worker.py`) RMS-normalises then soft-knee limits output, driven hot via `POCKET_TTS_TARGET_RMS` (default `0.245`, env-tunable). One worker file → constants can't drift between modes.
