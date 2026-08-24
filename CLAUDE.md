# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SUB/WAVE is a personal internet radio station: one Icecast stream, all listeners hear the same broadcast, AI DJ picks tracks and reads scripts between them. See `README.md` for the architecture diagram and rationale.

## Where the detail lives

This file is loaded into **every** session, so it holds only what you need before touching anything: the architecture, the commands, and the invariants you could plausibly break by accident. The reasoning behind each invariant — the measured failure, the fix that was chosen over the obvious one — lives in a scoped file you read when you get there:

| Working on | Read |
| --- | --- |
| `controller/src/**` | [`controller/CLAUDE.md`](controller/CLAUDE.md) (module-by-module) |
| `liquidsoap/radio.liq` | [`liquidsoap/CLAUDE.md`](liquidsoap/CLAUDE.md) (pipeline order + every radio.liq rule) |
| `web/**` | [`web/CLAUDE.md`](web/CLAUDE.md) (routes, skin contract, API defaults) |
| `app/**` | [`app/CLAUDE.md`](app/CLAUDE.md) + [`app/docs/TESTING.md`](app/docs/TESTING.md) |
| queue, transitions, speech timing, personas | [`docs/internals/broadcast.md`](docs/internals/broadcast.md) |
| library, tagging, picker, requests, blocklist | [`docs/internals/music.md`](docs/internals/music.md) |
| zod schemas, `/settings` patch registry | [`docs/internals/schemas.md`](docs/internals/schemas.md) |
| analyzer, Icecast rendering, privacy locks, state layout | [`docs/internals/infrastructure.md`](docs/internals/infrastructure.md) |

The `docs/internals/` files are **not** optional reading when you are changing the thing they describe. Most of their paragraphs exist because someone shipped the obvious fix first and it was wrong.

## Common commands

Three operator entry points, all driving the same compose files + `state/` layout: the **standalone `subwave` CLI** (single binary, no clone — default for new installs), raw `docker compose` (no-CLI alternative), and `npm start` (contributor convenience inside a clone).

