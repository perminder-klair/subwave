# Deploying SUB/WAVE

Three things to pick:

1. **Mode** — `dev` (local hacking), `prod` (single-host, bundled Caddy), or `prod-byo` (you bring your own reverse proxy).
2. **Install style** — `no-clone` (curl two files) or `cloned` (git clone the repo).
3. **Wizard** — finish setup in the **browser** (`/onboarding`) or in the **terminal** (`npm run setup`).

The wizard is independent of the install style — both wizards write to the same files and a cloned install can finish in either (or both, at different times).

---

## The 30-second version

| You want… | Run |
|---|---|
| **Hack on the code locally** (Mac smoke test, branch testing) | `git clone … && cd subwave && npm install && npm run setup` → pick **dev** |
| **Run a public station** on a Linux box, no source clone | `mkdir subwave && cd subwave && curl -O .../docker-compose.yml && curl -O .../.env.example && mv .env.example .env && $EDITOR .env && docker compose up -d && open https://your-host/onboarding` |
| **Run a public station** but you already have Traefik / nginx / your own Caddy | Same as above, but `docker-compose.byo.yml` |
| **Prefer the terminal wizard, but want a prod install** | `git clone … && cd subwave && npm install && npm run setup` → pick **prod** |
| **Already cloned, but prefer the browser** | `./scripts/setup.sh && docker compose up -d --build && open http://localhost:7700/onboarding` |

Everything below is the longer version.

---

## Modes: dev vs prod vs prod-byo

The three compose files at the repo root.

### `docker-compose.yml` — production with bundled Caddy (default)

For a public single-host deploy — the file a fresh `docker compose up -d`
picks up. Spins up **5 containers** (Caddy + Icecast + Liquidsoap +
Controller + Web). **Only Caddy binds a host port** (default `:7700`);
everything else is internal to the docker network and reachable through
Caddy's reverse proxy. Cloudflare is expected to terminate TLS in front.
`radio.liq`, `sounds/`, and the Caddyfile are **baked into images** — no
bind mounts, no clone needed.

```bash
docker compose up -d
```

### `docker-compose.byo.yml` — production, your own reverse proxy

Same as prod, but **without the bundled Caddy**. If you already run Traefik,
nginx, your own Caddy, etc., use this variant. Web (`:7700`), Controller
(`:7701`), and Icecast (`:7702`) bind directly to host ports for your proxy
to front. Use `docker/Caddyfile` as the reference route table to replicate.

```bash
docker compose -f docker-compose.byo.yml up -d
```

### `docker-compose.dev.yml` — local development

For local hacking. Spins up **3 containers** (Icecast + Liquidsoap +
Controller). The web UI runs **outside Docker** as a Next.js dev server
(`npm run dev` on :7700) so JSX edits hot-reload instantly.
`controller/src/`, `radio.liq`, and `sounds/` are **bind-mounted** so
editing the controller, the mixer script, or dropping in new audio doesn't
need a rebuild — the controller container runs under `tsx watch`.

```bash
docker compose -f docker-compose.dev.yml up -d   # icecast + liquidsoap + controller
cd web && npm run dev                             # web UI on :7700, separate process
```

State lives at `./state/` (repo-local).

---

## Two independent choices

Setting up SUB/WAVE is two separate decisions:

1. **How do the files get on disk?** — either `curl` two files (no-clone) or `git clone` the repo (cloned).
2. **How do you finish configuration?** — either the **browser wizard** at `/onboarding`, or the **CLI wizard** via `npm run setup`.

Almost every combination is valid:

|  | Browser wizard (`/onboarding`) | CLI wizard (`npm run setup`) |
|---|:---:|:---:|
| **No-clone** (curl two files) | ✓ | — (no code on disk) |
| **Cloned** (git clone) | ✓ | ✓ |

The browser wizard is just an HTTP surface on the controller — it doesn't care how the stack got there. The CLI wizard needs the code present, so it's cloned-installs only.

