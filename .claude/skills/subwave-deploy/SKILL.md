---
name: subwave-deploy
description: Set up, deploy, or update SUB/WAVE (personal radio station at /home/klair/Projects/subwave). On a fresh checkout, runs scripts/setup.sh, prompts for Navidrome + Ollama credentials, brings the stack up, and generates jingles. On an already-running stack, pulls the latest, rebuilds only the Docker services whose code actually changed, recreates them, and verifies the stream is on-air. Use this skill any time the user wants to install, set up, bootstrap, deploy, update, sync, redeploy, refresh, restart, or "pull and restart" SUB/WAVE — including phrases like "set up subwave", "install subwave", "first boot", "bootstrap the radio", "pull subwave", "update the radio", "deploy subwave", "rebuild controller", "restart sub-wave", "redeploy after pull", "git pull and restart as needed", "check if the stream is healthy", or simply "deploy" / "install" / "set up" while in the subwave repo. Trigger proactively whenever the user is working in /home/klair/Projects/subwave and mentions setting up, installing, deploying, updating, rebuilding, restarting, or checking the running stack — even if they don't name the skill. Free to pull, rebuild, recreate, render Icecast config, generate jingles, and run health probes; confirm before destructive ops like wiping `state/`, removing volumes, full `down -v`, or overwriting an existing controller/.env that already has the operator's Navidrome password.
---

# SUB/WAVE deploy

Bring the SUB/WAVE radio stack up — from a fresh checkout or from an already-running install — with the minimum churn the situation needs. A first-time setup takes a few minutes (build + first jingle render). A clean update with no rebuild takes seconds; a full rebuild a minute or two.

The user has authorised free action on this hot path — `scripts/setup.sh`, `git pull`, `docker compose build`, `up -d`, `generate-jingles.sh`, log scans, health probes. Pause and confirm only for the genuinely destructive moves listed at the bottom.

## The five facts the workflow turns on

1. **Two compose files, two shapes.**
   - `docker/docker-compose.yml` — dev variant (Mac smoke-test): Icecast + Liquidsoap + Controller only. Web runs separately via `npm run dev`. State at `../state`.
   - `docker/docker-compose.prod.yml` — production single-host: adds `web` and `caddy`. **Only Caddy binds a host port.** State at `${STATE_DIR:-/var/lib/subwave}`.
   - Detect which is up from `docker compose -f <file> ps`. On this host, prod is the live one and Caddy is mapped to host port `4800` (`0.0.0.0:4800->80/tcp`), not `80` as the README suggests — always read the port from `ps`, never hardcode.

2. **Controller and Liquidsoap COPY source at build time, they do not bind-mount it.** `docker compose restart <svc>` reruns the *same baked-in code* and does nothing for source changes. Source changes need `up -d --build <svc>`. This is the single most common deploy mistake.

3. **Web in dev is hot-reloaded** (Next.js `npm run dev`); web in prod is a built standalone image and needs `--build` on any `web/**` change.

4. **The IPC between Controller and Liquidsoap is file-based** through the shared `state/` (mounted at `/var/sub-wave`). When you recreate one of them, in-flight `next.txt`/`say.txt`/`now-playing.json` may be mid-write — accept a few-second blip; don't keep recreating to "fix" it.

5. **Compose dependency ordering will recreate more than you asked for.** Asking to recreate `controller` and `web` will also recreate `liquidsoap` because of the `depends_on` graph. That's fine — same image, no source change means no behaviour change. Don't be surprised by it and don't fight it.

## Workflow

### Step 0 — Detect the install state

Before anything else, figure out which mode you're in. Three possibilities:

```bash
cd /home/klair/Projects/subwave

# Are containers up?
RUNNING_PROD=$(docker compose -f docker/docker-compose.prod.yml ps -q 2>/dev/null)
RUNNING_DEV=$(docker compose -f docker/docker-compose.yml      ps -q 2>/dev/null)

# Has setup.sh been run? (it produces docker/.env and a rendered icecast.xml)
[ -f docker/.env ] && echo "docker/.env present"
[ -f controller/.env ] && echo "controller/.env present"
[ -f "${STATE_DIR:-/var/lib/subwave}/icecast.xml" ] && echo "icecast.xml rendered"
```

Three modes:

- **Fresh checkout** — no containers, missing `docker/.env`, missing `controller/.env`, missing rendered `icecast.xml`. Go to the **initial-setup path** (Steps F1–F5 below).
- **Configured but down** — env files exist, rendered config exists, but no containers running. Go to **first-boot path** (Steps B1–B3 below).
- **Running** — at least one container up. Go to the **update path** (Steps 1–6 below). This is the normal everyday case.

