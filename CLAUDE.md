# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SUB/WAVE is a personal internet radio station: one Icecast stream, all listeners hear the same broadcast, AI DJ picks tracks and reads scripts between them. See `README.md` for the architecture diagram and rationale.

## Common commands

```bash
# --- dev (Mac smoke test) ---
cd docker && docker compose up -d        # Icecast + Liquidsoap + Controller only
cd web && npm install && npm run dev     # web UI on :7700, separate process
cd controller && npm install && npm run dev

# --- production (single-host, Caddy edge) ---
sudo STATE_DIR=/var/lib/subwave ./scripts/setup.sh
docker compose -f docker/docker-compose.prod.yml up -d
./scripts/generate-jingles.sh            # render Piper station idents
./scripts/update.sh                      # git pull + rebuild + rolling recreate

# Common one-offs
docker compose -f docker/docker-compose.prod.yml logs -f controller
curl http://localhost:4800/api/health    # liveness via Caddy edge (prod)
```

There is no `/skip` endpoint — track-end is the only natural transition. Liquidsoap controls pacing.

**Controller source needs a rebuild, not a restart.** `controller` `COPY`s its source at build time, so `docker compose restart controller` reruns the *same baked-in code*. `liquidsoap` is different: `radio.liq` is bind-mounted (`../liquidsoap/radio.liq:/etc/liquidsoap/radio.liq:ro` in both compose files), so editing it only needs a restart — `Dockerfile.liquidsoap` itself doesn't `COPY` the script.

```bash
cd docker && docker compose up -d --build controller     # after any controller/src/** change
cd docker && docker compose restart liquidsoap           # after radio.liq edits — bind-mounted, no rebuild
cd docker && docker compose up -d --build liquidsoap     # only after Dockerfile.liquidsoap changes
```

`web` is a Next.js dev server in local mode (`npm run dev`), so it hot-reloads — no rebuild needed for UI changes during dev. Production builds the web image; treat it like the others there.

No test runner, linter, or formatter is configured.

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
- **Browsers → Icecast**: direct `<audio src="…/stream.mp3">`. The `useMediaSession` hook wires lock-screen / headphone / CarPlay controls to the player, with artwork served from the controller's `/cover/:id` proxy.

Anything that needs to flow between the controller and Liquidsoap must go through one of these files — there is no socket or RPC channel.

### Controller (`controller/src/`, ESM Node.js)

- `server.js` — Express API. Public: `GET /health`, `/now-playing`, `/state`, `/dj`, `/cover/:id`, and `POST /request`. Admin-gated (Basic auth via `ADMIN_USER` + `ADMIN_PASS`): `GET /POST /settings`, `POST /restart-mixer`, `GET /POST /DELETE /jingles[/:filename]`, `POST /auto-pick`, `POST /tag-library`, `GET /debug`. CORS is wide open (`*`). **In production (`NODE_ENV=production`, set by `docker-compose.prod.yml`) the gate is mandatory** — the controller exits on startup if `ADMIN_USER`/`ADMIN_PASS` aren't set, because the admin surface is too revealing to expose unauthenticated.
- `queue.js` — in-memory `upcoming`/`history`/`djLog` plus `drainToLiquidsoap()`, the single writer of `next.txt` (and, via `tts.speak`, `say.txt` for request intros). `announce()` is the single writer of `say.txt` / `intro.txt` for scheduled segments — it picks the target file based on kind (`'link'` → `intro.txt`, everything else → `say.txt`). **All track playback goes through `queue.push()`; all spoken segments go through `queue.announce()`.** Request-intro TTS is written ~250 ms before the track URI so Liquidsoap picks up the voice file first.
- **LLM layer (`llm/`)** — every model call goes through the Vercel AI SDK (`ai` package), so the provider is swappable:
  - `llm/provider.js` — provider registry. Resolves an AI SDK `LanguageModel` from `settings.llm` (`provider` ∈ `ollama` | `anthropic` | `openai` | `gateway`; `model`; optional `apiKey`). `ollama` is the homelab default and needs no key. Switching provider in the admin UI reroutes every call — no redeploy, no call-site change.
  - `llm/sdk.js` — the two primitives every call uses: `djText` (free-text generation) and `djObject` (Zod-validated structured output via `generateText` + `Output.object`).
  - `llm/log.js` — 30-entry ring buffer of recent LLM calls for `/debug`.
  - `llm/tools.js` — AI SDK `tool()` definitions wrapping Subsonic/library music discovery; consumed by the agentic picker.
  - `llm/speech.js` — the `cloud` TTS engine (AI SDK `generateSpeech` → OpenAI / ElevenLabs).
- `llm/dj.js` — the DJ **prompt layer** (was `ollama.js`; renamed when the LLM layer moved onto the AI SDK). Builds prompts and hands them to `llm/sdk.js`:
  1. `matchRequest` — structured output: a Zod schema (`search_terms`, `mood`, `intent`, `ack`, plus `artist`/`scope`/`sort`) validates the result; no manual JSON parsing.
  2. `generate*` (intro, link, weather, station ID, hourly) is free-text under a DJ persona system prompt. Each call picks a **random soul** from `settings.dj.souls` (1–10 personas) plus a random narrative **angle**, on top of an opener-anti-repeat list from `queue.getRecentOpeners()`. Hard rules in the prompt template — don't loosen them without reason.
