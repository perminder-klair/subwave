---
name: subwave-worktree-dev
description: >-
  Stage a SUB/WAVE git worktree so the dev stack can run from it, then start it.
  A git worktree only checks out tracked files — the dev stack also needs
  gitignored files (controller/.env, web/.env.local, docker/.env, web/node_modules,
  and a state/ directory) that this skill copies or scaffolds from the main
  working tree. Use this skill whenever the user wants to test branch changes in
  a worktree, run subwave from a worktree, "prep"/"set up" a worktree for dev
  mode, or asks to copy env files / node_modules / state into a worktree —
  phrases like "test this worktree in dev mode", "start subwave from the
  worktree", "prep the worktree", "run my branch locally", "copy the required
  files into the worktree". Do NOT use it for the main checkout (that's
  subwave-control) or for production.
---

# SUB/WAVE worktree dev setup

Get the SUB/WAVE dev stack running from inside a **git worktree** so branch
changes can be tested without touching the main checkout.

## Why a worktree needs prep

A worktree checks out every **tracked** file, so all source is already there.
But the dev stack also depends on **gitignored** files that do not travel with
a worktree checkout:

| File | Why the stack needs it |
|---|---|
| `.env` | Root `.env` — `ADMIN_USER` / `ADMIN_PASS` / `SITE_URL`. Dev compose references it as `./.env`; compose refuses to start without it. |
| `controller/.env` | Dev compose declares `env_file: ./controller/.env` — controller container won't start without it. Navidrome + Ollama config. |
| `web/.env.local` | Dev API/stream URL overrides (`NEXT_PUBLIC_API_URL` etc.). Without it the web UI defaults to same-origin `/api` and cannot reach the controller. |
| `docker/.env` | Compose variable substitution (legacy — harmless to copy). |
| `state/setup-config.json` | Navidrome creds the wizard saved on main. Without this the controller reports `needsSetup: true` and the player redirects to `/onboarding` on every load. |
| `state/secrets.env` | Cloud LLM / TTS API keys (if main has any). Sourced into the controller's `process.env` on boot. |
| `web/node_modules` | Needed by `npm run dev`. |
| `state/` | Bind-mounted into the containers. A worktree's `state/` is empty. |

`state/` is scaffolded **fresh** — directory structure plus the two onboarding-skip
files (`setup-config.json`, `secrets.env`) so the operator lands directly on the
player. Settings, sessions, queue, library mood data, and rendered jingles are
*not* copied — the worktree station boots clean and the controller writes its
own defaults. The broadcast container generates its own `state/icecast-secrets.env`
on first boot, so worktrees no longer need to copy any rendered icecast config.

## Two load-bearing facts

1. **One stack at a time.** Both compose files use fixed container names
   (`sub-wave-broadcast`, …) and host ports (Web `7700`, Controller `7701`,
   Icecast `7702`). A worktree stack and the main-checkout stack collide — stop
   whatever is running before starting another.
2. **Controller changes need `--build`, web changes do not.** The `controller`
   image `COPY`s its source at build time, so testing worktree controller code
   requires `docker compose up -d --build`. The web dev server (`npm run dev`)
   hot-reloads from the worktree filesystem, so UI changes appear with no build.

## Workflow

### Step 0 — Identify the worktree

The target worktree is usually the session's current directory. Confirm it is a
linked worktree and not the main checkout:

```bash
git rev-parse --absolute-git-dir          # a worktree's is <main>/.git/worktrees/<name>
git worktree list                         # shows the main tree + every linked worktree
```

If the user named a specific worktree path, use that.

### Step 1 — Stop any running stack

Only one stack can run. Stop whatever is up (it may be the main checkout's):

```bash
# Kill the web dev server if it holds :7700 — but only if it is `node`,
# never macOS ControlCenter/AirPlay.
WEB_PID=$(lsof -nP -iTCP:7700 -sTCP:LISTEN -t 2>/dev/null | head -1)
[ -n "$WEB_PID" ] && ps -p "$WEB_PID" -o comm= | grep -qi node && kill "$WEB_PID"

# Bring down whichever dev stack is up. The compose file lives at the
# checkout root (not under docker/); container names are global, so any
# checkout's docker-compose.dev.yml targets the running containers.
docker compose -f <some-checkout>/docker-compose.dev.yml down
```

### Step 2 — Prep the worktree

Run the bundled script. It copies the env files, scaffolds a fresh `state/`,
and runs `npm install` for the web app. `<skill base directory>` is the
absolute path shown as "Base directory for this skill" when the skill loads.

```bash
bash "<skill base directory>/scripts/prep-worktree.sh" <worktree-path>
```

Flags: `--reset-state` wipes and re-scaffolds `state/` (use when the user wants
a clean slate); `--skip-npm` skips the dependency install (use when
`node_modules` is already good). The script is idempotent — re-running it only
fills in what is missing.

### Step 3 — Start the stack from the worktree

Compose files now live at the worktree **root** (not under `docker/`):

```bash
cd <worktree-path> && docker compose -f docker-compose.dev.yml up -d --build
```

`--build` is required so the worktree's controller source is baked into the
image. The first build is slow (all services); later builds only rebuild
changed layers. Then start the web dev server **in the background** (it is a
long-running foreground process):

```bash
cd <worktree-path>/web && npm run dev
```

### Step 4 — Verify on-air

Give Liquidsoap ~5s to connect to Icecast, then probe the controller:

```bash
sleep 5
curl -sf http://localhost:7701/health                               # expect {"status":"on-air"}
curl -sf -o /dev/null -w '%{http_code}\n' http://localhost:7700      # expect 200
```

If `/health` fails, peek at `docker compose logs --tail=30 controller broadcast`
and surface the error. A fresh `state/` is normal — an empty queue and default
settings on first boot are expected, not faults.

## Iterating

- **Web/UI change** — nothing to do; `npm run dev` hot-reloads it.
- **Controller source change** — rebuild just that service:
  `cd <worktree-path> && docker compose -f docker-compose.dev.yml up -d --build controller`.
- **`liquidsoap/radio.liq` change** — it is bind-mounted in dev; just
  `docker compose restart broadcast`.

## Allowed without confirmation

- Running `scripts/prep-worktree.sh` (copies env files, scaffolds `state/`, `npm install`)
- `docker compose up -d --build` / `down` against a worktree's dev compose file
- `npm run dev` / killing a `node` process on `:7700`
- Reading logs, `curl` health probes

## Confirm before running

- `--reset-state` when `state/` already has real data the user may want
- `docker compose down -v` (wipes volumes)
- Killing a non-`node` process on `:7700`
- Touching the **main checkout's** `controller/.env`, `state/`, or config

## When NOT to use this skill / hand off

- **Main checkout**, not a worktree → use `subwave-control` to start/stop.
- **Production** (`docker-compose.yml` or `docker-compose.byo.yml`) → use `subwave-control`.
- First-time repo setup, `git pull` + rebuild, jingle generation, config
  changes → use `subwave-deploy`.
