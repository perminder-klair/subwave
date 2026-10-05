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

**admin → Stations → New station**, name it, and pick a starting point.
An install holds up to **eight** stations — each is a complete state
directory (its own `library.db`, jingles, archive), so the cap keeps the
rack from silently eating the disk:

- **Fresh** — an empty station. Once it's live, it lands in `/onboarding`
  just like a brand-new install, waiting for Navidrome + LLM + TTS + DJ setup.
- **Duplicate current** — copies the live station's settings, personas,
  schedule and jingles as a starting point. Configure its own Navidrome
  connection when it first goes live. Credentials, library analysis, playlist
  recipes and show playlist selections are not copied because they belong to
  the source music server. Sessions, logs and the hourly archive start empty.

The first time you create a second station, the install **converts** to
multi-station: your current state quietly becomes `stations/main` (the
conversion is implicit — there's no separate "convert" step to run). The
original station's effective Navidrome connection is saved into its profile,
including values previously supplied through environment variables. If
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

- **Every station configures its own Navidrome connection.** Set its URL,
  username and password through `/onboarding` or Admin → Settings → Music
  source. In a multi-station install, `NAVIDROME_URL`, `NAVIDROME_USER` and
  `NAVIDROME_PASS` neither supply nor override a station's connection. A new
  or duplicated station needs setup even if those variables are present.
  Single-station installs retain environment configuration until conversion.
  Upgrading an older multi-station install migrates its existing connections
  once, as described below. Two profiles may explicitly configure the same
  server, but neither inherits the other's connection.
- **Cloud API keys supplied through the environment remain shared.** This
  change scopes only the Navidrome connection, not LLM/TTS credentials.
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
- **Liquidsoap's own log stays install-level.** The compose files bind-mount
  `state/logs` over `/var/log/liquidsoap`, so `radio.log` is shared across
  stations regardless of which one is live. Only the controller's event logs
  (`logs/events-*.jsonl`) live inside each station's directory.

## Upgrading existing profiles

The first controller start with the #1785 fix migrates every existing,
unmarked profile, including inactive ones, before disabling Navidrome
environment configuration. This runs from the controller source in the
image, so replacing an image while retaining the state volume and environment
is sufficient. Keep the old `NAVIDROME_*` values for this first start.

For each field, the migration preserves the pre-#1777 precedence. A nonempty
environment variable overrides the saved field. Otherwise the saved field
applies. A missing URL defaults to `http://navidrome:4533`; a missing username
or password stays empty. Environment URLs and usernames are trimmed, while
password bytes stay unchanged. A whitespace-only environment URL uses the
default, a whitespace-only username stays empty, and an invalid environment
URL uses the old default. Saved strings retain their original bytes.

The migration first writes a private snapshot to
`state/stations/navidrome-migration.json`. It then atomically saves the
effective connection to each profile's `setup-config.json`, preserving other
setup fields and adding `"navidromePolicy": "profile-v1"`. Both files use mode
0600, and migration writes sync the file and directory to disk. Once all
profiles are saved, the journal becomes `{"version":1,"phase":"complete"}`
and no longer contains credentials. Later restarts and profile switches use
only the saved connection. New and duplicated profiles remain independent.

### Installations already running #1777

#1777 wrote no policy marker. Its saved files cannot distinguish an old
connection from one you deliberately reconfigured after that upgrade.
Before the first start with #1785, protect each such profile by adding
`"navidromePolicy": "profile-v1"` to its `station.json` or `setup-config.json`.
Preserve the file's existing fields. The migration skips that profile entirely.
This also protects fresh or duplicated profiles created under #1777 that you
want to leave unconfigured. Creates, conversions and connection saves made
with #1785 write this marker automatically.

### Verification and recovery

After upgrading, confirm `/api/state` reports `needsSetup: false`, refresh
the music library or fallback playlist, restart the controller again, and
switch to each migrated profile to confirm its library connection. Health
and stream audio alone cannot prove Navidrome access works.

If the migration cannot read or persist state, the controller stops with a
credential-free migration error. The existing mixer can continue serving
audio. Repair the volume permissions or malformed JSON and restart the
controller. A pending journal retains the original cohort and connection
values, so retries do not adopt changed environment values or new profiles.
Do not delete that journal or publish it in diagnostics; a pending journal
contains passwords.

To repair one profile manually, stop the controller, validate its credentials
against Navidrome, and save them in the profile's `setup-config.json` under
`navidrome` as `url`, `user` and `pass`. Add `"navidromePolicy": "profile-v1"`
at the top level and restrict the file to mode 0600. A pending migration will
leave that repair intact on restart. If environment credentials were removed
before the first migration start, restore their previous values first or
configure the affected profiles manually. Keep a backup of the full state
volume before upgrading.

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
