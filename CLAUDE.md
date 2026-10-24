# CLAUDE.md

SUB/WAVE is a personal internet radio station: one Icecast stream that every listener hears, with an AI DJ that picks the tracks and talks between them.

This file loads into every session, so it holds the map, the commands and one line per invariant. The reasoning behind each invariant lives in the doc named beside it, or in the module's own header comment, and you read it before changing the thing it describes: most of those paragraphs exist because the obvious fix shipped first and was wrong. New rules go in the same shape: one line here, the reasoning in the doc.

## Where the detail lives

| Working on | Read |
| --- | --- |
| `controller/src/**` | [`controller/CLAUDE.md`](controller/CLAUDE.md) |
| `liquidsoap/radio.liq` | [`liquidsoap/CLAUDE.md`](liquidsoap/CLAUDE.md) |
| `web/**` | [`web/CLAUDE.md`](web/CLAUDE.md) |
| `app/**` | [`app/CLAUDE.md`](app/CLAUDE.md) |
| queue, talk scheduling, speech timing, transitions, TTS, personas | [`docs/internals/broadcast.md`](docs/internals/broadcast.md) |
| show changes and sign-off/greeting handoffs | [`docs/internals/show-boundary-handoffs.md`](docs/internals/show-boundary-handoffs.md) |
| library, tagging, picker, requests, blocklist | [`docs/internals/music.md`](docs/internals/music.md) |
| zod schemas, the `/settings` patch registry | [`docs/internals/schemas.md`](docs/internals/schemas.md) |
| analyzer, Icecast rendering, auth gates, privacy, multi-station, state layout | [`docs/internals/infrastructure.md`](docs/internals/infrastructure.md) |

## Commands

```bash
docker compose -f docker-compose.dev.yml up -d   # dev stack: broadcast, controller (tsx watch), analyzer, socket proxy
cd web && npm install && npm run dev             # web UI on :7700, a separate process
docker compose logs -f controller
curl http://localhost:7700/api/health            # liveness through the Caddy edge (prod)
```

**Dev hot-reloads; prod needs a rebuild.** Dev bind-mounts `controller/src`, `controller/scripts`, `radio.liq` and `sounds/`: the controller restarts itself, and a `radio.liq` edit needs `docker compose -f docker-compose.dev.yml restart broadcast`. Prod images `COPY` the source, so `restart` reruns the old code and a change needs `docker compose up -d --build <service>`.

