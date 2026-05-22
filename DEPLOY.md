# Deploy

Production deploy of SUB/WAVE on a single Linux host.
Cloudflare in front terminates TLS; Caddy on the host serves plain HTTP on
`:80` and routes to the four internal services (web, controller, icecast,
liquidsoap).

```
Internet ── HTTPS ──▶ Cloudflare ── HTTP ──▶ host :80 (Caddy)
                                                ├── /          → web:7700
                                                ├── /api/*     → controller:7701
                                                └── /stream.mp3 → icecast:7702
                                                                  ▲
                                                          liquidsoap (internal)
```

## 1. Host prerequisites

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin ffmpeg git
sudo usermod -aG docker "$USER"
# re-login so the group takes effect
```

Outbound network requirements from the host:
- Ollama: whatever URL is in `controller/.env` (e.g. `http://localhost:11434`)
- Navidrome: same (Subsonic API)
- Open-Meteo (`api.open-meteo.com`) — public, no auth

Inbound: only `:80` from Cloudflare's IP ranges (and SSH for you).

## 2. Clone and seed state

```bash
git clone git@github.com:perminder-klair/subwave.git
cd subwave
./scripts/setup.sh
```

This creates `state/{voice,archive,jingles,logs}`, touches `auto.m3u`
and `jingles.m3u`, and renders `emergency.mp3` (30s of low pink noise — the
last-resort fallback when every other source dies).

State lives in `<repo>/state` by default. `docker compose down -v` won't touch
it — it's a bind mount, not a named volume — but `git clean -fdx` **will**, so
keep it clear of destructive clean runs and back it up to preserve archives and
idents. To keep state on a separate disk, export `STATE_DIR=/path/to/state`
before running `setup.sh` (it records the value into `docker/.env`).

## 3. Secrets

Two files. Neither is in git.

**`controller/.env`** — runtime config for the Node controller:

```bash
cp controller/.env.example controller/.env
$EDITOR controller/.env
```

Required values:
- `NAVIDROME_URL`, `NAVIDROME_USER`, `NAVIDROME_PASS`
- (Ollama server URL + model are set in the admin Settings UI, not via env)
- `ICECAST_SOURCE_PASSWORD` — must match the value Caddy/Icecast see (next file)

**`docker/.env`** — passwords compose passes to Icecast and shares with Liquidsoap:

```bash
cat > docker/.env <<EOF
ICECAST_SOURCE_PASSWORD=$(openssl rand -hex 16)
ICECAST_ADMIN_PASSWORD=$(openssl rand -hex 16)
ICECAST_RELAY_PASSWORD=$(openssl rand -hex 16)
# STATE_DIR=/srv/subwave   # optional — defaults to <repo>/state if omitted
EOF
```

Copy the `ICECAST_SOURCE_PASSWORD` value into `controller/.env` so the
controller, Liquidsoap, and Icecast all agree.

The prod compose file uses `${VAR:?must be set}` for the Icecast secrets, so
it will refuse to start if any are missing — no silent `changeme` defaults.

**`SITE_URL`** — the public domain (e.g. `https://www.getsubwave.com`), used for
the Open Graph / Twitter share cards, canonical URLs, `robots.txt`, and the
sitemap. Define it once in `docker/.env`; the prod compose file feeds it to
the `web` service as **both** a build arg and a runtime env var (the static
pages bake their share tags at build, the dynamic homepage renders them per
request). Changing it needs `up -d --build web`. Unset → a localhost origin,
which breaks social previews and search indexing.

## 4. First boot

```bash
docker compose -f docker/docker-compose.prod.yml up -d --build
docker compose -f docker/docker-compose.prod.yml ps
docker compose -f docker/docker-compose.prod.yml logs -f
```

Health checks:

```bash
curl -fsS http://localhost/api/health         # → {"status":"on-air"}
curl -fsSI http://localhost/stream.mp3 | head # → audio/mpeg
curl -fsSI http://localhost/                  # → 200, Next.js page
```

If `/api/health` works but `/stream.mp3` doesn't, check Liquidsoap connected
to Icecast: `docker compose -f docker/docker-compose.prod.yml logs liquidsoap`
and look for `Source ... started`.

## 5. Render jingles

After the stack is up:

```bash
./scripts/generate-jingles.sh
```

Edit the `JINGLES` array at the top of the script to taste, then re-run.
Liquidsoap's jingles playlist uses `reload_mode="watch"`, so new renders are
picked up live — no restart.

## 6. Cloudflare

