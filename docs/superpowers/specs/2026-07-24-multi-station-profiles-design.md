# Multi-Station Profiles — design

**Date:** 2026-07-24
**Status:** draft, awaiting review
**Decided with operator:** one station live at a time (profile-switch model), but the
directory layout must let a future deployment run stations simultaneously as parallel
stacks. Creation supports both fresh (→ onboarding) and duplicate-of-current. Offline
stations are inert: list / rename / delete / make-live only.

## 1. Goal

Let one SUB/WAVE install hold **multiple fully independent stations**, each a
self-contained state directory, and let admin switch which one is on air. A station's
entire identity already lives under `state/` (settings, secrets, session, schedule,
library.db, jingles, beds, voices, logs, archive) — this feature builds the *switcher*,
not the isolation.

### Non-goals (v1)

- Simultaneous broadcasting (layout-ready, not built — see §8).
- Editing an offline station's settings (rename only).
- Sharing a library.db between stations (duplicate copies instead).
- Native-app station UI, CLI `subwave stations` subcommand.
- Per-station admin credentials (`ADMIN_USER`/`ADMIN_PASS` stay install-level).

## 2. Directory layout

```
state/                          # the compose-mounted root — /var/sub-wave in containers
  stations/
    active.json                 # {"activeId": "<id>"} — the pointer, atomic tmp+rename
    <id>/                       # one complete station dir (exactly today's state/ contents)
      station.json              # {"name": "...", "createdAt": "..."} — identity card
      settings.json, session.json, library.db, jingles/, beds/, voices/, logs/, archive/, …
  icecast-secrets.env           # install-level: one icecast serves whichever station is live
```

- **Station id** = directory name, slug `^[a-z0-9][a-z0-9-]{0,40}$`, generated from the
  chosen name at creation. Every station-id path is containment-checked
  (`path.resolve` must stay inside `stations/`).
- **Display name** lives in `station.json` (written at creation, edited by rename). The
  on-air name remains the station's own `settings.json` — the two can differ (identity
  card vs broadcast branding), and `station.json` exists so unconfigured stations still
  have a name.
- **Install-level residents of the root** (never moved into a station): `stations/`,
  `icecast-secrets.env`, `analyze-tmp/`, and (AIO) the HF model cache. Everything else
  is station identity.

### Single-station mode (default, unchanged)

If `state/stations/` does not exist, every process behaves exactly as today — same
paths, same compose files, zero migration. Multi-station activates only when the
operator creates a second station (§6).

## 3. Pointer resolution — four boot-time points

All four read the pointer **once at (re)start**; there is no hot-swap.

1. **Controller** (`config.ts`): today every path derives from the single `STATE_DIR`
   constant (config.ts:11). Change: resolve
   `effectiveStateDir = exists(${STATE_DIR}/stations/active.json) ? ${STATE_DIR}/stations/<activeId> : STATE_DIR`
   at module load; keep the root as `config.stateRoot` for station-management routes and
   icecast secrets. All existing `config.*` path consumers are untouched.
2. **radio.liq**: parameterize the state root —
   `state_dir = environment.get("SUBWAVE_STATE_DIR", default="/var/sub-wave")` (a
   distinct name from the controller's `STATE_DIR` so the AIO supervisor can export it
   for liquidsoap without leaking a station-dir path into the controller child's
   `STATE_DIR`, which must stay the root) and
   mechanically replace the ~40 hardcoded `/var/sub-wave/...` literals with
   `"#{state_dir}/..."` interpolations (includes the archive `output.file` path).
   One-time mechanical edit, verified by the existing liq parse check.
3. **Broadcast entrypoint** (`docker/broadcast-entrypoint.sh`): resolve the pointer in
   shell before rendering icecast and launching liquidsoap; export
   `SUBWAVE_STATE_DIR`. All state-file reads (per-mount burst sizes, bitrates,
   listener-auth blocks, `.ndignore` drop) move to the resolved dir.
   `icecast-secrets.env` stays at the root.
4. **AIO supervisor** (`render_icecast()`): same resolution, kept in lockstep as it
   already is for #1114/private-station. AIO's `HF_HOME` moves to the **root** (model
   cache is not station identity).

**Why this is automatically consistent on switch:** the entrypoint has no internal
relaunch loop — it `wait -n`s and exits when either child dies, and Docker
`restart: unless-stopped` re-runs it. So the existing telnet `restart` already causes a
full pointer re-resolve + icecast re-render from the new station's files. The
controller gets the same property from a clean `process.exit`.

**Env-always-wins caveat:** env-provided values (e.g. Navidrome creds in a legacy
`controller/.env`) apply to *every* station. Multi-station operators must configure
per-station values through the wizard/admin so they persist inside the station dir.
Documented in the feature docs page.

## 4. The switch

`POST /stations/:id/activate` (requireAdmin):

1. Validate slug + directory exists.
2. Write `stations/active.json` atomically.
3. Respond `202 {switching: true}`.
4. Telnet `restart` to liquidsoap → broadcast container restarts → new station's
   icecast config + liq state root.
5. Controller `process.exit(0)` after the response flushes → Docker restarts it →
   boots against the new dir. A fresh station has no `setup-config.json`, so
   `needsSetup` fires and the operator lands in `/onboarding` — the existing wizard is
   the new-station setup flow for free.

Cost: ~5–15 s dead air; all listeners drop and reconnect (same class of interruption
as `/restart-mixer` today). The admin confirm modal states this. The web player
recovers on its own: `useStationFeed` polls every 5 s, and the audio element's stall →
tap-to-resume behavior is unchanged.