### No-clone install + browser wizard

The headline path. Two `curl`s, three env vars, then a browser wizard.

```bash
mkdir subwave && cd subwave
curl -O https://raw.githubusercontent.com/perminder-klair/subwave/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/perminder-klair/subwave/main/.env.example
mv .env.example .env
$EDITOR .env                                  # set ADMIN_USER, ADMIN_PASS, SITE_URL
docker compose up -d
open https://your-host/onboarding             # browser wizard finishes setup
```

### Cloned install + browser wizard

Same browser wizard, just from a local clone (handy when you want the operator console + scripts but prefer clicking to typing).

```bash
git clone https://github.com/perminder-klair/subwave.git
cd subwave
./scripts/setup.sh                            # scaffolds 3-var root .env + state/
docker compose up -d --build                              # prod (builds images locally)
# or for dev:
docker compose -f docker-compose.dev.yml up -d && (cd web && npm run dev &)
open http://localhost:7700/onboarding
```

### Cloned install + CLI wizard

Best when you're on a remote SSH session, scripting an install, or just prefer the terminal.

```bash
git clone https://github.com/perminder-klair/subwave.git
cd subwave
npm install
npm run setup                                 # pick mode, answer prompts, done
```

The CLI wizard prompts for mode (dev / prod / prod-byo), runs preflight (node, docker), collects Navidrome + LLM + admin creds + SITE_URL (prod only) + timezone, then brings the stack up and renders jingles.

### What every path writes to

All three paths converge on the same files:

- `state/setup-config.json` — Navidrome creds + the "setup complete" timestamp
- `state/secrets.env` (mode 0600) — cloud LLM/TTS API keys
- `state/settings.json` — DJ persona, jingle ratio, TTS choices (via the existing admin settings flow)
- root `.env` — `ADMIN_USER`, `ADMIN_PASS`, `SITE_URL`, `TZ`, etc.

Env vars in `.env` always win when set — the wizards only fill in fields env doesn't supply.

---

## The two wizards, side by side

