# Deploy

Production deploy of SUB/WAVE on a single Linux host.
Cloudflare in front terminates TLS; Caddy on the host serves plain HTTP on
`:80` and routes to the four internal services (web, controller, icecast,
liquidsoap).

```
Internet ── HTTPS ──▶ Cloudflare ── HTTP ──▶ host :7700 (Caddy)
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

## 9. Bring your own reverse proxy

If you already run Traefik, nginx, an existing Caddy, or another reverse
proxy in your homelab, the bundled Caddy will either clash on `:7700` or
duplicate work you already have. Use the BYO-proxy compose variant instead:

```bash
docker compose -f docker/docker-compose.byo-proxy.yml up -d
```

It drops the bundled Caddy and binds each user-facing service directly to a
host port:

| Port (default) | Service | What your proxy should forward |
|---|---|---|
| `${WEB_PORT:-7700}` | Next.js web UI | everything not matched below |
| `${CONTROLLER_PORT:-7701}` | controller HTTP API | `/api/*` (with the `/api` prefix stripped) |
| `${ICECAST_PORT:-7702}` | Icecast | `/stream.mp3` (disable buffering for live audio) |

Liquidsoap stays internal-only — it has no public surface.

Override any of the host ports by setting `WEB_PORT`, `CONTROLLER_PORT`, or
`ICECAST_PORT` in `docker/.env`.

**Single-origin routing is the default.** The web UI is built to call `/api`
and `/stream.mp3` relative to its own origin, so the cleanest setup is one
hostname (e.g. `https://radio.example.com`) where your proxy fronts all three.
`docker/Caddyfile` is a working reference for what that route table looks
like — replicate it in your Traefik labels, nginx `location` blocks, or
existing Caddyfile.

If you instead want separate hostnames per surface (e.g. `api.example.com`
and `stream.example.com`), you'll have to rebuild the `web` image with
`NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_STREAM_URL` set — those values are
baked into the client bundle at build time, not read at runtime.

Everything else in this guide still applies — secrets in `controller/.env` +
`docker/.env`, `./scripts/setup.sh` for state and the icecast XML, jingle
rendering, updates, and backup. Skip section 6 (Cloudflare + Caddy firewall);
your own proxy handles that.

## 10. Backup

The only stateful path is `state/` (under the repo). Two things really matter:

- `archive/` — your show recordings. Big. Back up or rotate.
- `jingles/` + `jingles.m3u` — re-derivable from `scripts/generate-jingles.sh`,
  so backup is optional.

Everything else (`voice/`, `auto.m3u`, `now-playing.json`, the queue files)
is ephemeral and regenerates within minutes of a fresh boot.

A nightly tar of `state/archive/` to an external box is
sufficient.