DNS: an `A` record for `subwave.<your-domain>` pointing at the host's public
IPv4 (or use Cloudflare Tunnel — see note below). Proxy status: **proxied**
(orange cloud).

SSL/TLS mode: **Full** (not Full (strict)) since Caddy is plain HTTP on the
origin. If you'd rather run Full (strict), enable Caddy's auto-HTTPS and
provision a cert, or use an origin cert from Cloudflare.

Firewall: lock origin port `:80` to Cloudflare IP ranges only —
[cloudflare.com/ips](https://www.cloudflare.com/ips/). Example with `ufw`:

```bash
for cidr in $(curl -s https://www.cloudflare.com/ips-v4); do
  sudo ufw allow from "$cidr" to any port 80 proto tcp
done
sudo ufw enable
```

Alternative: skip the public IP entirely and use **Cloudflare Tunnel**
(`cloudflared`) to expose `http://localhost:80` to Cloudflare without opening
any inbound ports. Same end result, no firewall fiddling.

The Caddyfile already trusts Cloudflare's IP ranges so `X-Forwarded-For`
gives you real listener IPs in logs.

## 7. Updates

```bash
./scripts/update.sh
```

This runs:
1. `git pull --ff-only`
2. `docker compose pull --ignore-buildable` (refresh base images: Caddy, Icecast, Liquidsoap, Node)
3. `docker compose build --pull` (rebuild controller and web)
4. `docker compose up -d --remove-orphans` — only services whose image or
   config actually changed get recreated. Listeners on `/stream.mp3` only
   notice a hiccup if Liquidsoap or Icecast restart (rare — they're pinned
   image versions).
5. `docker image prune -f`

If a deploy goes wrong, roll back:

```bash
git log --oneline -5
git checkout <previous-sha>
docker compose -f docker/docker-compose.prod.yml up -d --build
```

## 8. Operations

```bash
# Tail logs
docker compose -f docker/docker-compose.prod.yml logs -f controller
docker compose -f docker/docker-compose.prod.yml logs -f liquidsoap
docker compose -f docker/docker-compose.prod.yml logs -f caddy

# Restart just one service
docker compose -f docker/docker-compose.prod.yml restart controller

# Manual skip (controller exposes POST /skip, Caddy proxies it under /api)
curl -X POST http://localhost/api/skip

# What's queued / playing / in the DJ log
curl -s http://localhost/api/state | jq

# Disk usage of archives + voice renders
du -sh state/*
```

Logs Liquidsoap writes go to `state/logs/radio.log`.
Hourly stream archives go to `state/archive/YYYY-MM-DD/HH-00.mp3`
— prune these on a cron if you don't want unbounded growth.

## 9. Backup

The only stateful path is `state/` (under the repo). Two things really matter:

- `archive/` — your show recordings. Big. Back up or rotate.
- `jingles/` + `jingles.m3u` — re-derivable from `scripts/generate-jingles.sh`,
  so backup is optional.

Everything else (`voice/`, `auto.m3u`, `now-playing.json`, the queue files)
is ephemeral and regenerates within minutes of a fresh boot.

A nightly tar of `state/archive/` to an external box is
sufficient.

## 10. Native install (no Docker)

For homelabs, NAS boxes, or SBCs that already run other services and don't
want a Docker daemon, SUB/WAVE has a parallel "native install" path that uses
systemd user units (Linux) or LaunchAgents (macOS). It lives alongside the
Docker stack — pick one or the other; no shared state besides `docker/.env`
(which the installer reuses for the Icecast source password).

```bash
# fresh checkout
./scripts/install-native.sh
$EDITOR controller/.env             # Navidrome creds, LLM key, ADMIN_USER/PASS
systemctl --user enable --now subwave.target
```

The installer detects Debian/Ubuntu, Arch, Fedora, or macOS; installs system
packages (`icecast2`/`icecast`, `liquidsoap`, `nodejs`, `ffmpeg`, `caddy` if
available); fetches Piper + the British voice into `state/runtime/piper/`;
builds the Kokoro venv at `state/runtime/kokoro/` on Linux (skipped on macOS,
see *Risks* below); runs `npm ci && npm run build` in `web/` to produce the
Next.js standalone output; and renders the systemd units / launchd plists into
your user-scoped unit dir. Re-running it is safe — every step is idempotent.

**Edge mode — Caddy or not.** By default the installer assumes you'll run the
Caddy edge proxy, so the web build keeps its same-origin defaults (`/api`,
`/stream.mp3`) — these only resolve when something maps those paths onto the
web app's origin, which is Caddy's job. To skip Caddy entirely and let
listeners hit the three services on their own ports, run the installer with
`SUBWAVE_EDGE=none`:

```bash
SUBWAVE_EDGE=none SUBWAVE_HOST=radio.lan ./scripts/install-native.sh
```

That auto-generates `web/.env.production` with absolute URLs
(`http://$SUBWAVE_HOST:7701` for the API, `http://$SUBWAVE_HOST:7702/stream.mp3`
for the stream), bakes them into the web build, and binds the web server to
`0.0.0.0` instead of loopback. `SUBWAVE_HOST` defaults to `localhost` — set it
to the LAN IP or DNS name listeners actually use. Because `NEXT_PUBLIC_*` are
build-time constants, switching edge mode means re-running the installer (it
rebuilds web); switching back to the default `caddy` removes the generated
file. In `none` mode the controller (`:7701`) and icecast (`:7702`) must be
reachable from listeners — both bind all interfaces by default, so only a host
firewall would get in the way.

### Day-to-day (Linux)

```bash
systemctl --user status 'subwave-*'
journalctl --user -u subwave-controller -f
systemctl --user restart subwave-controller            # picks up .env changes
systemctl --user enable --now subwave-caddy.service    # optional :4800 edge
```

To keep the stack running across logout / boot without you being logged in:

```bash
loginctl enable-linger "$USER"
```

### Day-to-day (macOS)

```bash
launchctl print "gui/$UID/com.subwave.controller"      # status
launchctl kickstart -k "gui/$UID/com.subwave.controller"  # restart
tail -f state/logs/controller.err
```

macOS launchd has no `EnvironmentFile=` equivalent — the installer inlines
`controller/.env` into the controller plist. **Re-run the installer after
editing `controller/.env`**, then `launchctl kickstart -k`.

### Risks and caveats

- **Kokoro on macOS** — `kokoro-onnx` on Apple Silicon has fiddly ONNX
  runtime wheel issues. The installer skips the Kokoro venv on macOS; the
  controller falls back to Piper / cloud TTS automatically (every codepath
  is covered). Flip back on by building the venv manually and re-running
  the installer; the env vars in the plist are already wired up.
- **Debian's icecast2 service** — `apt install icecast2` enables a system
  service on port 7702. The installer disables it (`systemctl disable --now
  icecast2`) so our user unit can bind the port. Look out for the prompt.
- **Pi 4 / Pi 5 (aarch64)** — installer picks the `linux_aarch64` Piper
  release via `uname -m`. Kokoro on aarch64 is supported but slow.
- **Caddy and port 80/443** — rootless `systemctl --user` can't bind
  ports < 1024. The Caddy unit listens on `:4800` (matches the Docker
  prod compose). To listen on `:80`/`:443`, either:
  - `sudo setcap 'cap_net_bind_service=+ep' $(command -v caddy)`, edit the
    `Caddyfile` at `state/caddy/Caddyfile` to listen on `:80`, and restart
    the user unit; or
  - Convert `subwave-caddy.service` to a system unit (copy into
    `/etc/systemd/system/`, drop the `--user` flag everywhere) so it can
    bind privileged ports.
- **Node version** — controller targets Node 22. Debian 12's distro `nodejs`
  package is v18; the installer warns and points you at NodeSource for the
  upgrade path.
- **Caddy not in Debian default repos** — installer tries the upstream Caddy
  apt repo first. Failure isn't fatal because Caddy is optional: install with
  `SUBWAVE_EDGE=none` (see *Edge mode* above) and the web build is wired to
  reach the controller and icecast directly, no proxy needed.

### Files the native install drops

| Path | What |
|------|------|
| `~/.config/systemd/user/subwave*.service` | Unit files, envsubst-rendered from `systemd/` templates |
| `~/.config/systemd/user/subwave.target`   | Umbrella target |
| `~/Library/LaunchAgents/com.subwave.*.plist` | macOS analogues, from `launchd/` templates |
| `state/runtime/piper/`                    | Piper binary + voice |
| `state/runtime/kokoro/venv/`              | Kokoro Python venv (Linux only) |
| `state/runtime/kokoro/models/`            | Kokoro ONNX + voices bundle |
| `state/caddy/Caddyfile`                   | Native Caddyfile (loopback upstreams, `:4800`) |
| `web/.env.production`                     | Only under `SUBWAVE_EDGE=none` — absolute API/stream URLs baked into the web build |
| `state/icecast.xml`                       | Icecast config (same as Docker — `setup.sh` renders it) |
| `web/.next/standalone/`                   | Next.js standalone bundle + copied static + public |