The compose files sit at the repo root: `docker-compose.yml` (prod, with Caddy as the only host port), `docker-compose.byo.yml` (your own reverse proxy, which must replicate `docker/Caddyfile`'s routes on one hostname) and `docker-compose.dev.yml`. Each one's header explains it. Operators drive them through the standalone `subwave` CLI, raw `docker compose`, or `npm start` in a clone.

## Lint and tests

- **Lint is the merge gate.** `npm run lint` in `controller/`, `web/`, `app/` and `mcp-subwave/` runs in `.github/workflows/lint.yml`, alongside the theme-token, schema-mirror and zod-parity checks. Only the controller and web lint jobs are required to merge.
- **CI does not run the test suites** (apart from two ffmpeg tests in `audio-tests.yml`). Run `npm test` yourself in `controller/`, `web/` or `app/` before pushing changes there.
- **Always run tests through `npm test`** (`npm test -- <substring>` filters). The controller runner gives each file its own temp `STATE_DIR`; `node --test` or `tsx <file>` can write into the repo's `state/`, the dev station's own. Files run one at a time by default (`--jobs N` in the controller). Dropping in `controller/scripts/*.test.ts`, or a web test under a root listed in `web/scripts/run-tests.mjs`, is the whole registration. The `controller/scripts/run-tests.ts` header covers the rest (`node:test`, reserved ports, `createTempDir`). A test removes its temp dir with `await removeTempDir(dir)` (`scripts/test-utils/temp-dir.ts`), never a bare `rmSync`, which races in-flight writes into `ENOTEMPTY`.
- If `observatory-scale.test.ts` fails with `SQLITE_IOERR_WRITE`, point `TMPDIR` at real disk (`/tmp` is tmpfs).

## Pull requests target `develop`

Use `gh pr create --base develop`. `main` is the release branch, and `enforce-main-source.yml` fails any PR into it from anything but `develop` or release-please. Ignore the session preamble's "Main branch: main" line: it is computed locally and is wrong for this repo. The release PR (`develop` → `main`) follows `.claude/skills/subwave-release-pr/SKILL.md`.

## Architecture

The pieces are Broadcast (Icecast + Liquidsoap), Controller (Express, ESM, TypeScript), Web (Next.js) and the native app. Controller and Liquidsoap share the `state/` dir (`/var/sub-wave` in containers) and must mount the same host path. Data passes as files in it; control (reloads, restart, skip, probes) goes over Liquidsoap's telnet on `broadcast:1234` (`broadcast/liquidsoap-control.ts`).

**Controller → Liquidsoap.** Liquidsoap reads; the controller only writes. The five polled files are written only by `Queue` methods, each through its own serialised `writeHandoff` chain, which waits for Liquidsoap to consume the previous write. Each poll interval caps the latency it adds.

| File | Read | Purpose |
| --- | --- | --- |
| `next.txt` | 1.0 s poll | one annotated track URI → `dj_queue` |
| `jingle-now.txt` | 0.5 s poll | one jingle URI → a priority queue for the next safe boundary (an operator press, or the controller-owned rotate) |
| `say.txt` | 0.5 s poll | voice WAV → `voice_queue`, heavy duck (`ducking.voice`, 0.22): idents, time, weather, request intros |
| `intro.txt` | 0.5 s poll | between-track link → `intro_queue`, light duck (`ducking.intro`, 0.30) |
| `sfx.txt` | 0.5 s poll | sound effect → `sfx_queue` |
| `auto.m3u` | telnet `auto.reload` | the coast playlist for the current mood |
| `jingles.m3u` | telnet `jingles.reload` | the mixer's own jingle rotate, rebuilt by `broadcast/jingles.ts` |
| `liquidsoap_*.txt` | once, at startup | crossfade, jingle ratio, duck depths, per-mount enable/bitrate…, written by `settings.update()`; a change needs `/restart-mixer` |

**Liquidsoap → Controller.** Marker files written by `radio.liq` (the rules are in `liquidsoap/CLAUDE.md`):
- `now-playing.json`: the live track, from `music_meta`, the pre-cross handle.
- `jingle-playing.json`: a jingle is on air, so `airVoice` holds speech until its window passes.
- `bed-playing.json`: an instrumental bed started. Beds never reach `now-playing.json`, so this is the only signal that airs the link over one.
- `voice-playing.json`: a spoken clip started, which is what makes air-time stamps real (#1382).
- `pause-talk-playing.json` → `pause-talk-voice-accepted.json` → `pause-talk-voice-started.json`: the ordered pause-and-talk handshake that makes a controller-only restart exactly-once.
- `music-starved.json`: the dead-air guard's state, with a heartbeat. Surfaced as `musicStarved` on `GET /state`.

**Controller → browsers** is HTTP: `web/hooks/useStationFeed.ts` polls `/now-playing`, `/state` and `/session` every 5 s. **Browsers → Icecast** is a direct `<audio>` on `/stream.mp3`, which must always be served (Sonos, hardware radios, cars, older Safari); `web/CLAUDE.md` has the Opus upgrade rules.

**DJ session.** `state/session.json` is the DJ's live chat-history session (`broadcast/session.ts`), archived on roll. Prompt memory follows that session, never the station-wide booth log (`Queue.djLog`); the roll and handoff rules are in `broadcast.md`. Never offer the outgoing show's raw speech to the incoming prompt. Words no model wrote (a RAW `/dj/say`, a jingle's script) are stamped `meta.verbatim` and withheld from every prompt by `broadcast/prompt-memory.ts` `withheldFromPrompts()`. `Session.boothCarry` is display-only.

**Config.** Three root `.env` vars boot the stack (`ADMIN_USER`, `ADMIN_PASS`, `SITE_URL`). `npm run setup` and `/onboarding` persist everything else to one layer: Navidrome credentials to `state/setup-config.json`, cloud keys to `state/secrets.env` (0600), the rest through `settings.update()` to `state/settings.json`. Env beats the wizards, except Navidrome env in multi-station mode.

## Invariants

**Structure**
- **One writer per file**: `queue.playJingle()` is the only writer of `jingle-now.txt` (the automatic rotate calls it), and `queue.onSpoken()` is the only place post-air bookkeeping happens.
- **A pushed track is "handed over", never "playable".** Resolution is the `proto_subhttp` probe outcome, consumed by `queue.verifyPushResolved()`; never infer it from `dj_queue.queue()` membership.
- **Policy lives in its own module** (`*-policy.ts`, `dj-budget.ts`, `talk-scheduler.ts`, `util/request-guard.ts`, `music/blocklist-rules.ts`, …). A decision reached from several call sites is made in one place, and a second copy of the check is the bug.
- **A gate's failure direction is deliberate; never unify two.** `POST /listener-auth` fails open while listener auth is off, while `POST /station-auth` and `middleware/station-auth.ts` fail closed. The listener-count gates fail open on an unknown count, while `presentListeners()` fails closed. `validate*Strict` throws and `normalize*` repairs or drops, and neither restates a rule.
- **A validated shape is defined once**, in `controller/src/schemas/<feature>.ts`, and mirrored to `web/lib/schemas.generated.ts` by `npm run gen:schemas` (CI diffs it; never hand-edit it). Those files import only `zod`; impure rules go in a `*-server.ts` sibling.
- **A behaviour-preserving refactor preserves behaviour, accidental leniency included.** Tightening it is a separate PR, stated as a behaviour change (`schemas.md`, on the patch registry).
- **Keep the broadcast entrypoint and the AIO supervisor in lockstep.** `docker/broadcast-entrypoint.sh` and the AIO duplicate six things (`infrastructure.md` lists them, and four tests drive both copies), so fix one, fix both.
- **State bootstrap is never fatal.** Guard each step and warn; Icecast and the dead-air guard must still come up.
- **The listener-country chain fails open link by link** (`broadcast/listener-country.ts`). A later link runs when an earlier one misses (`XX`/`T1`), not only when it is absent.

**Timing** (`broadcast.md`)
- **Published timestamps are live-edge**, and listeners sit `stream.bufferSeconds` (22 s) behind. Listener surfaces add the offset; operator surfaces don't. `<burst-size>` is bytes, computed per mount. Never judge the cushion with `buffered.end − currentTime`.
- **Every scheduled spoken segment is a row in one slot table** (`broadcast/talk-scheduler.ts`), driven by one per-minute `talkTick`, one talker per minute. A slot is a window, and a held row postpones, never cancels. A second talk cron is the bug.
- **A rendered segment is placed, not trimmed**: the lever at a boundary is which boundary it takes (`broadcast/vocal-runway.ts`).
- **A pause-and-talk break is silence on the music timeline.** The voice still goes through `say.txt`.
- **A show handoff is prepared for the confirmed final outgoing track**, never by look-ahead alone (`show-boundary-handoffs.md`).
- **A spoken clock is a forecast**, guarded by two paired checks in `broadcast/queue/pure.ts`.
- **A show-boundary cut is a fade through the existing `liq_cue_out` path.** It is measured from the pick's expected air time, and that forecast must count the bed.
- **Anything that detects starvation fires immediately and ramps the level**: a guard that waits before firing does not fire.
- **Degrade silently and immediately, never through a timeout.** An unmeasured value is `estimated: true`, with its timestamps absent, not zeroed.

**Audio** (`liquidsoap/CLAUDE.md`)
- Keep fade duration equal to the cross buffer; vary the buffer, not the fade.
- Ducking is `smooth_add`, never an RMS follower; `p` is the fraction of the music left up.
- Every transition effect runs on Liquidsoap's single streaming thread, so its cost is its shape: the dissolve sums its combs and subtracts the dry once, never per tap.
- Both sides of a rendered seam are gained by `music/loudness.ts` `resolveGainDb`, never from the analyzer's LUFS.

**Library, picker, LLM, TTS** (`music.md`, `broadcast.md`)
- Write `genres`, never `genre` (a generated column); `subsonic.songGenres()` is the one ingest normaliser. Genre matching is one-directional.
- Judge era with `resolveEraYear` and `yearUntrusted`, never raw `year`, and keep the JS and SQL era filters in agreement.
- Silence trim measures against an absolute floor, and `music/silence-trim.ts` owns every onset shift.
- Library coverage never counts on the read path; only `refresh()` counts it.
- Anything going to Liquidsoap uses `getAnnotatedUri`.
- The tagger's own `moods`/`energy` never enter the embed text. Bump `TAGGER_CONTRACT_VERSION` (`music/tagger-core.ts`) when the prompt asks for something different.
- CLAP cosines are not comparable across moods, so calibrate per mood.
- Enforce variety (artist spacing, album cooldown) at the point of choice, never inside the discovery tools.
- The track-length cap and floor are different mechanisms; never unify them. A never-starve filter never returns its input array.
- Tempo-derived timing is octave-safe: fold, then halve, never clamp.
- The seed track id is not a pick (`util/pick-seed.ts`).
- The blocklist is absolute, with no never-starve anywhere, requests included. Its rules ride the existing chokepoints, and every name tier keys through one fold (`recency.nameKey`).
- The stem cache's scan order and eviction order are one rule (`music/stem-priority.ts`).
- LLM calls go through the `llm/sdk` primitives, and provider quirks live only in `llm/internal/provider/capabilities.ts`. The default provider is a slow homelab Ollama, so add no aggressive retry.
- TTS goes through `tts.speak(text, {kind})`. The rescue chain is a list of voice slots, and a rescue target is engine + provider.

**Product behaviour**
- The station keeps making sound: the token cap, a muted voice and an LLM outage never stop the music.
- Manual operator triggers are exempt from every automatic gate (frequency, budget, voice switch, clock switch).
- An operator block (`POST /dj/queue-block`) reuses `queue.push()` and its existing opt-outs, with no new bypass; the never-play list still applies.
- `requestedBy` says which exemptions a track gets, not who is waiting. Count waiting listeners as `queue.pendingListenerRequests()` plus the requests still resolving in `routes/request.ts`, which hold no queue slot yet.
- Gate before generation, never at `speak()`.
- Public reads are explicit allowlists: never widen one to TTS config, skills or behaviour dials. A persona's `soul` is a system prompt, published only behind `publishPersonaSouls`, and absent (not empty) when off.
- Absent or malformed settings coerce to the pre-existing behaviour, so an upgrade is byte-identical. The one exception is legacy `llm.pickerAgent: false` → Track Shortlist, which is announced.
- A multi-station switch is a pointer write + mixer restart + controller `process.exit`; never hot-swap state paths in-process.
- A scheduled job deletes only files it wrote itself, matched on an anchored name (`backup/pure.ts`).
- Operator curation outranks listener signal: an operator heart skips the `topLiked` cutoff and survives the trim.
- Listeners never get a skip. `POST /dj/skip` is admin-only, and listener remote controls omit it.
