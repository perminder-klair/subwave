# Sub-stations — parallel channels on one install

**Date:** 2026-07-19
**Source:** Discord feature discussion "Sub-stations" (Calvin3ztt, EveningPill, BrentNorrisKY, dbals, Gurthyy; maintainer confirmed intent 2026-07-16). No GitHub issue yet.

## Problem

One install = one broadcast. A household shares a single stream, so the only way
family members get "their" radio is a scheduled show — which means tuning in at
a specific time. The ask: **parallel channels** ("rock channel / pop channel /
Muppets Radio") that each listener can tune into whenever they want, with a
slightly different DJ focus per channel — without scanning, tagging, and
analyzing the music library all over again per channel.

## Goal

- N always-on streams from **one** stack, one shared music library
  (Navidrome + `library.db` tags/analysis/embeddings — scanned and tagged once).
- Each channel has its own music identity (genre/mood/era/playlist filters) and,
  eventually, its own DJ persona.
- Each channel is tunable from the web player, the native app, and hardware
  players (plain Icecast mount per channel).
- Zero change for existing single-station installs; channels are purely additive.

## Non-goals

- Per-channel weekly schedule grids (a channel airs one format 24/7 for now;
  per-channel scheduling can layer on later).
- Per-channel listener requests / DJ interaction in phase 1 (phase 2).
- Per-channel weather/timezone/locale — one household, one context.
- Multi-host or multi-library federation.

## Community proposals assessed

1. **Second compose stack, hardlinked `library.db`** (EveningPill). Works today
   as a workaround but: every service duplicates (2× icecast, caddy, web,
   controller, analyzer), admin fragments across two UIs/subdomains, and — the
   part EveningPill was unsure about — sharing `library.db` between two live
   installs is unsafe-ish: it's WAL-mode SQLite (multi-process access on one
   host technically works), but *both* stacks run their own tagger/analyzer
   passes and write competing rows, and a hardlink shares only tags/analysis —
   `settings.json`, `moods.json` context, sessions, and schedule all stay
   separate. Verdict: viable stopgap, wrong end-state; nothing to build.
2. **Admin-switchable state directory** (Gurthyy). This is *profiles*, not
   channels: one stream at a time, whole family still shares it, plus a full
   stack restart per switch. Solves a different problem (A/B-ing station
   configs); doesn't let the kids and the parents listen simultaneously.
3. **First-class channels in one stack** — what this spec designs.

## Core concept: a channel is an always-on show with its own stream

The `shows` system already defines everything a channel's *music identity*
needs — `genres`, `eras`, `energies`, `moods`, `playlistIds`, `filtersStrict`,
`maxTrackSeconds`, plus a persona, guests, theme, and programme mode
(`settings.ts` show shape; the show-steered fallback pool in
`broadcast/scheduler.ts refreshAutoPlaylistInner()` already builds a
filter-honouring M3U from it). A channel therefore doesn't invent a new filter
editor or a new prompt surface: it **pins a show** (or none = the station's
default mood-driven pool) and gives it a dedicated Liquidsoap pipeline and
Icecast mount.

- Channel = `{ id, name, enabled, showId | null, … }` in `settings.channels[]`.
- The existing Shows admin page is the format editor; the new Channels page is
  just "name + which show + on/off".
- Phase 2 gets the DJ for free from the same pin: the show's persona/guests
  already ride through `djSystem()` / session identity today.

The **main station is untouched** — root mounts (`/stream.mp3`), root state
files, existing behaviour byte-for-byte when `channels` is empty. Channels are
additive extras under `/ch/<id>/…`.

## Architecture

### One liquidsoap process per channel (not one script with N pipelines)

The broadcast container already supervises two processes
(`docker/broadcast-entrypoint.sh`: icecast + liquidsoap, bash `wait -n`).
Channels add one liquidsoap child per enabled channel, all feeding the **same
icecast**.

Why process-per-channel instead of generating N pipelines inside one script:

- `radio.liq` is ~1,600 lines of top-level state; wrapping it in a
  `make_channel()` function is a high-risk restructure. Parameterizing its
  ~30 hardcoded `/var/sub-wave/...` paths through env is mechanical.
- Crash/restart isolation: `/restart-mixer` for the kids' channel doesn't
  dead-air the parents'. Settings that already require a mixer restart
  (bitrates, jingle ratio, crossfade) restart only that channel.
- Same script, run N times → zero drift between main and channel behaviour.

`radio.liq` changes (one pass):

```liquidsoap
state = environment.get("CHANNEL_STATE", default="/var/sub-wave")
mount_prefix = environment.get("MOUNT_PREFIX", default="")   # "" | "/ch/kids"
telnet_port = int_of_string(environment.get("TELNET_PORT", default="1234"))
```

Every `"/var/sub-wave/<file>"` becomes `"#{state}/<file>"`; mounts become
`"#{mount_prefix}/stream.mp3"` etc. Defaults reproduce today's behaviour
exactly, so the main process needs no env and dev compose keeps working.

### Broadcast supervisor + manifest

The controller (single writer of channel topology) writes
`state/channels.json` on every `settings.update()` that touches channels:

```jsonc
{ "channels": [ { "id": "kids", "telnetPort": 1235 } ] }
```

(Only what the supervisor and `liquidsoap-control` need — settings stay in
`settings.json`.) The entrypoint grows a reconcile loop (~30 lines): every 15s
diff running children against the manifest, spawn/kill accordingly, each child
with `CHANNEL_STATE=/var/sub-wave/channels/<id>`, `MOUNT_PREFIX=/ch/<id>`,
`TELNET_PORT=<port>`. Adding a channel in the admin UI goes on air without SSH
or a container restart. The existing `wait -n` all-die-together semantics apply
only to icecast + the **main** liquidsoap; channel children are reconciled, not
fate-shared.

Icecast: `<sources>4</sources>` in `docker/icecast.xml.template` bumps to a
flat 32 — 4 mounts × (1 + N channels) must fit, and an idle allowance is free
(sources are connections, not CPU). No new env var, so no compose edit and no
CLI asset re-embed. Channel mounts are named with their full public path
(`/ch/kids/stream.mp3`), so the edge needs no rewriting.

Telnet ports assigned deterministically by the controller (1235, 1236, …);
`broadcast/liquidsoap-control.js` gains a `port` argument resolved from the
manifest.

### State layout

```
state/
  …everything today, unchanged (main station)…
  channels.json                  # supervisor manifest (controller-written)
  channels/<id>/
    next.txt say.txt intro.txt sfx.txt auto.m3u        # file IPC, per channel
    now-playing.json jingle-playing.json               # liquidsoap-written
    liquidsoap_*.txt                                   # per-channel knobs
    queue.json recent-plays.json session.json sessions/  # phase 2
```

Shared (stay at state root, all channels read the same): `library.db` (+
`moods.json`), `voices/`, `voice/` (TTS out), `jingles/` (per-channel jingles
can layer later), `settings.json`, `secrets.env`, `icecast-secrets.env`,
`logs/`. `config.ts` is already the single path chokepoint — a
`channelPaths(id)` helper mirrors the `config.liquidsoap`/`config.session`/
`config.queue` path blocks per channel; `STATE_DIR`-relative shared assets
keep their existing constants.

**Library stays single-writer**: only the install-level tagger/analyzer/
MusicBrainz passes write `library.db`; channels are pure readers via the same
in-process modules. This is the whole point vs. the two-stack workaround.

### Edge (Caddy) — static config, any number of channels

```caddyfile
@chStream path_regexp ^/ch/[^/]+/stream\.(mp3|opus|flac|aac)$
handle @chStream { reverse_proxy broadcast:7702 }   # mount name == public path

@chApi path_regexp chapi ^/ch/([^/]+)/api(/.*)?$
handle @chApi {
  rewrite * /channels/{re.chapi.1}{re.chapi.2}
  reverse_proxy controller:7701
}
```

Written once; no rebuild per channel. BYO-proxy docs get the same two rules.

This makes every channel a **self-contained station base URL**
(`https://radio.example/ch/kids`): the native app's "add station by address"
and the standalone web player work against a channel *today*, because a
channel's `/api` speaks the same surface as a station's.

### Controller

**Phase 1 (music channels):**

- `settings.channels[]` (validated like festivals/shows; id slug-safe, cap ~8),
  writes `channels.json`, scaffolds `state/channels/<id>/` on save — including
  empty `auto.m3u`/`jingles.m3u` (liquidsoap's `reload_mode="watch"` needs the
  files to exist; empty jingles.m3u = no jingles on channels in phase 1) and
  the channel's `liquidsoap_*.txt` knob files (archive/opus/flac/aac all off).
- `refreshAutoPlaylist` loops enabled channels after the main refresh: same
  builder, show resolved from the channel's `showId` pin instead of
  `resolveActiveShow()`, output to `channels/<id>/auto.m3u`, reload via that
  channel's telnet port. Crons stagger (offset per channel) so N refreshes
  don't stampede Navidrome at :00.
