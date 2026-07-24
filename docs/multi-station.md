# Multi-station profiles

One install normally runs one station. If you'd rather run several — a main
station plus a holiday side project, a test bed for a new persona lineup,
whatever — **admin → Stations** lets you keep multiple independent station
profiles in the same install and switch which one is live.

Each station gets its own library pool, DJ roster, schedule, settings,
personas, and analysis cache, under `state/stations/<id>/` — a full copy of
everything that used to live at the root of `state/`. A `state/stations/active.json`
pointer says which one is currently live; only that station's files are the
ones Liquidsoap and the controller actually read.

Single-station installs are unaffected. There's no `stations/` directory
until you create a second station — everything stays at the root of `state/`
exactly as before, and nothing here changes how you run SUB/WAVE day to day.

## Creating a station

**admin → Stations → New station**, name it, and pick a starting point:

- **Fresh** — an empty station. Once it's live, it lands in `/onboarding`
  just like a brand-new install, waiting for Navidrome + LLM + TTS + DJ setup.
- **Duplicate current** — copies the live station's settings, personas,
  schedule, jingles, and library analysis (`library.db`) as a starting point.
  History doesn't come along: session, logs, and the hourly archive all start
  empty, so the new station doesn't inherit the old one's on-air past.

The first time you create a second station, the install **converts** to
multi-station: your current state quietly becomes `stations/main` (the
conversion is implicit — there's no separate "convert" step to run). If
conversion fails partway through, SUB/WAVE moves everything back to the root
automatically; the rare case where a move-back itself fails is called out by
name in the error, with a pointer to recover the leftover files from
`stations/main`.

## Switching the live station

Making a different station live restarts the mixer and the controller
against that station's `state/` directory — every listener is dropped for
about 10 seconds while it comes back up. The admin UI shows a "Switching
stations…" screen and reloads on its own once the new station has booted.

A few things stay install-level, not per-station, because they're
infrastructure rather than station identity: the Icecast secrets file, the
Hugging Face model cache, and the analyzer's tmp directory. Everything else —
including things you might not expect, like `library.db` — is per-station.

## Caveats

- **Env-provided credentials apply to every station.** `NAVIDROME_*` and any
  cloud LLM/TTS keys set via `controller/.env` (or the container environment)
  aren't station-scoped — they'd apply to whichever station is live. If you
  want different Navidrome libraries or API keys per station, set them
  through the setup wizard or admin settings instead of the environment, so
  they persist inside each station's own `state/stations/<id>/`.
- **`subwave setup` (the CLI wizard) targets a single-station root.** It
  writes straight into `state/`, not into whichever station happens to be
  active. On a multi-station install, configure a station through
  `/onboarding` or admin settings instead.
- **Backups now cover every station — but only at the file level.** A
  file-level backup of `state/` (copying the directory, a snapshot, etc.)
  includes `stations/<id>/` for all of them, live or not. The admin UI's
  backup **export**, though, is state-dir-scoped — it only covers whichever
  station is live at the time you run it, not the whole install.
- **Analysis is per-station.** `library.db` lives inside each station's
  directory, so switching stations switches which library's analysis cache
  (bpm/key/mood/embeddings) is in play.

## Dev mode

The switch works by having the controller call `process.exit(0)` so its
supervisor restarts it against the new station dir. In dev the controller
runs under `tsx watch`, which only respawns the process on a crash or a
watched-file change — not on a clean exit — and the compose restart policy
doesn't help either, because the `tsx watch` parent process itself never
dies. To compensate, the switch-exit path in non-production bumps the mtime
of one of its own source files right before exiting: `tsx watch` treats that
as a file change and relaunches the server against the new pointer, so dev
switches complete hands-free just like prod (~4s).

If that self-respawn ever fails (the try/catch around it is best-effort),
the fallback is the manual restart:

```bash
docker compose -f docker-compose.dev.yml restart controller
```

Running the controller natively (`cd controller && npm run dev`, outside
compose) relies on the same mtime-bump self-respawn.
