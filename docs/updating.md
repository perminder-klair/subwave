# Updating, rolling back, and recovering

Updating SUB/WAVE is one command on every install shape. This page is mostly
about the other half — what to do when an update lands badly, which is the part
that was missing.

> Just want the command? Jump to [Update](#update). Something already broken?
> Jump to [Recovery](#recovery-when-an-update-goes-wrong).

---

## Before you update

Two minutes, once, and rollback stops being a research project.

### 1. Take a backup

**Admin → Settings → Backup → Export** downloads a zip containing
`settings.json`, the
show schedule, the library tag database (`library.db` — a consistent online
copy, not a raw file grab), your jingles, SFX, custom voices, themes, skills
and persona avatars.

Two things it deliberately does **not** contain:

- **Secrets.** API keys and webhook auth are redacted before export, so a
  backup zip is safe to store but is not a complete restore — you re-enter
  cloud keys afterwards.
- **Archives.** `state/archive/` (hourly stream recordings) is excluded because
  it's enormous. Back that up separately, or accept losing it.

The tag database is the expensive thing in there. It represents every LLM
enrichment pass over your library; rebuilding it costs hours and tokens, not
just a rescan.

### 2. Write down the version you're on

```bash
grep SUBWAVE_VERSION .env        # image installs
git describe --tags              # clone installs
```

You cannot roll back to a version you can't name. On image installs, if
`SUBWAVE_VERSION` is unset or `latest`, note the running image digest instead:

```bash
docker compose images
```

### 3. Read the release notes

[`CHANGELOG.md`](../CHANGELOG.md), or the GitHub release for the tag. Anything
touching settings, schemas or Icecast rendering is worth reading before rather
than after.

---

## Update

### Standalone CLI install (the default)

```bash
subwave update        # pull new images, recreate what changed
subwave self-update   # replace the `subwave` binary itself
```

`subwave update` moves the `SUBWAVE_VERSION` pin in `.env` forward to match the
CLI's own release, then pulls and recreates. It only moves a **concrete**
version pin — an install deliberately following `latest` stays on `latest`.

`subwave update` pins the stack to **the CLI binary's own release**, so if the
binary is behind, so is the stack. To land on the newest release, run
`self-update` first and `update` second. If `update` then warns that your
compose files are behind the CLI, run `subwave sync` — new services and changed
env wiring don't ride an image bump, and only `sync` re-materialises the compose
files (it backs up the current ones first).

### Images, no CLI

```bash
docker compose pull
docker compose up -d
```

Pin `SUBWAVE_VERSION` in `.env` first if you want a repeatable version rather
than whatever `latest` resolves to today. Same flow with
`-f docker-compose.byo.yml`.

### Clone install

```bash
./scripts/update.sh
```

Which is `git pull --ff-only` → `docker compose pull --ignore-buildable` →
`docker compose build --pull` → `up -d --remove-orphans` → image prune.

Remember that **prod images `COPY` source at build time**. `docker compose
restart controller` reruns the same baked-in code; a source change needs
`up -d --build`.

### AIO / Unraid

- **One-click (Community Applications)** — Unraid's normal **Check for
  Updates** → **Apply Update**.
- **Compose stack** — stack menu → **Pull & Up**.

---

## Verify

Do this every time. Ninety seconds now beats a "the station's been off for a
day" discovery later.

```bash
./scripts/health-check.sh            # clone installs: containers + /api/health
                                     # + /api/now-playing + a log scan
curl -s http://localhost:7700/api/health     # anywhere: {"status":"on-air"}
```

Then:

1. **Listen.** Open the player and confirm audio, not just a 200.
2. **Admin → Monitor → DJ Doc** (`/admin/doctor`) — the full diagnostic sweep,
   in the UI. `subwave doctor` is the same thing on the CLI.
3. **Watch the logs for a minute**, especially after a broadcast rebuild:

   ```bash
   docker compose logs -f controller broadcast
   ```

A silent stream with healthy containers usually means Liquidsoap, not the
controller — check `state/logs/radio.log`.

---

## Roll back

Rollback is a version change plus a recreate. What that looks like depends on
how you installed.

### Image installs (CLI or plain compose)

Move the pin backwards and recreate:

```bash
# .env
SUBWAVE_VERSION=1.4.2
```

```bash
docker compose pull
docker compose up -d
```

Published tags are bare semver (`1.4.2`), plus `latest`. The list is on the
[GHCR package pages](https://github.com/perminder-klair?tab=packages&repo_name=subwave)
and matches the repo's `v*` git tags.

Every service references `${SUBWAVE_VERSION:-latest}`, so one line moves the
whole stack together. Don't pin services individually — a controller and a
broadcast image from different releases is a configuration nobody tests.

### Clone installs

```bash
git log --oneline -10
git checkout <previous-tag-or-sha>
docker compose up -d --build
```

### AIO / Unraid

Edit the container's **Repository** field to a specific tag instead of
`latest`:

```
ghcr.io/perminder-klair/subwave-aio:1.4.2
```

Apply, and Unraid pulls that tag. Set it back to `:latest` when you want to
resume following releases.

### What rolling back does to your state

`state/` is **not** versioned alongside the images, and it does not roll back
with them. Two consequences worth knowing before you do it:

- **Settings added by the newer version are dropped.** The controller loads
  `settings.json` into a fully-normalised shape and writes that shape back, so
  keys the older version doesn't know about disappear on its first save.
  Rolling forward again leaves those settings at their defaults, not at what
  you had configured. Usually harmless; occasionally surprising.
- **The library database migrates forward only.** Schema steps are versioned
  by `PRAGMA user_version` and applied in order on open; there are no down
  migrations. An older build opening a newer database mostly just ignores the
  extra columns, but a few historical steps rebuilt tables outright, and across
  one of those a downgrade is not a supported path.

So: rolling back **one release** is routine. Rolling back **several**, or
across a release whose notes mention a schema change, is the case where you
restore the backup you took first.

Rolling back is a way to get back on air, not a fix. Open an issue with what
broke — a version people have to pin away from is worth knowing about.

---

## Recovery: when an update goes wrong

### The admin console won't accept your login

Admin credentials come from the root `.env` — `ADMIN_USER` and `ADMIN_PASS` —
and **only** from there. They are not in `settings.json`, so no backup, restore
or settings edit can change them, and nothing an upgrade does to `state/` can
lock you out.

```bash
grep -E '^(ADMIN_USER|ADMIN_PASS)=' .env
docker compose logs controller | grep -i 'auth'
```

Three things to check:

1. **Are they set at all?** In production the controller refuses to start
   without both and says so:

   ```
   [auth] FATAL: NODE_ENV=production but ADMIN_USER and ADMIN_PASS are not set.
   ```

   If you see that, the controller isn't running — you're looking at a stale
   page or a proxy error, not a login failure.

2. **Did the container pick them up?** Compose reads `.env` at *recreate*, not
   at restart:

   ```bash
   docker compose exec controller printenv ADMIN_USER
   docker compose up -d --force-recreate controller   # if it's stale
   ```

3. **Are special characters mangling the value?** `.env` is not a shell:
   quoting and escaping rules differ from what you'd expect, and `$` and `#`
   are the usual culprits. Compare what the container actually received
   (`printenv` above) against what you wrote. Set an alphanumeric password to
   confirm the diagnosis, then pick a permanent one that survives the round
   trip.

On AIO/Unraid the same two values are container environment variables in the
template rather than lines in a `.env`.

### The stream is silent but containers are healthy

The controller and Icecast can both be fine while Liquidsoap is not.

```bash
docker compose logs --tail=100 broadcast
tail -100 state/logs/radio.log
```

Then restart the pair — they're supervised together, so restarting `broadcast`
bounces both:

```bash
docker compose restart broadcast
```

Remember that Icecast config is rendered **at broadcast boot** from `.env` and
the controller-written state files. Settings that say *restart required* in
admin (Opus/AAC/FLAC mounts, listener buffer, the stream password) genuinely
need this bounce, not just a settings save.

### The controller restart-loops

```bash
docker compose logs --tail=200 controller
```

Most boot failures name their cause in the first twenty lines. The two common
shapes:

- **A fatal config error** — missing admin credentials in production, an
  unreadable state path. Fix the input and recreate.
- **A state file the new version can't read.** Move the offending file aside
  and let it regenerate:

  ```bash
  mv state/settings.json state/settings.json.bak
  docker compose up -d --force-recreate controller
  ```

  You lose your configuration, not your library — then restore from the backup
  zip via **Admin → Settings → Backup → Import**.

### Everything else

`state/` is the only thing that matters and it survives `docker compose down`
(it's a bind mount, not a volume). So the nuclear option is cheap:

```bash
docker compose down
docker compose up -d --force-recreate
```

If that doesn't do it, roll back to the previous version and open an issue.

---

## Related

- [`DEPLOY.md`](../DEPLOY.md) — production deployment, Cloudflare, operations.
- [`docs/deployment.md`](deployment.md) — the deploy matrix, state layout and
  configuration precedence.
- [`docs/unraid.md`](unraid.md) — Unraid specifics.