A user saying "set up subwave" or "first boot" almost certainly means fresh checkout; "deploy" or "pull and restart" almost certainly means running. When ambiguous, ask once.

---

### Initial-setup path — fresh checkout

#### F1 — Prerequisites

The host needs: `docker` (with the `compose` plugin), `git`, `openssl`, `ffmpeg` (used by `setup.sh` to generate `emergency.mp3` and `bed.mp3`), and ideally `envsubst` (`gettext-base` on Debian; setup.sh falls back to `sed` if absent).

```bash
for c in docker git openssl ffmpeg envsubst; do
  command -v $c >/dev/null && echo "ok: $c" || echo "MISSING: $c"
done
docker compose version
```

If anything's missing, surface it. Don't auto-install system packages — that's a sudo-level human decision.

#### F2 — Controller credentials

`controller/.env` is the file the operator has to fill in by hand: Navidrome URL/user/pass, Ollama URL/model. Everything else has sensible defaults. If it already exists, leave it alone (it may already be filled in). If it doesn't, seed it from the example **but then pause and prompt the user** for the four values that actually matter:

```bash
if [ ! -f controller/.env ]; then
  cp controller/.env.example controller/.env
  chmod 600 controller/.env
fi
```

Ask the user (one question each, or as a single bundle):

- `NAVIDROME_URL` — e.g. `http://navidrome.local:4533`
- `NAVIDROME_USER`, `NAVIDROME_PASS`
- `OLLAMA_URL` and `OLLAMA_MODEL` (default `qwen2.5:7b`)

Then patch `controller/.env` in place with `sed`, keeping the rest of the file as-is. Do **not** echo passwords back to the chat.

#### F3 — Reachability pre-flight

Before booting, prove from the host that Navidrome and Ollama actually answer. This catches 90% of "why is the DJ silent?" before it happens.

```bash
# Read the values we just wrote
set -a; . controller/.env; set +a

# Navidrome (Subsonic ping)
curl -sf --max-time 5 \
  "$NAVIDROME_URL/rest/ping.view?u=$NAVIDROME_USER&p=$NAVIDROME_PASS&v=1.16.1&c=sub-wave&f=json" \
  | grep -q '"status":"ok"' && echo "navidrome: ok" || echo "navidrome: FAILED"

# Ollama
curl -sf --max-time 5 "$OLLAMA_URL/api/tags" >/dev/null \
  && echo "ollama: ok" || echo "ollama: FAILED"
```

If either fails, surface the failure with the URL it tried, and stop. The stack will boot regardless but the radio will be silent — better to fix it now.

#### F4 — Run setup.sh

`scripts/setup.sh` is the canonical bootstrapper. Idempotent — re-running is safe and won't overwrite an existing `docker/.env` or `controller/.env`. It:

- Creates `STATE_DIR` subdirs (`voice/`, `archive/`, `jingles/`, `logs/`) world-writable (containers run as mixed UIDs)
- Generates `docker/.env` with three random Icecast passwords if missing
- Syncs `ICECAST_SOURCE_PASSWORD` between `docker/.env` and `controller/.env`
- Renders `state/icecast.xml` from the template
- Renders `state/emergency.mp3` (30s pink-noise fallback) and `state/bed.mp3` (60s studio bed) via ffmpeg
- Touches `auto.m3u` and `jingles.m3u` so Liquidsoap's `reload_mode="watch"` has something to watch

Production hosts usually want `STATE_DIR=/var/lib/subwave`; dev just uses `<repo>/state`. The script needs to write to `STATE_DIR` — if it's outside `$HOME`, the user will likely need to invoke it with sudo. Surface that; don't run sudo without asking.

```bash
# Dev / repo-local:
./scripts/setup.sh

# Prod / system path:
sudo STATE_DIR=/var/lib/subwave ./scripts/setup.sh
```

#### F5 — Boot the stack and generate jingles

```bash
# Prod (single host with Caddy)
docker compose -f docker/docker-compose.prod.yml up -d --build

# OR Dev (no web container, no Caddy — runs npm run dev separately)
docker compose -f docker/docker-compose.yml up -d --build
```

First boot will spend a minute or two pulling images and compiling. Once `controller` reports ready, generate the station idents:

```bash
./scripts/generate-jingles.sh
```

This `docker compose exec`s into the controller and uses Piper to render the default set of station IDs into `${STATE_DIR}/jingles/`, then writes a fresh `jingles.m3u`. Liquidsoap's playlist uses `reload_mode="watch"`, so the new renders are picked up without a restart.

After F5, fall through to **Step 5 — Verify** below.

---

### First-boot path — already configured, just not running

The state and env files exist (a previous setup ran, the operator brought the stack down deliberately or after a reboot). No bootstrapping needed; just `up` it.

