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

**Route the whole `/stream*` family, not just `/stream.mp3`.** The web image
is baked for same-origin paths, and everything the proxy doesn't send to
Icecast falls through to the Next.js catch-all and 404s. On one hostname:

| Path | Upstream | Notes |
|---|---|---|
| `/api/listener-auth` | — | Return 404 at the edge. Icecast calls it directly over the internal network; exposed publicly it's an unthrottled password oracle (#478). This rule must win before the general `/api/*` rule. |
| `/stream.mp3` `/stream.opus` `/stream.flac` `/stream.aac` | Icecast `:7702` | Opus/FLAC/AAC are off by default but **still need routing** — enabling one in admin must not also need a proxy edit. Disable response buffering on these (Caddy `flush_interval -1`, nginx `proxy_buffering off`) or the audio arrives in lumps. |
| `/listen.pls` `/listen.m3u` | Controller `:7701` | Playlist files for hardware radios / VLC. Keep the path unchanged: they are controller routes served at the **root**, not under `/api`. |
| `/api/*` | Controller `:7701` | Strip the `/api` prefix (Caddy `handle_path`). |
| everything else | Web `:7700` | |

A path-prefix rule matching `^/stream` covers the first row and any mount
added later. Splitting the player across two hostnames is a different job —
it needs a web rebuild with `NEXT_PUBLIC_*` pointing at each.

Copy-paste nginx, Nginx Proxy Manager, Traefik, and Cloudflare Tunnel
configurations live in [Reverse-proxy recipes](reverse-proxy.md).

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
| `stems/` | Analyzer | Cached Demucs stem windows for stem-blend transitions — byte-budgeted by `audio.stemCacheGb` (Settings → Transitions) |
| `transitions/` | Analyzer | Rendered stem-blend clips (swept after ~1h) |
| `next.txt`, `jingle-now.txt`, `say.txt`, `intro.txt`, `auto.m3u`, `now-playing.json` | Controller ⇄ Liquidsoap | File-based IPC (see `CLAUDE.md`) |

Back up `state/` to back up everything. Don't `git clean -dffx` without
checking — `state/` lives inside the repo by default (`STATE_DIR=./state`)
and contains all of the above.

### Putting the stem cache or the archive on another disk

`stems/` and `archive/` are the two dirs that grow without bound — the stem
cache to whatever `audio.stemCacheGb` allows (up to 1 TB), the archive by
about 1.4 GB a day at 128 kbps. Both are usually the reason someone wants
part of `state/` on a bigger, cheaper disk.

Set `STEMS_DIR` in `.env` to the host folder you want to use. Compose mounts
that folder into all three services at one fixed container path and hands them
that path as `SUBWAVE_STEMS_DIR`, which is what the controller resolves the
cache against:

```dotenv
# .env
STEMS_DIR=/mnt/bigdisk/subwave-stems
```

Move what is already cached across first — nothing migrates it for you, and
the old copy is simply orphaned where it sits:

```sh
docker compose down
mv state/stems/* /mnt/bigdisk/subwave-stems/    # multi-station: state/stations/<id>/stems
docker compose up -d
```

If the stack is already on the new setting, recreating the three services is
enough:

```sh
docker compose up -d --force-recreate broadcast controller analyzer
```

If `STEMS_DIR` is unset, the cache remains at `${STATE_DIR:-./state}/stems` —
removing the line is a clean undo.

**Multi-station installs get a folder per station under it**
(`/mnt/bigdisk/subwave-stems/stations/<id>/`). Compose cannot read
`state/stations/active.json`, so the mount has to address the install rather
than the station; the per-station segment is re-appended on the other side.
It has to stay split, because Navidrome credentials are per-station: two
stations can index different libraries, and this cache is keyed by track id
alone.

Three things to know before you do it:

- **Mount it in the controller *and* the analyzer, at the identical path.**
  The controller hands the analyzer a filesystem *path*, not audio (the same
  fast handoff a remote analyzer can fall back from for ordinary analysis, but
  not for stem output — see
  ["Running the analyzer on another machine"](tts-heavy.md)). A stems mount
  that only one of them can see fails every write.
- **Ownership sorts itself out on boot.** A fresh bind mount lands root-owned
  and the analyzer runs as uid 10001, so it could not write there. The
  broadcast entrypoint now opens `stems/` and `transitions/` to mode 777 on
  every boot, exactly as it already did for `voice/`, `sfx/` and the rest —
  and, when `STEMS_DIR` is set, the relocated root as well, which the in-state
  loop never reaches.