| | CLI wizard (`npm run setup`) | Browser wizard (`/onboarding`) |
|---|---|---|
| Where it runs | Your terminal | A browser, anywhere on the network |
| Requires | Node 20+, npm, a cloned repo | A browser + the stack up |
| Collects | Mode + Navidrome + LLM + admin + SITE_URL + TZ | Navidrome + LLM + TTS + DJ persona + jingles |
| Probes | Live (Navidrome ping, LLM tag call from the host) | Live (via controller endpoints, run inside the container) |
| Persists to | `state/setup-config.json`, `state/secrets.env`, `.env`, POST `/settings` | Same |
| Renders jingles | Optional final step | One-click button on the Jingles step |
| Bypass with | `node bin/subwave setup` (skips npm's buffering) | Visit `/onboarding` after the stack is up |

**They write the same files.** Use whichever fits the situation — terminal during a remote SSH session, browser when you'd rather click than type, or both at different times (the second one detects what the first one wrote and skips the redundant prompts).

---

## Day-to-day

Once installed, these are the everyday commands:

```bash
# Operator console (cloned installs)
npm start                       # status + menu
npm start -- status             # snapshot of stack + now-playing + recent events
npm start -- doctor             # full diagnostic sweep
npm start -- logs controller    # tail one service
npm start -- restart liquidsoap # plain restart (radio.liq is bind-mounted in dev)
npm start -- restart controller # rebuild + recreate (source is COPY-d at build)

# Updates (cloned prod installs)
./scripts/update.sh             # git pull + rebuild changed services + recreate

# Render station idents
./scripts/generate-jingles.sh   # writes WAVs into state/jingles/

# Health probe (cron-friendly, exits 0/1)
./scripts/health-check.sh
```

For no-clone installs, the equivalents are:

```bash
docker compose logs -f controller   # logs
docker compose up -d                # restart after .env edit
docker compose pull                 # pull newer images
docker compose up -d                # recreate with new images
```

…or visit `/admin` (after signing in with `ADMIN_USER` / `ADMIN_PASS`) for
the graphical operator UI.

---

## State layout

Everything that survives `docker compose down` lives in `state/`:

| File / dir | Written by | What it's for |
|---|---|---|
| `setup-config.json` | Wizards | Navidrome creds + setup-complete timestamp |
| `secrets.env` (0600) | Wizards | Cloud LLM/TTS API keys, sourced into the controller's `process.env` on boot |
| `settings.json` | Admin UI / wizard | DJ personas, shows, schedule, TTS choices, weather location |
| `icecast-secrets.env` | `subwave-icecast` image | Auto-generated Icecast passwords on first boot (mode 0600 — only the root broadcast entrypoint + controller read it) |
| `session.json` + `sessions/` | Controller | Live DJ session + archived past sessions |
| `queue.json` | Controller | Track queue snapshot (survives a controller restart) |
| `jingles/`, `jingles.m3u`, `jingles.json` | Controller / `generate-jingles.sh` | Rendered station idents |
| `voice/` | Controller | TTS WAVs rendered for each spoken segment |
| `archive/` | Liquidsoap | Hourly MP3 archive (`YYYY-MM-DD/HH-00.mp3`) |
| `logs/` | Controller + Liquidsoap | Event logs |
| `next.txt`, `say.txt`, `intro.txt`, `auto.m3u`, `now-playing.json` | Controller ⇄ Liquidsoap | File-based IPC (see `CLAUDE.md`) |

Back up `state/` to back up everything. Don't `git clean -dffx` without
checking — `state/` lives inside the repo by default (`STATE_DIR=./state`)
and contains all of the above.

---

## Configuration precedence

Three places config can come from. They win in this order:

1. **Env vars in the root `.env`** — `NAVIDROME_URL=…`, `ANTHROPIC_API_KEY=…`, etc.
2. **`state/setup-config.json`** (Navidrome) and **`state/secrets.env`** (API keys) — what the wizards write
3. **Built-in defaults** in `controller/src/config.ts`

So an operator who wants 12-factor-style deploys can put everything in
`.env` and never run a wizard. The wizard exists for everyone else.

For runtime config (DJ personas, jingle ratio, crossfade duration, TTS
engines, shows, schedule) — that's `state/settings.json`, edited live via
the admin UI at `/admin/settings`. No env-var equivalent for those; they
need to be UI-managed because the schema is too rich for env vars.

---

## When to pick what

| You're… | Install style | Wizard |
|---|---|---|
| Bootstrapping a new homelab box | No-clone prod | Browser at `/onboarding` |
| Demoing on a Mac before a real deploy | Cloned dev | Either — CLI is faster to drive, browser shows you the actual UI |
| Adding a feature to the controller | Cloned dev (web via `npm run dev` for hot-reload) | Either |
| Already running Traefik / nginx / Caddy | No-clone byo-proxy *or* cloned byo-proxy | Browser, or CLI if cloned |
| Want every config knob in env files for CI | Cloned prod | Skip both — hand-edit `.env` and `state/setup-config.json` |
| Remote SSH session, no port-forward set up | Cloned (any mode) | CLI — it's in the same terminal |
| Recovering a backup | Either install style | Skip both — restore `state/` first, then `docker compose up -d`. Wizards detect `setup-config.json` and stay out of your way. |

---

## What's intentionally not included

- **A `curl | sh` installer.** The two-file install (`curl docker-compose.yml` + `curl .env.example`) is the deliberate "as simple as it can be without piping random scripts into your shell" line.
- **Multi-arch (arm64) images.** Piper, Kokoro, and Chatterbox wheels are amd64-only. Pin a Linux/amd64 host.
- **Multi-host / k8s.** SUB/WAVE is a personal radio station — one Icecast mount, one broadcast. Scaling horizontally would mean per-listener streams, which defeats the design.