**Dev caveats (documented, not blockers):** dev-compose runs the controller under
`tsx watch`, which may not respawn on a clean child exit — verify during
implementation; if it doesn't, exit non-zero or fall back to
`docker compose restart controller`. Native `npm run dev` (no supervisor) requires a
manual controller restart after a switch.

## 5. Station management API (`routes/stations.ts`, all requireAdmin)

- `GET /stations` → `{multiStation, activeId, stations: [{id, name, configured, createdAt}]}`
  (`configured` = has `setup-config.json`; name from `station.json`).
- `POST /stations {name, mode: "fresh" | "duplicate"}` → creates `stations/<slug>/` +
  `station.json`. Fresh = just the identity card. Duplicate = copy from the **active**
  station:
  - **copy:** `settings.json`, `setup-config.json`, `secrets.env`, `library.db`
    (via better-sqlite3 `.backup()` — the live handle is open, a plain `cp` could tear),
    `moods.json`, `schedule.json`, `voices/`, `persona-avatars/`, `jingles/` +
    `jingles.m3u` + `jingles.json`, `beds/` + `beds.json`, `bed.mp3`, `skills/`, plus
    the derived config files `liquidsoap_*.txt` and `icecast_listener_auth.txt` — they
    derive from the copied `settings.json`, so copying keeps the pair consistent
    (skipping them would leave a drift window until the first settings save).
  - **skip (runtime/listener history):** `session.json`, `sessions/`, `logs/`,
    `archive/`, `queue.json`, `recent-plays.json`, `now-playing.json`,
    `jingle-playing.json`, `bed-playing.json`, `listeners.jsonl`, `audience.json`,
    `likes.json`, `seen-curiosity.json`, and the IPC files
    (`next.txt`/`say.txt`/`intro.txt`/`sfx.txt`/`auto.m3u`).
  - Synchronous with a UI spinner; `.backup()` on a local ~1 GB db is seconds.
- `PATCH /stations/:id {name}` → rewrite that dir's `station.json` (offline-safe:
  touches only the identity card).
- `DELETE /stations/:id` → refuse the active station; `rm -rf` after slug validation +
  containment check; admin confirm modal.
- `POST /stations/:id/activate` → §4.

The copy/skip allowlist lives as an exported pure constant with a unit test
(`scripts/*.test.ts` pattern) so new state files must be classified deliberately.

## 6. Conversion (first "New station" on a legacy install)

Triggered implicitly the first time `POST /stations` runs with no `stations/` dir:

1. `mkdir stations/main/` and `fs.rename` every root entry into it **except** the
   install-level residents (§2). Same filesystem → atomic-ish, fast.
2. Write `station.json` for `main` (name from current settings' station name) and
   `active.json → main`.
3. Create the requested new station.
4. Run the switch sequence *targeting `main`* (i.e. a restart with the pointer now in
   place — the operator stays on their current station; the new one is created offline).

Liquidsoap keeps running during the seconds the files move: all its polls are
`file.exists`-guarded and the restart follows immediately. If any rename fails,
best-effort move-back and abort with a clear error.

## 7. Admin UI — `/admin/stations`

New AdminShell page (sidebar: top-level "Stations"), using the shared
loading/empty/error components and `stationClient`:

- Card per station: name, id, LIVE badge, configured/unconfigured chip, created date.
- Actions: **New** (dialog: name + fresh/duplicate radio), **Make live** (confirm
  modal: "drops every listener for ~10 seconds"), **Rename**, **Delete** (confirm;
  disabled on the live station).
- During a switch: full-page "Switching stations…" state that polls `GET /state` until
  the controller answers with the new `activeId`, then reloads.
- `GET /state` gains `station: {id, name, multiStation}` so the shell can badge the
  live station (id/name are already public-equivalent data).
- Single-station installs see their one station + the New button — no separate
  "enable multi-station" step; conversion is implicit (§6).

## 8. Future-parallel readiness

This is why the pointer is data (`active.json`) rather than baked into compose: after
this change **both** processes honor an explicit state-dir env
(`STATE_DIR=/var/sub-wave/stations/<id>` for the controller,
`SUBWAVE_STATE_DIR` for liquidsoap). A future simultaneous mode is then additional
broadcast+controller pairs pinned to specific station dirs via env, plus ports/Caddy
routes — no layout migration, and `active.json` degrades to meaning "the primary pair's
station". Nothing in v1 blocks it; nothing in v1 builds it.

## 9. Risks & implementation checks

- `tsx watch` respawn behavior on clean exit (§4 dev caveat).
- Audit host-side scripts for direct `state/<file>` path assumptions
  (`generate-jingles.sh` execs into the controller so it inherits resolution; the
  tagger runs in-controller; anything else found gets the resolver or a doc note).
- Analyzer service mounts the state root and receives absolute paths from the
  controller — unaffected; verify `analyze-tmp` stays root-level. AIO `HF_HOME` → root.
- CLI: `subwave setup` persists via controller/onboarding APIs and root `.env` — verify
  no direct station-file writes; compose files are untouched so **no
  `cli embed-assets` re-embed is needed** unless docs/env examples change.
- Backup guidance: backing up `state/` now captures all stations (doc note).
- Disk: duplicate copies `library.db` per station by design (analysis is per-station).

## 10. Testing

- Unit: pointer resolution, slug validation + containment, copy/skip allowlist,
  conversion entry classification (pure helpers, existing `scripts/*.test.ts` pattern).
- Liq parse check for the radio.liq parameterization; `npm run lint` in `controller/`
  and `web/` (merge gate).
- Manual, via the worktree dev stack + verify flow: legacy → conversion; fresh station
  → onboarding; duplicate → same settings, empty history; switch A↔B (icecast
  re-renders per-station bitrates/bursts); delete offline station; single-station
  install still boots identically with no `stations/` dir.