#### B1 — Sanity-check before booting

```bash
docker info >/dev/null  # daemon up?
[ -f docker/.env ] && [ -f controller/.env ]
[ -f "${STATE_DIR:-/var/lib/subwave}/icecast.xml" ]
```

If any of those are missing, fall back to the initial-setup path — something was wiped.

#### B2 — Up

```bash
docker compose -f docker/docker-compose.prod.yml up -d --build
```

`--build` is cheap when nothing changed (BuildKit short-circuits via cache). Including it covers the case where the operator's been editing source between sessions.

#### B3 — Jingles

```bash
[ -s "${STATE_DIR:-/var/lib/subwave}/jingles.m3u" ] || ./scripts/generate-jingles.sh
```

Only re-render if the M3U is empty. Re-rendering when it isn't is harmless but slow.

Fall through to **Step 5 — Verify**.

---

### Update path — stack is running

This is the everyday case. Steps 1 through 6 below are the deploy workflow.

### Step 1 — Locate the repo and detect the stack

```bash
cd /home/klair/Projects/subwave

# Which compose file is live? Whichever has containers up.
docker compose -f docker/docker-compose.prod.yml ps
docker compose -f docker/docker-compose.yml      ps
```

For the rest of this skill, `COMPOSE` means whichever file is live. Almost always `docker/docker-compose.prod.yml`.

### Step 2 — See what's incoming

```bash
git fetch
git status -sb                          # branch tracking + dirty files
git log HEAD..@{u} --oneline            # commits about to be pulled
git diff --name-only HEAD..@{u}         # files about to change
```

- Local clean and zero incoming commits → skip to Step 5 (verify only).
- Uncommitted local changes → `git status` will show them. Don't `git pull` blindly over them. Surface to the user and ask whether to stash, commit, or abort.
- Diverged history (local ahead AND behind) → pause and ask; don't auto-merge or rebase.

### Step 3 — Map changed files to services

Run through the diff and bucket files into actions. Mapping table (paths are relative to repo root):

| Changed path                              | Action                                    |
|-------------------------------------------|-------------------------------------------|
| `controller/src/**`                       | rebuild + recreate `controller`           |
| `controller/Dockerfile*`                  | rebuild + recreate `controller`           |
| `controller/package*.json`                | rebuild + recreate `controller`           |
| `liquidsoap/radio.liq`                    | rebuild + recreate `liquidsoap`           |
| `liquidsoap/Dockerfile*`                  | rebuild + recreate `liquidsoap`           |
| `web/**` (prod stack)                     | rebuild + recreate `web`                  |
| `web/**` (dev stack, separate `npm run dev`) | no docker action — hot-reloads in user's terminal |
| `docker/Caddyfile`                        | `docker compose ... restart caddy` (no rebuild — Caddy reloads from mount) |
| `docker/docker-compose*.yml`              | `docker compose ... up -d` (compose re-applies; will only recreate what diff-affected services) |
| `docker/icecast.xml*` or its template     | re-run `scripts/setup.sh` to re-render `state/icecast.xml`, then `up -d --force-recreate icecast` |
| `scripts/setup.sh`                        | safe to re-run (idempotent) — useful when state-dir layout changes |
| `scripts/**` (other), `state/**` (excluding code), `*.md`, `README.md`, `CLAUDE.md`, `.env.example`, `TODO.md` | no action needed |
| `.env` at repo root or `docker/.env`      | `docker compose ... up -d` to pick up new env values (compose detects env-changes and recreates affected services) |
| `controller/.env.example`                 | **does not** affect the running controller (it reads `controller/.env`, not the example). Surface as advisory; ask if the user wants to merge new keys into their `.env`. |

If the diff is empty after categorising (e.g. only README + TODO changed), the right answer is `git pull` and *no* docker action. Pull anyway so the working tree matches `origin` — it makes the next deploy faster.

### Step 4 — Pull, rebuild, recreate

```bash
git pull --ff-only
```

If `--ff-only` refuses (non-fast-forward), pause and ask — don't auto-rebase.

Then rebuild **only** the services from the mapping. Pass them all in one `up -d --build` call so compose orders them correctly:

```bash
# Example: controller and web both changed in prod stack
docker compose -f docker/docker-compose.prod.yml up -d --build controller web
```