- **A mount that refuses `chmod` no longer stops the station.** Read-only
  binds, some NFS exports and exFAT/NTFS disks won't take the permission
  change. That used to abort the broadcast entrypoint before Icecast started,
  which compose reported as `dependency failed to start: container
  sub-wave-broadcast is unhealthy` and nothing else (#1300 bug 10). It now
  warns, naming the path, and boots:

  ```
  broadcast: WARNING state dir /var/sub-wave/stems is mode 755 and chmod could not
  change it — the controller and analyzer containers write there as other uids;
  chown/chmod it on the host
  ```

  Fix it on the host (`chown -R 10001 /mnt/bigdisk/subwave-stems`, or mount
  the share with the right `uid=`/`gid=` options) — a stem cache the analyzer
  can't write just means transitions fall back to a plain crossfade, but the
  same warning on `voice/` or `logs/` is worth acting on.

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

## Real listener IPs behind a proxy

Admin → **Listeners** shows one row per connection, with an IP. Behind a reverse
proxy, that IP is the *proxy's* — the `172.x` container address of the bundled
Caddy — because the proxy is the only peer Icecast ever talks to.

Icecast will believe the `X-Forwarded-For` header, but only from proxies you name
explicitly. Two facts about the Icecast build shipped here (icecast-KH 2.4.0-kh22)
shape how you configure it:

- **It matches on an exact IP.** A CIDR like `172.16.0.0/12` is accepted without
  any error and then silently never matches. There is no "trust this subnet".
- **It reads the left-most entry** of the forwarded chain, which is the original
  client — correct even though Caddy appends its own peer on the way through.

One consequence of the left-most read: when Cloudflare fronts the stack (proxied
DNS or a tunnel), a client can seed its own `X-Forwarded-For` and Cloudflare
*appends* the real IP rather than replacing it — so the left-most entry, and the
row in the Listeners table, is whatever the client claimed. Treat the IPs as
advisory in that setup. Listener *counts* are unaffected either way (they never
key on IP), and direct-to-Caddy connections can't spoof (an untrusted peer's
header is discarded and rewritten).

### Bundled Caddy (default compose)

Nothing to do for the steady state: the broadcast container resolves `caddy` by
name every time it starts, so listener rows are correct after the first restart.

The gap is the *first* cold `docker compose up` — Caddy waits on broadcast's
healthcheck, so it isn't running yet when broadcast renders its config, and rows
read as the proxy IP until the next bounce. If you want it right immediately, pin
the edge to a static address and name it:

```yaml
# docker-compose.yml
services:
  caddy:
    networks:
      default:
        ipv4_address: 172.20.0.100

networks:
  default:
    ipam:
      config:
        - subnet: 172.20.0.0/24
```

```bash
# .env
ICECAST_TRUSTED_PROXY_IPS=172.20.0.100
```

Pick a subnet that isn't already allocated on the host — `docker compose up` fails
with a pool-overlap error if it collides, and `docker network ls` plus
`docker network inspect` will tell you what's taken.

### Your own proxy (`docker-compose.byo.yml`)

There's no bundled edge to resolve, so set the address your proxy reaches Icecast
from. On a host-network nginx that's usually the Docker bridge gateway:

```bash
ICECAST_TRUSTED_PROXY_IPS=172.17.0.1
```

If you're unsure what Icecast is actually seeing, the current (wrong) IP in the
Listeners table *is* the address to trust.

### Cloudflare Tunnel

A tunnel needs one extra step, because there are two hops to fix rather than one.
`cloudflared` runs as its own container, so the peer reaching Caddy is a private
Docker address — not one of the Cloudflare ranges `docker/Caddyfile` trusts — and
Caddy discards the forwarded header it arrived with. Append `private_ranges` to
the `trusted_proxies` list so Caddy keeps it:

```caddy
servers {
    trusted_proxies static \
        173.245.48.0/20 ... 2c0f:f248::/32 \
        private_ranges
}
```

then configure the Icecast hop as above.

> **Weigh this one.** Trusting private ranges means anything that can reach Caddy
> from private address space can forge `X-Forwarded-For` — which fakes rows in the
> Listeners table *and* defeats the controller's per-IP rate limiting, since that
> keys on the left-most entry. Fine when the tunnel is the only way in; not fine
> when the host port is also exposed to a shared LAN.

That's what `TRUST_CF_CONNECTING_IP` is for. It doesn't replace `private_ranges`
above — the Listeners table still needs that for Icecast's own IP display — but
it undoes the damage the blockquote describes for the controller's side: set
`TRUST_CF_CONNECTING_IP=1` in the root `.env` and `clientIp()` — the identity
every per-IP gate keys on — reads `CF-Connecting-IP` instead of
`X-Forwarded-For`. Cloudflare sets that header itself from the real edge
connection; a client can't seed it the way it can seed a chain that a
private-range peer is now trusted to pass through untouched. **Leave it unset
(the default) for every other topology on this page** — on the bundled-Caddy
and BYO setups above, `trusted_proxies` names only Cloudflare's own ranges or
your proxy's fixed address, so Caddy already replaces a client-supplied
`X-Forwarded-For` for any peer it doesn't trust, and the left-most entry is
already genuine; trusting the CF header there too would just add a second
forgeable one for no reason. Either way, both headers rest on the same
guarantee: the origin is reachable *only* through the edge that sets the one
you trust.

*(Thanks to the community member who worked this out and wrote it up on Discord.)*

### All-in-one image

Nothing to configure — Caddy is in the same container, so loopback is trusted
automatically.

---

## What's intentionally not included

- **A `curl | sh` installer.** The two-file install (`curl docker-compose.yml` + `curl .env.example`) is the deliberate "as simple as it can be without piping random scripts into your shell" line.
- **Multi-arch (arm64) images.** Piper, Kokoro, and Chatterbox wheels are amd64-only. Pin a Linux/amd64 host.
- **Multi-host / k8s.** SUB/WAVE is a personal radio station — one Icecast mount, one broadcast. Scaling horizontally would mean per-listener streams, which defeats the design.