- `picker.js` — LLM-as-DJ next-track selector with two strategies. **Pool path** (default): builds a balanced candidate pool from 7 sources (similar-songs, mood-tagged library, mood-matched playlists, recently-added albums, frequent albums, similar-artist top songs, starred+random fallback), caps/dedupes, and hands ≤18 candidates + the last 8 plays to the LLM. **Agent path** (`settings.llm.pickerAgent`): a `ToolLoopAgent` is given the `llm/tools.js` discovery tools and decides what to search itself — opt-in because it needs a model good at multi-step tool calls. Any agent failure falls back to the pool path. Expensive Subsonic calls are memoised for 30 min.
- `subsonic.js` — Navidrome client using proper Subsonic salt+token MD5 auth (never plaintext). `getAnnotatedUri(song)` wraps the URI in `annotate:title="…",artist="…",subsonic_id="…":<uri>` so Liquidsoap reports real metadata immediately instead of waiting on stream ID3, and so the `on_metadata` hook can recover the song id for the cover-art proxy. Also exposes `getSimilarSongs`, `getArtistInfo`, `getTopSongs`, `getPlaylists`/`getPlaylist`, `getRecentlyAddedAlbums`, `getFrequentAlbums`, and `getCoverArtUrl` — all used by the picker and `/cover/:id`.
- `settings.js` — durable settings stored at `/var/sub-wave/settings.json`. Validates+persists; on save it also writes the tiny `liquidsoap_*.txt` files Liquidsoap reads on startup. `renderDjPrompt({name, soul, …})` substitutes `{name}/{soul}/{station}/{location}` into the operator-supplied template; the legacy single-string `dj.soul` is migrated forward into `dj.souls[]` on load. **`{name}` is mandatory in the template** — `update()` refuses any custom prompt that drops it, so dialogue can never become anonymous.
- `tts.js` — engine dispatcher across three engines: `piper`, `kokoro`, and `cloud` (`llm/speech.js`, AI SDK → OpenAI/ElevenLabs). Per-kind override (`settings.tts.byKind`) falls through to `settings.tts.defaultEngine` (default `piper`). On any failure it falls back to a local engine — `piper` is the universal fallback — so the DJ never goes silent. All callers (queue.js, jingles.js, scheduler.js) go through `tts.speak()` — don't import the engine modules directly.
- `piper.js` — spawns Piper CLI, writes WAV to `config.piper.outDir`, returns the path. Cleans files older than 1 h. Fast path (~30 ms/word).
- `kokoro.js` — manages a persistent Python worker (`controller/scripts/kokoro_worker.py`) that loads the kokoro-onnx model once and stays resident. Slower than Piper (~300–800 ms/line on CPU) but much more natural. `isAvailable()` lets `tts.speak` short-circuit the fallback chain if the venv/model isn't present.
- `context.js` — `getFullContext()` returns `{ time, weather, festival, dominantMood }`. **Priority for `dominantMood` is festival > weather > time** — this is what `refreshAutoPlaylist` and the picker key off. `getDateContext` / `getClockContext` expose day/season/weekend/late-night/commute flags to the DJ prompts. Open-Meteo is cached 30 min; festivals are a hardcoded list keyed to the operator's calendar.
- `scheduler.js` — node-cron driver. Auto-playlist refresh every `config.show.autoQueueRefreshMinutes` (default 60). Cron ticks fire at the most aggressive cadence (top of hour, every 15 min, `:00/:15/:30/:45`); `shouldFire(kind)` gates each handler on `settings.dj.frequency` (`quiet` / `moderate` / `aggressive`) so quiet stations get the time check every 2 hours and only a `:45` station ID, while aggressive ones get all four idents and a weather update every 15 min. Weather only announces on condition change.
- `liquidsoap-control.js` — opens a telnet socket to Liquidsoap on port 1234 and issues the custom `restart` server command, which calls `shutdown()` and lets the container's restart policy bring it back ~3 s later with the new `liquidsoap_*.txt` values applied.
- `library.js` / `tag-library.js` — `moods.json` store + standalone tagger (`npm run tag [-- --limit N]`). Resumable, saves every 25 tags.
- `jingles.js` — pre-rendered TTS stinger management. Writes WAVs into `${STATE_DIR}/jingles/`, rewrites `jingles.m3u`, and updates `jingles.json` (metadata). The `default-id` ident is protected from deletion.
- `config.js` — single source of truth for env-derived config. Default URLs point at Tailscale hostnames (`ronin.tail.ts.net`, `x1pro.tail.ts.net`).

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
9. `output.icecast(%mp3(bitrate=192))` to `icecast:7702/stream.mp3` + `output.file(%mp3(bitrate=128), reopen_when={0m0s}, "/var/sub-wave/archive/%Y-%m-%d/%H-00.mp3")` for hourly archives.