Do not use `docker compose restart` for code changes — it will appear to succeed and silently run the old code (see Fact #2).

If you only need to apply a config change (Caddyfile, compose YAML, env), prefer the minimal command:

```bash
# Caddyfile edited - Caddy reloads via mount, just bounce it
docker compose -f docker/docker-compose.prod.yml restart caddy

# Compose YAML edited - let compose figure out what to recreate
docker compose -f docker/docker-compose.prod.yml up -d

# Icecast template edited - re-render, then force-recreate icecast
sudo STATE_DIR=/var/lib/subwave ./scripts/setup.sh
docker compose -f docker/docker-compose.prod.yml up -d --force-recreate icecast
```

### Step 5 — Verify

Run the bundled health-check script — it batches the canonical probes:

```bash
.claude/skills/subwave-deploy/scripts/health-check.sh
```

What healthy looks like:

- All five containers (`caddy`, `controller`, `icecast`, `liquidsoap`, `web` in prod; the dev subset otherwise) `Up` with no `(unhealthy)` or restarting.
- `GET /api/health` → `{"status":"on-air"}`.
- `GET /api/now-playing` → an object with `nowPlaying.title` and `nowPlaying.artist` populated (silence is a yellow flag, not necessarily failed — the stream may just be between tracks), `context.dominantMood` set, and a sane `weather` block.
- No `error|fail|exception` lines in `docker compose logs --since 2m` for any service.

Things that look like failure but aren't:
- `HEAD /stream.mp3` returns `400 Bad Request`. That's normal — Icecast only answers `GET`, not `HEAD`. Use `curl -sI` only to confirm the route exists; don't treat `400` as broken.
- Liquidsoap also gets recreated when you only asked for controller/web. That's compose dependency ordering, not a regression (see Fact #5).
- A few seconds of "Empty queue" or silence right after recreating Liquidsoap — the controller will re-feed `next.txt` on the next 1-second poll.
- On a brand-new install: an empty `nowPlaying.title` for the first minute. The controller is still discovering the library and rendering the first DJ link. Wait one cycle (~10-30s).

If a container is restarting, fetch its last ~80 log lines and report the failure. Don't auto-recreate; the user wants to see the error, not a flapping container.

### Step 6 — Report back

Keep the summary tight. A good shape:

- **Setup mode**: what state was detected (fresh / configured-but-down / running) and what work was done (setup.sh ran, env seeded, X containers built, etc.). Skip this line entirely for routine updates.
- What was pulled (commit range or "already up to date").
- What was rebuilt (or "no rebuild needed").
- Health status: containers up + endpoint outputs + the live track / DJ name from `/api/now-playing` (this proves the full pipeline end-to-end, not just that the container is running).
- Any anomalies surfaced in the log scan or pre-flight (Navidrome/Ollama unreachable, missing prerequisites).

## When to pause and ask

Free to act on: prerequisite checks, `scripts/setup.sh` on a fresh checkout, `git fetch`, `git pull --ff-only`, `docker compose build`, `up -d`, `restart`, `logs`, `generate-jingles.sh`, all health probes, log scans.

**Confirm first** before any of these:

- Overwriting an existing `controller/.env` with a fresh seed from `.env.example` — the operator may already have working credentials in there.
- Echoing or logging Navidrome / Ollama passwords back to the chat at any point.
- Running `scripts/setup.sh` with `sudo` — surface the command, let the user run it themselves if they prefer.
- Auto-installing missing host prerequisites (docker, ffmpeg, etc.) via the package manager — that's a sudo-level decision and depends on the distro.
- `git pull` refusing fast-forward (merge/rebase needed) — diverged history is a human decision.
- Local uncommitted changes that would conflict with the pull.
- `docker compose down` of any kind, especially `down -v` (volumes wipe).
- Force-recreating the whole stack (`up -d --force-recreate` with no service argument).
- Removing or pruning `state/` contents — that directory carries the IPC files, voice WAVs, jingles, and the hourly archive. Losing it is a real loss.
- Removing named volumes or running `docker system prune`.
- Editing the live Caddyfile / compose / `.env` in place when the diff didn't ask for it.

## Helper

`scripts/health-check.sh` (relative to this skill folder) runs the standard probes and emits a compact report. It auto-detects which compose file is live and which host port Caddy is mapped to, so it works whether the user has Caddy on `:80` or `:4800`.

## Notes for working on the project (worth carrying forward)

- `radio.liq`'s `on_track_change` hook is attached to the `music` source, not to a downstream stage. If a deploy edits that hook to a different source, metadata fidelity drops — surface it as a yellow flag.
- The controller is the single writer of `next.txt` and `say.txt` (via `queue.serveNext()`). A diff that adds a second writer is a red flag.
- Voice WAV is written ~200 ms before the track URI; that ordering is load-bearing. A diff that reorders it is a red flag.
- Festivals in `controller/src/context.js` are operator-specific (Sikh/UK calendar). Mention but don't push back on edits there.
- `scripts/setup.sh` is idempotent and safe to re-run — useful when the icecast template or state-dir layout changes. It will *not* overwrite an existing `controller/.env` or `docker/.env`.