```bash
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

### Lint is the merge gate; tests are not

`controller/`, `web/` and `mcp-subwave/` each expose `npm run lint` (`eslint . && tsc --noEmit`; mcp-subwave is `tsc` only). CI runs all three on every PR (`.github/workflows/lint.yml`, plus theme-token and schema-mirror drift checks on `controller`) and those jobs are what block a merge.

`controller/` also has `npm test` — `scripts/run-tests.ts` auto-discovers every `scripts/*.test.ts` and hands it to Node's built-in runner. **Dropping a `*.test.ts` file into `controller/scripts/` is the whole registration step**; `npm test -- <substring>` filters. Prefer `node:test`'s `test()` for new files (per-assertion reporting) over the older plain-script shape (one pass/fail on exit code); both are supported deliberately. Concurrency is pinned to `--test-concurrency=1` — these files reach for shared ground (temp state dir, library DB, env vars). `web/` and `mcp-subwave/` have no tests.

**CI does not run the test suite — run `npm test` yourself before pushing controller changes.** If `observatory-scale.test.ts` fails with `SQLITE_IOERR_WRITE`, point `TMPDIR` at real disk (it builds a 200k-track DB and `/tmp` is a 12 GB tmpfs on Arch).

## Architecture

Four cooperating processes with **file-based IPC** through a shared `state/` dir (mounted at `/var/sub-wave` in containers). This is the load-bearing fact about how the system works — there is no socket or RPC channel between controller and Liquidsoap. The shared `/var/sub-wave` mount in **both** Broadcast and Controller is what makes it work; they must always map to the same host path.

**Controller → Liquidsoap** (Liquidsoap polls; the controller only writes):

| File | Poll | Purpose |
| --- | --- | --- |
| `next.txt` | 1.0s | one annotated track URI, drained into `request.queue.push` |
| `say.txt` | 0.5s | WAV path → `voice_queue`, **heavy-ducked** (`smooth_add p=0.22`). Idents, hourly time, weather, request intros |
| `intro.txt` | 0.5s | between-track links → `intro_queue`, **light-ducked** (`p=0.30`) so the song stays audible under the voice |
| `auto.m3u` | watch | fallback playlist, rewritten every `AUTO_QUEUE_REFRESH_MINUTES` (default 60) for the current mood |
| `liquidsoap_*.txt` | startup | jingle_ratio, crossfade, per-codec enable/bitrate… written by `settings.update()`, **read once** — changes need a mixer restart (`/restart-mixer` → telnet) |

**Liquidsoap → Controller / UI** — marker files, each written from an `on_metadata` hook:

- `now-playing.json` — the live track. Written from **`music_meta`, the pre-cross handle**; see `liquidsoap/CLAUDE.md` before moving it.
- `jingle-playing.json` — a jingle is on air, so `airVoice` holds every spoken segment until its window passes. Jingles play outside the controller's voice serialiser, which is why the marker exists. `jingleRatio: 0` disables them (mixer restart).
- `bed-playing.json` — an instrumental the DJ talks over BETWEEN songs. A bed is queued like a request but is **not a song**: `on_meta` branches on the annotation before its `title != ""` gate, so it never reaches `now-playing.json`. That silence is why the marker exists — `queue.onBedStarted` is the only way the controller learns "air the link now".
- `voice-playing.json` — a spoken clip started. This is what makes air-time stamps real rather than estimated (#1382); see [`docs/internals/broadcast.md`](docs/internals/broadcast.md).
- `music-starved.json` — `{starved, since, at}`, the dead-air guard's own state, written on edge **and** as a heartbeat so a stale file is detectable. Read by `broadcast/music-starve.ts` and surfaced on the public health route. Its writer must never raise (see `liquidsoap/CLAUDE.md`).

**Controller → Web UI**: HTTP. `useStationFeed` (`web/hooks/useStationFeed.js`) polls `/now-playing` + `/state` every 5s.

**Controller state**: `session.json` — the live DJ session (chat-history JSON, `broadcast/session.js`), archived to `state/sessions/<id>.json` on roll. Controller-internal; Liquidsoap never reads it.

**Browsers → Icecast**: direct `<audio>` on `…/stream.mp3` (default) or `…/stream.opus`. MP3 is the universal floor and must stay always-served (Sonos, hardware radios, car receivers, older Safari). The Opus upgrade is gated four ways and lands on the next `tune()`, never on a playing element — the details and the iOS/Firefox chained-Ogg failures are in [`web/CLAUDE.md`](web/CLAUDE.md).

### Code layout

- **Controller** (`controller/src/`, Express + ESM Node) — `server.js`, `config.js`, `settings.js`, `context.js` at the root; everything else under `routes/`, `middleware/`, `music/`, `broadcast/`, `audio/`, `llm/`, `skills/`.
- **Liquidsoap** (`liquidsoap/radio.liq`) — request queue → auto playlist → jingle rotate → cross → dead-air guard → ducking layers → limiter → parallel Icecast mounts.
- **Web** (`web/`) — Next.js 15 App Router + Tailwind; headless player core plus swappable **skins**.
- **Native app** (`app/`) — a separate Expo SDK 56 / React Native project (own `package.json`, `node_modules`, `eas.json`). Architecture-critical and easy to break.

### Docker layout

Three compose files at the repo root, three deployment shapes:

- **`docker-compose.yml`** — prod single-host with bundled Caddy. **The default.** **Only Caddy binds a host port** (`${CADDY_PORT:-7700}:80`); the rest are internal. Cloudflare terminates TLS (`auto_https off`). `controller` is forced `NODE_ENV=production` → admin gate mandatory. Configs baked into images.
- **`docker-compose.byo.yml`** — for hosts with their own Traefik/nginx/Caddy. Same minus Caddy; services bind host ports. The web image is baked for same-origin `/api` + `/stream.mp3`, so **the operator's proxy must replicate `docker/Caddyfile`'s route table on one hostname** — split hostnames need a web rebuild with `NEXT_PUBLIC_*`.
- **`docker-compose.dev.yml`** — local smoke test. Broadcast + Controller only (web runs separately). Bind-mounts `radio.liq`, `sounds/`, `controller/src`.

Two sidecars: **`analyzer`** starts by default (acoustic analysis — lean by default, `ANALYZER_HEAVY=1` for the CLAP+Demucs flavour), **`tts-heavy`** is opt-in behind `--profile tts-heavy` (Chatterbox + PocketTTS). Details in [`docs/internals/infrastructure.md`](docs/internals/infrastructure.md).

**Image-first pulls, source-build fallback.** Every service references `ghcr.io/perminder-klair/subwave-*:${SUBWAVE_VERSION:-latest}` alongside a `build:` block. `up -d` pulls; `build && up -d` rebuilds. Published by `.github/workflows/publish-images.yml` on `v*` tags.

**Auto-generated Icecast secrets.** `docker/broadcast-entrypoint.sh` resolves `ICECAST_*_PASSWORD`: env override → persisted `state/icecast-secrets.env` → freshly generated hex, then writes back and exports into liquidsoap's env. To rotate: delete the file and restart `broadcast`.

**Single config surface.** Three required root `.env` vars boot the stack: `ADMIN_USER`, `ADMIN_PASS`, `SITE_URL`. Everything else is collected by two converging wizards — `npm run setup` (`cli/src/commands/setup.ts`) and `/onboarding` (`controller/src/routes/onboarding.ts`) — which persist to the same layer: Navidrome creds → `state/setup-config.json`; cloud keys → `state/secrets.env` (0600); everything else → `settings.update()` → `state/settings.json`. **Env always wins**; wizards only fill gaps. `setup/firstRun.ts` decides `needsSetup` (no Navidrome creds from env or config) and `/state` exposes it, which is what redirects a fresh operator to `/onboarding`.

### Jingles

`state/jingles.m3u` is empty by default. Run `scripts/generate-jingles.sh` once the stack is up — it `exec`s into the controller, pipes text through the configured TTS engine, writes WAVs into `${STATE_DIR}/jingles/` and rewrites the M3U. The playlist uses `reload_mode="watch"`, so new renders need no restart.

## Working on this codebase

Rules that are expensive to rediscover. Each links to its full reasoning — **read that before changing the thing it describes.**

### Structural rules

- **One writer per file.** `queue.drainToLiquidsoap()` is the only writer of `next.txt` (+ request-intro `say.txt`); `queue.announce()` the only writer of scheduled `say.txt`/`intro.txt`; `queue.onSpoken()` the only place post-air bookkeeping happens. Poll intervals (1.0s queue, 0.5s voice) are the upper bound on perceived latency.
- **A pushed track is "handed over", never "playable".** `item.sent` only means the URI reached `next.txt`; Liquidsoap silently drops a request it cannot resolve, and the reconcile sweep needs ~3 auto tracks to notice. `proto_subhttp` records an explicit `ready`/`failed` result under the handoff's one-use probe id, and `queue.verifyPushResolved()` consumes it over telnet. **Never infer resolution from `dj_queue.queue()` membership**: it includes idle/resolving requests and omits a healthy request while boundary prefetch owns it. Missing/unknown outcome channels fail open. See [`liquidsoap/CLAUDE.md`](liquidsoap/CLAUDE.md).
- **Policy lives in its own module, never inlined at the call site.** `broadcast/voice-policy.ts` (station muted), `clock-policy.ts` (wall clock off air), `dj-budget.ts` (daily token cap), `banter-policy.ts` (when a guest-show exchange may air), `drain-policy.ts`, `skip-policy.ts`, `util/request-guard.ts` (listener-request safety), `util/public-persona.ts`, `broadcast/dj-agent/artist-guard.ts`, `music/blocklist-rules.ts`. Each exists because the same decision is reached from several call sites and drifted when it was duplicated. Adding a second copy of one of these checks is the bug.
- **A gate's failure direction is a deliberate design choice — never "unify" two of them.** `POST /listener-auth` fails OPEN, `POST /station-auth` fails CLOSED (both in `util/listener-auth.ts`); the three listener-count gates fail OPEN on an unknown count while `presentListeners()` fails CLOSED; the analysis quiet gate fails open in the *opposite* direction from the DJ gates. Same for validation posture: `validate*Strict` throws, `normalize*` repairs-or-drops, and neither restates a rule.
- **A validated shape is defined once** in `controller/src/schemas/<feature>.ts` and mirrored to `web/lib/schemas.generated.ts` by `npm run gen:schemas` (CI diffs it). Files under `src/schemas/` may import **only `zod`** — not even a sibling schema — because the mirror is one flat concatenation compiled in the browser build. Never hand-edit the mirror; put impure rules in a `*-server.ts` sibling. → [`docs/internals/schemas.md`](docs/internals/schemas.md)
- **Behaviour-preserving refactors must actually preserve behaviour.** The `/settings` patch registry is the live example: 26 of 42 keys converted, and the hand-rolled branches carry accidental leniency (five numeric coercion families, four string families) that the obvious conversion silently removes. Tightening any of it is defensible but is a behaviour change — its own PR, stated as such. → [`docs/internals/schemas.md`](docs/internals/schemas.md)
- **Keep the entrypoint and the AIO supervisor in lockstep.** `docker/broadcast-entrypoint.sh` and the AIO's `render_icecast()`/`bootstrap_state_dirs` duplicate four things: per-mount burst/queue sizing, listener-auth blocks, the trusted-proxy list, and the state-dir bootstrap. Fix one, fix both. → [`docs/internals/infrastructure.md`](docs/internals/infrastructure.md)
- **State bootstrap is never fatal.** A station that refuses to boot over a permission convenience is strictly worse than one on a degraded mount — icecast still serves and the dead-air guard still airs. Guard each step and warn; never let `set -eu` abort the entrypoint before icecast starts.

### Timing rules

- **Every timestamp the controller publishes is stamped at the live edge**, but every listener sits `stream.bufferSeconds` (default 22s) behind it. Listener-facing surfaces add the offset; operator surfaces (admin, MCP) intentionally keep live edge. `<burst-size>` is a **byte** count, so it is computed **per mount** — never collapse it to one global figure. And never judge cushion health with `buffered.end − currentTime`: that is the demux window, measured at 2.25s against a true 22.5s offset. → [`docs/internals/broadcast.md`](docs/internals/broadcast.md)
- **A banter slot is a window, not an instant.** Banter is the only segment gated on a minimum quiet gap, and the things that set that gap (a boundary-deferred ident, a zero-floor segment spot) don't land on the clock — evaluating the gap at one instant let them starve the whole hour (#1419). `broadcast/banter-policy.ts` opens the slot at :20/:50 and keeps it open ten minutes, firing the first minute the gap is clear. Never "fix" it by reclassifying short idents as not-real-talk. → [`docs/internals/broadcast.md`](docs/internals/broadcast.md)
- **A spoken clock is a forecast, not a reading.** A link is written when the pick is *made* and airs when the pick *starts*. Two paired guards in `broadcast/queue/pure.ts` refuse a clock without enough runway and drop the line if the seam drifts. → [`docs/internals/broadcast.md`](docs/internals/broadcast.md)
- **A dead-air guard that waits before firing is a guard that doesn't fire.** Fire immediately, ramp the level. Applies to anything that detects starvation.
- **Degrading must be silent and immediate, not a timeout.** A controller running ahead of its broadcast image sees no `voice-playing.json`; `awaitVoiceAir` resolves null *at once* rather than waiting out its timeout, because a 20s stall on every booth-log line is worse than the early stamp it fixes. Unmeasured values are reported `estimated: true` with timestamps **absent, not zeroed**.

### Audio rules

`radio.liq` has its own set — dead-air guard position, crossfade duration, `smooth_add` ducking, atomic marker writes, `on_metadata` placement. **All of them, with the measured numbers, are in [`liquidsoap/CLAUDE.md`](liquidsoap/CLAUDE.md).** The two most easily broken:

- **Keep fade duration equal to the cross buffer.** Shorter fades inside a fixed buffer let the outgoing track play full while the incoming ramps, summing to +6 dB. Vary the buffer, not the fade.
- **Stick with `smooth_add` for ducking.** An RMS sidechain follower drove `music_bus` to silence (`f38a9af`). `smooth_add` cares only whether the channel has signal.

Loudness: both sides of a rendered seam are gained by `music/loudness.ts` `resolveGainDb` — the same figure the drain stamps on a real track — never re-derived from the analyzer's LUFS, which ignores ReplayGain tags and the caps.

### Library and picker rules

- **Write `genres`, never `genre`** — the scalar column is GENERATED from `genres[0]`. `subsonic.songGenres()` is the single ingest normaliser. Genre matching is **one-directional**: a track's tag may refine a show's genre, never broaden it.
- **Judge era by `show-filter.resolveEraYear`, never raw `year`** — a reissue's own release date is untrusted. Pass it `yearUntrusted` (composed once in the library-db row mappers), never the raw `isCompilation`: that flag is `false` on exactly the reissue anthologies the guard exists for (#1418). Keep the JS and SQL era filters in agreement, and route every listener-facing year — annotation, DJ line, picker, `/now-playing` — through the resolver.
- **Use `getAnnotatedUri` for anything going to Liquidsoap** — raw URLs lose metadata until ID3 arrives, and `on_metadata` needs `subsonic_id` for `/cover/:id` artwork.
- **The tagger's own `moods`/`energy` must never enter the embed text.** Phases run enrich → embed → seed → propagate, so those are decided *from* the vectors; feeding them back is circular. → [`docs/internals/music.md`](docs/internals/music.md)
- **CLAP cosines are not comparable across moods** — each prompt sits at its own baseline, so picking a track's top raw scores ranks *prompts*, not tracks. Calibrate per mood (`music/audio-calibration.ts`), and stamp `UNCALIBRATED_VERSION` when a pass could not calibrate. → [`docs/internals/music.md`](docs/internals/music.md)
- **Enforce variety at the point of choice, not in the discovery tools.** Filtering artists inside the tools gutted the similarity pool on niche catalogues (#618). → [`docs/internals/music.md`](docs/internals/music.md)
- **The seed track id is not a pick.** Every pick event hands the agent the on-air track's id to seed discovery, and the tools exclude it from their own results — so it is the one well-formed id in context that no tool returned. `util/pick-seed.ts` owns the one wording that says so.
- **The blocklist is absolute** — no never-starve anywhere, requests included. Rules ride the *existing* chokepoints via `hitOf()`/`isBlocked()`; never add a second rule-filter at a pick path.
- **LLM calls go through the `llm/sdk.js` primitives**, and per-provider quirks live only in `llm/internal/provider/capabilities.ts` — call sites never name a provider. The default provider is a homelab Ollama box: reliable but slow, so **don't add aggressive retry**.
- **TTS callers go through `tts.speak(text, {kind})`**, never an engine module. The rescue chain is a list of voice **slots**, not engine ids, and a rescue target is engine **+ provider** (`sameTtsTarget`) — the four cloud providers share one dispatcher but are independent failure domains. → [`docs/internals/broadcast.md`](docs/internals/broadcast.md)

### Product-behaviour rules

- **The station must keep making sound.** Music never stops for a budget, a muted voice switch or an LLM outage: the hard token cap makes no model call at all and lets Liquidsoap coast on `auto.m3u`; `tts.enabled: false` still picks tracks and still honours listener requests, just silently.
- **Manual operator triggers are exempt from every automatic gate** — frequency, budget, voice switch, clock switch. An explicit action always fires.
- **Gate before generation, not at the dispatcher.** Gating `speak()` would still have the LLM write every script and throw it away.
- **A public read hands over the whole roster at once** — a persona's `soul` is a system prompt, not a bio, so it rides only behind `publishPersonaSouls`, and when off the key is **absent, not empty**. Never widen the public shape to TTS config, skills or behaviour dials.
- **Absent or malformed settings must coerce to the pre-existing behaviour**, so an upgrade is byte-identical. Every switch above follows this.
- **Multi-station**: switching profiles is a pointer write + mixer restart + controller `process.exit` — never hot-swap state paths in-process. State files holding absolute paths must be re-derived at boot. → [`docs/internals/infrastructure.md`](docs/internals/infrastructure.md)
- **Operator curation outranks listener signal.** An operator heart skips the `topLiked` window cutoff and survives the record trim, because a listener like ageing out is a taste snapshot expiring while an operator like ageing out is the DJ forgetting curation set by hand.