Also: a custom `subhttp:` protocol shells out to `curl` (installed in `Dockerfile.liquidsoap`) because Liquidsoap's built-in `http.get.stream` returns spurious 522s on the Cloudflare-fronted Navidrome origin. A telnet server on port 1234 (internal-only) exposes a custom `restart` command for the controller.

### Web UI (`web/`)

Next.js 15 App Router with Tailwind. Routes:

- `/` — `PlayerApp` or `Landing`, chosen at request time by `SUBWAVE_HOMEPAGE` (`player` default, `landing` for the marketing host).
- `/listen` — always the player.
- `/landing` — always the broadsheet.
- `/setup` — interactive onboarding walkthrough.
- `/admin`, `/admin/settings`, `/admin/debug` — admin shell. **Single sign-in gate** (`AdminShell` + `useAdminAuth` in `web/lib/adminAuth.js`) replaces the old in-player Settings modal and the standalone `/debug` route. Credentials are cached in `localStorage` as `base64(user:pass)` and dropped on sign-out.

PWA-installable: `app/manifest.js`, `app/icon.js` + `apple-icon.js`, `app/icons/[size]/route.js` for Android adaptive sizes, `app/screenshots/[variant]/route.js` for install-dialog previews (rendered via `next/og` ImageResponse — beware Satori's constraints: only flex/block/none/-webkit-box `display` values, divs with multiple children need an explicit `display: flex`). `web/public/sw.js` is a minimal service worker (just enough to avoid a /sw.js 404 on install). `useMediaSession` wires the OS lock-screen / headphone / car-display controls; **skip is intentionally omitted** on the listener side so a stray AirPods double-tap doesn't skip the song for every listener.

Polling: `useStationFeed` hits `/now-playing` + `/state` every 5s. Stream URL and API base default to same-origin (`/api`, `/stream.mp3`) for the production image; dev overrides via `web/.env.local` (`NEXT_PUBLIC_API_URL=http://localhost:7701`, `NEXT_PUBLIC_STREAM_URL=http://localhost:7702/stream.mp3`).

### Docker layout

Two compose files, two deployment shapes:

- **`docker/docker-compose.yml`** — "Mac local smoke-test variant". Icecast + Liquidsoap + Controller only. Web UI runs separately via `npm run dev`. State is `../state` (repo-local bind mount). Used for local development.
- **`docker/docker-compose.prod.yml`** — production single-host deploy. Adds `web` (built from `web/Dockerfile`, Next.js standalone output) and `caddy` (edge router). **Only Caddy binds a host port (`4800:80`)** — Icecast, Controller, Liquidsoap, and Web are internal-only and reachable via the proxy. State path is `${STATE_DIR:-/var/lib/subwave}`. Cloudflare is expected to terminate TLS in front; Caddy has `auto_https off`. The `controller` service is forced into `NODE_ENV=production`, which makes the admin auth gate mandatory — the container will exit on boot if `ADMIN_USER`/`ADMIN_PASS` aren't in `controller/.env`.

The shared `/var/sub-wave` mount in **both** the Liquidsoap and Controller containers is what makes the file-based IPC work — they must always be mounted to the same host path.

### Caddy routing (`docker/Caddyfile`)

One origin, three backends:

- `/stream.mp3` → `icecast:7702` with `flush_interval -1` so the audio stream isn't buffered.
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
- Touching TTS: callers go through `tts.speak(text, { kind })` — not `piper.speak` / `kokoro.speak` directly. `tts.js` handles the per-kind engine override and the automatic fallback to the other engine on failure.
- Touching Subsonic: keep using `getAnnotatedUri` for anything going to Liquidsoap. Raw stream URLs work but lose metadata until ID3 arrives, and the `on_metadata` hook needs `subsonic_id` so the controller's `/cover/:id` proxy can serve MediaSession artwork.
- LLM calls go through the AI SDK (`llm/sdk.js`). `matchRequest` and the pool picker use `djObject` — the AI SDK validates the response against a Zod schema, so there's no manual JSON parsing or regex recovery to maintain. The provider is whatever `settings.llm` selects; default is the homelab Ollama box, which may be slow but is reliable — don't add aggressive retry.
- Adding an LLM provider: extend `LLM_PROVIDERS` in `settings.js` and the `switch` in `llm/provider.js`. Call sites never name a provider — they call `djText`/`djObject`, which resolve the model through the registry.
- DJ persona: the configured `settings.dj.souls` is an **array** (1–10 entries). `ollama.djSystem()` picks one at random per call. Legacy single-string `dj.soul` is migrated on load. Adding entries broadens the rotation; emptying the array falls back to the seeded defaults in `DJ_SOULS`.
- Festivals in `context.js` are a hand-curated general calendar (Western/UK plus a couple of cross-cultural markers like Diwali and Vaisakhi). Fixed-date only — lunar-shifted holidays (Easter, Eid, Lunar New Year) aren't representable in the current schema. Adding/removing entries changes what the autonomous DJ plays around those dates.