- Channel-scoped router mounted at `/channels/:id`: `/now-playing` (reads the
  channel's file), `/state` (channel name/theme + shared install fields),
  `/health`. Root `/state` gains a `channels: [{id, name}]` list for pickers.
- With no queue feeding `next.txt`, a channel's liquidsoap coasts on
  `auto.m3u` — the exact LLM-free fallback path the main station already
  exercises under budget-hard. Phase 1 channels are that mode, permanently.

**Phase 2 (per-channel DJ):** the controller stays **one process**; the
per-station singletons become per-channel instances behind a channel context
(`Map<channelId, StationContext>`), constructed from `channelPaths(id)`.

Why one process and not one controller per channel (which env-wise is nearly
free thanks to the `STATE_DIR` chokepoint): `settings.json` lives inside
`STATE_DIR`, so N processes means N settings files and N admin UIs — the
two-stack fragmentation in miniature; each process would also duplicate the
resident TTS workers (Kokoro holds its model in RAM), the LLM provider
registry, its own `library.db` handle *and* its own tagger/analyzer child
fighting over the shared library (WAL has **no busy_timeout** today — N
writers would throw SQLITE_BUSY, not wait). And at the edge, Caddy's static
config can proxy `/ch/*` to *one* controller with a rewrite, but cannot map a
path segment to N per-channel upstream processes without dynamic-upstream
machinery. One process, channel-scoped state, is the only shape where "shared
library, shared config, one edge rule, per-channel air" all hold.

Module inventory (from a full `controller/src` sweep):

- *Channel-scoped:* the queue (`broadcast/queue.ts` — single writer of the IPC
  files, voice-serialisation chains, recent-plays), the session
  (`broadcast/session.ts` — programme state already rides ON the session, so
  programmes come free once sessions are per-channel; that composition is the
  pattern to copy), the scheduler's per-station crons (auto-refresh, hourly,
  station-ID, skills, banter, programme ticks — become per-channel iterations
  gated by per-channel frequency), dj-gate counters, `listeners.ts` (poll
  per-mount from the same status-json), `audience.ts`, `stream-idle.ts`
  (pause-when-empty per channel), `likes.ts`, `music/blocklist.ts`, the
  curiosity dedup ledger.
- *Stays shared:* library modules + `library-db` handle (WAL, deliberately
  single controller-side handle; the tagger/analyzer child stays the one
  writer), subsonic client + memoisation, picker memo, LLM provider registry,
  telemetry ring + **budget tally — the daily token cap stays install-wide**
  (one household, one Ollama; it's the blast-radius guard), TTS engine
  workers, nightly doctor + cleanup crons.
- *Needs a key fix if ever per-channel:* `context.ts` weather cache is
  unkeyed; weather/timezone/locale stay install-wide (one household) so this
  stays a non-issue for now.

Per-channel settings grow modestly in `channels[].overrides`: dj frequency
(default **quiet** so a 4-channel house doesn't 4× the Ollama/TTS load by
surprise), persona/voice, jingleRatio, crossfade, station name. Everything
else inherits the install. Requests (`/ch/<id>/api/request`) and session
archives land per channel.

### Web player

- `/ch/<id>` route renders `PlayerApp` pinned to the channel (stationClient
  base `/ch/<id>/api`, stream `/ch/<id>/stream.mp3`); `/` stays the main
  station.
- Channel picker in the palette menu (mirrors the skin picker: hidden unless
  channels exist), driven by `/state.channels`.
- Native app: no release needed — channels are addable as stations by URL; a
  later release can surface the sibling-channel list from `/state`.

## Rollout

| Phase | Ships | Cost |
|---|---|---|
| 1 | Music-only channels: settings + admin page, supervisor children, parameterized radio.liq, per-channel auto.m3u + now-playing, Caddy rules, web picker | Moderate — no controller singleton refactor |
| 2 | Per-channel DJ: channel contexts for queue/session/agent/gate/programme, requests, per-channel TTS voice/jingles | The big one |
| Later | Per-channel schedule grids, per-channel archives, per-channel jingle sets | — |

Phase 1 alone answers most of the household ask (different music per person,
always on); phase 2 delivers "Muppets Radio has its own DJ".

## Resource cost (homelab math)

Per extra channel: one liquidsoap process ≈ 3–8% of a core (decode + MP3
encode; opus/flac/aac off by default per channel too) + ~60–100 MB RAM.
Icecast/caddy/web/controller/analyzer are shared. Phase 2 adds ~1 LLM pick per
track transition per channel + TTS renders — on a shared Ollama this queues, so
quiet-by-default frequency and the shared daily token cap are the guard rails.
Compare: the two-stack workaround duplicates ~1.5 GB of images and every
sidecar.

## Compatibility / migration

- No compose or `.env` changes — broadcast/controller/caddy image rebuilds
  only, so no CLI asset re-embed.
- Empty `settings.channels` → supervisor spawns nothing extra, radio.liq env
  defaults reproduce today's paths/mounts/port — bit-identical behaviour.
- `subwave` CLI, dev compose, BYO compose: untouched in phase 1 (BYO docs gain
  the two proxy rules).

## Testing

- Unit: channel settings validation; manifest writer; `channelPaths`;
  auto-playlist builder with a pinned show (extends `auto-pool.test.ts`).
- Broadcast: the `docker run --entrypoint` radio.liq harness with
  `CHANNEL_STATE`/`MOUNT_PREFIX` env — assert mounts + file IPC land under the
  channel dir; supervisor reconcile loop (add/remove while running).
- E2E (worktree stack): create channel in admin → mount appears, auto.m3u
  fills with the pinned show's genre, `/ch/<id>` page plays, main station
  unaffected.

## Open questions

1. Channel cap + port range: hard-cap channels at 8? (Icecast sources, telnet
   ports 1235+, CPU.)
2. Should a channel with no pinned show be allowed (= clone of the default
   pool), or must every channel pin a show? Spec currently allows null.
3. Per-channel station name/branding in ICY metadata — phase 1 nicety
   (`liquidsoap_station_name.txt` already per-channel via the state dir) or
   defer?
4. Archives for channels: default off (disk), toggle per channel later?
