# Running SUB/WAVE on Unraid

Two supported ways, depending on how much you want to manage:

1. **One-click from Community Applications** — install the single all-in-one
   container, set a few fields, done. Easiest; recommended for most people.
2. **The full Compose stack via Compose Manager Plus** — run the maintained
   `docker-compose.yml` as separate broadcast / controller / web / Caddy
   services. Pick this if you want split containers, your own reverse proxy, or
   the optional `tts-heavy` sidecar.

Both end at the same place: a browser wizard at `/onboarding` that collects
Navidrome, the LLM provider, TTS and the DJ persona. Start to on-air is about
five minutes either way.

---

## Option 1 — One-click (Community Applications)

SUB/WAVE is **live in Community Applications** —
[ca.unraid.net/apps/sub-wave](https://ca.unraid.net/apps/sub-wave-073qgwu0ch9rtu).

The Apps store catalogue is one container per template, so the one-click image
(`subwave-aio`) bundles the whole stack — icecast2 + liquidsoap, the controller,
the web UI and a Caddy edge — into a single container behind one port. It's the
same images as the Compose stack, just packaged together.

### Install

1. **Apps** tab → search **SUB/WAVE** → **Install**.
2. Set the template fields:

   | Field | Value |
   |---|---|
   | **WebUI Port** | host port for the UI + stream (default `7700`) |
   | **Appdata** | `/mnt/user/appdata/subwave` — on the array/pool, **not** the flash |
   | **ADMIN_USER** | your admin username (e.g. `admin`) |
   | **ADMIN_PASS** | a strong password — **required** (`openssl rand -hex 16`) |
   | **SITE_URL** | `http://YOUR-UNRAID-IP:7700` |
   | **TZ** | your timezone (advanced; default `Europe/London`) |

3. **Apply.** First pull is a few GB. When it's up, open the WebUI and finish at
   `http://YOUR-UNRAID-IP:7700/onboarding`.

> ⚠️ **Keep Appdata on the array/pool, not the flash drive.** SUB/WAVE's state
> grows — hourly archives, the library cache, rendered voices — so point it at
> your appdata share, never `/boot/...`.

> ⚠️ **If your appdata share lives on a pool (cache), use the direct pool path**
> — e.g. `/mnt/cache/appdata/subwave` instead of `/mnt/user/appdata/subwave`.
> The library cache is a SQLite database in WAL mode, and `/mnt/user` paths go
> through Unraid's shfs/FUSE layer even for cache-only shares. SQLite
> [documents](https://www.sqlite.org/wal.html) that WAL doesn't work properly
> over FUSE-style filesystems — in practice it means sluggish admin pages and
> a WAL file that balloons to hundreds of MB (issue #786). Same rule the
> Sonarr/Radarr projects apply to their databases. Already installed on
> `/mnt/user`? Stop the container, edit the path mapping to the `/mnt/cache/...`
> equivalent (same data, FUSE bypassed), and start it again.

Fronting this with your own NPM / SWAG / Traefik for TLS + a hostname? See
[Putting it behind your own reverse
proxy](#putting-it-behind-your-own-reverse-proxy) — it's one upstream, with a
single stream-buffering gotcha to mind.

### Install a pre-release by Template URL

To run a build before it propagates into the Apps catalogue (e.g. testing a
new tag), add the template directly instead of searching: **Docker** tab →
**Add Container** → paste this into **Template URL**, then fill the same fields:

```
https://raw.githubusercontent.com/perminder-klair/subwave/main/templates/subwave.xml
```

---

## Option 2 — Full Compose stack (Compose Manager Plus)

Run the maintained `docker-compose.yml` (the same file every other host uses) as
separate services. Good if you want each service isolated, your own
Traefik/SWAG/NPM in front, or the optional Chatterbox/PocketTTS sidecar.

### Prerequisites

- Unraid 7.x with **Docker enabled** and the array (or a pool) started.
- The **Community Applications** plugin (ships with Unraid).

### 1. Install Compose Manager Plus

**Apps** tab → search **Compose Manager Plus** (by `mstrhakr`) → **Install** the
stable release. It adds a **Compose** section to the **Docker** tab.

### 2. Create the stack

**Docker** tab → **Compose** → **Add New Stack** → name it `subwave` → **Create**
→ **Edit Stack**.

- **Compose** tab: paste the contents of the default
  [`docker-compose.yml`](https://raw.githubusercontent.com/perminder-klair/subwave/main/docker-compose.yml).
  It brings up five containers; only Caddy binds a host port (`:7700`),
  everything else is internal. The optional `tts-heavy` sidecar is
  profile-gated and won't start — the DJ falls back to the built-in Piper voice.
- **.env** tab: paste the three required vars plus the two Unraid-specific ones:

```ini
# Required
ADMIN_USER=admin
ADMIN_PASS=change-me            # generate one: openssl rand -hex 16
SITE_URL=http://YOUR-UNRAID-IP:7700

# Unraid-specific — keep state OFF the flash drive
STATE_DIR=/mnt/user/appdata/subwave/state
CADDY_PORT=7700
TZ=Europe/London
```

**Save.**

> ⚠️ **Set `STATE_DIR` to an absolute appdata path.** Compose Manager's project
> directory lives on the USB flash (`/boot/...`), so the compose default of
> `./state` would write SUB/WAVE's growing state onto the boot stick. Point it
> at your pool/array (`/mnt/user/appdata/subwave/state`) instead.

### 3. Pull and start

From the stack's action menu pick **Pull & Up** (not plain *Compose Up*).

> The compose file carries `build:` blocks so a source checkout can rebuild
> locally. The Unraid project directory has no source, so a plain *up* would try
> to build and fail. **Pull & Up** fetches the prebuilt images from GHCR first,
> then starts them — no build. (Alternatively, delete the `build:` blocks and a
> plain *up* works too.)

First pull is ~1–2 GB. When it finishes you'll have five running containers.
Flip the stack's **Autostart → ON** so it comes back after a reboot. Then finish
at `http://YOUR-UNRAID-IP:7700/onboarding`.

---

## The AI DJ on Unraid: Ollama (local **or** cloud)

Applies to both options. SUB/WAVE ships a first-class **"Ollama — local/cloud"**
provider. Most Unraid boxes don't have a big GPU, so the nicest path is Ollama's
**cloud models**, which offload inference — even a low-power box (e.g. an Intel
N95) handles them fine:

1. **Apps** tab → install the official **ollama** container (defaults are right:
   port `11434`, appdata `/mnt/user/appdata/ollama`, `OLLAMA_HOST=0.0.0.0:11434`).
2. Open the ollama container's **Console** and run `ollama signin`; approve the
   printed link in your browser (needs an Ollama account; `:cloud` models need a
   cloud subscription). Auth persists in the appdata volume.
3. In SUB/WAVE: **admin → Settings → LLM Provider** → provider
   **Ollama — local/cloud**, server URL `http://host.docker.internal:11434`,
   model a `:cloud` tag (e.g. `glm-5.2:cloud`) — or a small local tag like
   `llama3.2:3b` if you'd rather run on CPU. **Save LLM provider**.

`host.docker.internal` resolves from SUB/WAVE's container(s) to the Unraid host,
where the ollama container publishes `11434`. (The one-click template adds the
`host-gateway` mapping for you; the Compose stack sets it via `extra_hosts`.)

---

## Acoustic analysis (default-on) & expressive voices (opt-in)

Two heavier capabilities, now packaged separately:

**Acoustic analysis** — tempo, key, and loudness — runs in the **`analyzer`**
container, which **starts by default** (a lean, multi-arch image, so it also
runs on arm64 Unraid boxes). On the split stack it comes up with the rest of the
services; on the **all-in-one** image it's baked in-process. Nothing to enable —
just run **admin → Library → Rescan** (tick *re-analyse*). If the **acoustic
engine reads "off"**, the analyzer container was stopped — `Pull & Up` (split
stack) or check its logs.

**"Sounds-like" + vocal ranges (the heavy dimensions)** need a CPU-torch stack
that isn't in the lean image (the `-heavy` images are ~1.9 GB):

- **Split stack (Compose Manager).** Add `ANALYZER_HEAVY=1` to your **.env**,
  **Save**, then **Pull & Up** — the `analyzer` container re-pulls as
  `subwave-analyzer-heavy`.

  **Got an NVIDIA card in the box?** Use the CUDA flavour instead — same
  features, GPU-fast: add `docker-compose.analyzer-gpu.yml` from the repo as a
  second compose file in the stack (it swaps the analyzer to
  `subwave-analyzer-cuda` and reserves the GPU; `ANALYZER_HEAVY` is then
  irrelevant). Needs the Unraid **Nvidia Driver** plugin; if the GPU isn't
  visible the analyzer just falls back to CPU.
- **All-in-one (one-click from Community Applications).** The heavy/lean split
  is baked into the image, so you switch by pointing the container at the heavy
  tag — **`ANALYZER_HEAVY` does nothing here** (it's the split-stack toggle):
  1. **Docker** tab → click the **subwave** container → **Edit** (turn on
     *Advanced View*, top-right).
  2. Change the **Repository** field from
     `ghcr.io/perminder-klair/subwave-aio:latest` to
     `ghcr.io/perminder-klair/subwave-aio-heavy:latest`.
  3. **Apply** — Unraid re-pulls and recreates the container.

  Your state is untouched (it all lives under the appdata volume, including the
  `hf-cache` where the CLAP/Demucs weights land), so config, personas, and
  library tags survive the swap. First boot on heavy downloads the model weights
  into that cache, so give it a few minutes. To go back, edit the Repository
  field back to `subwave-aio` and **Apply**.

  **Got an NVIDIA card in the box?** There's a GPU flavour of the one-click
  image too — `subwave-aio-cuda`, the same heavy features with CLAP + Demucs
  running on the card instead of the CPU. It's the identical Edit flow with two
  extra fields:
  1. Install the Unraid **Nvidia Driver** plugin (Apps → search *Nvidia
     Driver*) and reboot if it asks. Note your GPU's UUID from
     **Settings → Nvidia Driver**.
  2. **Docker** tab → **subwave** → **Edit** (*Advanced View* on).
  3. **Repository** → `ghcr.io/perminder-klair/subwave-aio-cuda:latest`.
  4. **Extra Parameters** → append `--runtime=nvidia` (keep the existing
     `--add-host` value; the field takes both).
  5. Set the two variables the template already ships (both blank by default):
     `NVIDIA_VISIBLE_DEVICES` to your GPU UUID (or `all`), and
     `NVIDIA_DRIVER_CAPABILITIES` to `compute,utility`.
  6. **Apply**.

  Nothing else changes — no separate analyzer container, no compose overlay
  (that's the split stack's route). The analyze worker picks the device itself:
  it uses the GPU when it can see one and otherwise logs a warning and carries
  on with the CPU, so a half-finished setup degrades rather than breaking the
  station. Pin it explicitly with the `ANALYZE_DEVICE` variable (`auto`, the
  default, `cuda`, or `cpu`) if you'd rather be sure. Between passes the models
  drop out of VRAM after ~5 idle minutes, so a co-resident Ollama gets the card
  back (`ANALYZE_IDLE_UNLOAD_S` tunes that; `0` keeps them resident). The same
  release runs on CPU-only boxes, with a longer default window (30 minutes):
  the heavy models load once for a backfill or a sound search and would
  otherwise sit in RAM — and eventually swap — for the life of the container.
  The first heavy request after a release pays a cold reload from the on-disk
  cache (a few seconds for CLAP, longer for Demucs) — set
  `ANALYZE_IDLE_UNLOAD_S=0` if you'd rather keep them resident.

  Fair warning on size: the CUDA image is **~4 GB compressed** (~11 GB on disk)
  against `-heavy`'s ~1.3 GB, because the CUDA runtime ships inside the torch
  wheels. That's the whole install — you still don't need a CUDA toolkit on the
  host, just the driver plugin.

Both heavy images are **amd64-only** (~1.9 GB); on an arm64 box you'd also need
`DOCKER_DEFAULT_PLATFORM=linux/amd64` (emulated). The CUDA flavours are
amd64-only too, and there's no arm64/Jetson build.

> Verify with `docker ps --filter name=sub-wave-analyzer`. Full details, the
> `ANALYZE_AUDIO_EMBEDDING`/`ANALYZE_VOCAL_ACTIVITY` runtime flags, and
> troubleshooting are in [`tts-heavy.md`](tts-heavy.md).

**Expressive voices** — Chatterbox / PocketTTS — stay opt-in in the separate
**`tts-heavy`** sidecar. On Unraid you can't pass `--profile tts-heavy` to the
`up` Compose Manager runs for you, so activate the profile from the **.env**:

```ini
COMPOSE_PROFILES=tts-heavy
```

**Save**, then **Pull & Up**. `COMPOSE_PROFILES` is read by Docker Compose
directly, so the voices sidecar starts with no CLI flag — and survives reboots
as long as it stays in `.env`. The controller is already wired to it
(`TTS_HEAVY_URL`); nothing else is needed. First pull adds ~5–6 GB.

> The analyzer (and `tts-heavy`) want real CPU (or a GPU). Analysis on a
> low-power Unraid box works but is slow — a one-time per-track pass cached in
> `library.db`, so let it churn in the background.

---

## Don't lose your library on reboot: pin STATE_DIR

A reboot that comes back pointing at a *different* `state/` path looks exactly
like a wiped library: the controller finds no `library.db`, **silently creates a
fresh empty one**, and your tags and analysis appear gone (they're not — they're
still in the old path). The cause is almost always a `STATE_DIR` that wasn't
pinned to a persistent array path, so it landed somewhere ephemeral.

Avoid it by keeping `STATE_DIR` on an absolute appdata path — the same one every
boot:

```ini
STATE_DIR=/mnt/user/appdata/subwave/state
```

This is the appdata path from [step 2](#2-create-the-stack) above; everything —
settings, `library.db`, archives, voices — lives under it. Back that directory
up and your library survives reboots, host moves, and reinstalls. If both
`library.db` *and* `settings.json` are missing after a reboot, that confirms the
whole `state/` dir moved rather than the library being wiped.

> First-install note: a brand-new library shows a small **sample** in the
> Observatory so the page isn't empty. That sample is replaced the moment you
> run your first real scan — seeing it vanish is normal, not data loss.

---

## Putting it behind your own reverse proxy

Most Unraid boxes already run a reverse proxy — **Nginx Proxy Manager (NPM)**,
**SWAG**, **Traefik** or **Caddy** — for TLS and a tidy hostname. Putting
SUB/WAVE behind yours is the common path, and it's a *single upstream*, not a
pile of per-path rules. This applies to both options above.

### One upstream, not per-path rules

The one-click AIO image (and the Compose stack's bundled Caddy) already does all
the same-origin routing internally — `/` → web UI, `/api/*` → controller,
`/stream.mp3` → the Icecast stream — on the one host port. So your front proxy
points at a **single** target:

```
http://YOUR-UNRAID-IP:7700
```

No separate backends, no per-path forwarding. Map your hostname to that one
address and the bundled Caddy sorts out the rest.

### Set SITE_URL to the public https URL

Once a hostname fronts the box, set **`SITE_URL`** to the public `https://`
address — not the `IP:port`:

```ini
SITE_URL=https://radio.example.com
```

`SITE_URL` backs share cards and absolute links, so it has to be the address
listeners actually use. **TLS terminates at your proxy**; SUB/WAVE speaks plain
HTTP behind it (exactly as the bundled Caddy does behind Cloudflare in the
reference setup). One-click → edit the **SITE_URL** template field; Compose
stack → edit `.env` and **Pull & Up**.

### ⚠️ The one gotcha: don't buffer the audio stream

> ⚠️ **Turn response buffering OFF for `/stream*`.** The bundled Caddy serves
> the stream unbuffered (`flush_interval -1`). A front proxy that buffers — and
> **NPM buffers by default** — holds the live audio back, adding latency and
> stutter or stalling playback outright. Exempt the stream path; leave everything
> else on the proxy's normal settings.

**Nginx Proxy Manager** — open the proxy host → **Advanced** tab and add a
location block for the stream (the rest of the site keeps NPM's normal proxying
from the main tab):

```nginx
location ^~ /stream {
    proxy_pass http://YOUR-UNRAID-IP:7700;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;   # the stream never ends — don't time it out
}
```

The same one knob in the other proxies:

| Proxy | What to set on `/stream*` |
|---|---|
| **raw nginx** | `proxy_buffering off;` (+ a long `proxy_read_timeout`) in a `location ^~ /stream` block |
| **Caddy** | `reverse_proxy … { flush_interval -1 }` on the stream path |
| **Traefik** | nothing — Traefik doesn't buffer responses by default |

### Prefer to drop the bundled Caddy entirely?

If you'd rather your proxy talk to each service directly instead of through the
AIO's internal Caddy, run the split-container stack (Option 2) with
[`docker-compose.byo.yml`](https://raw.githubusercontent.com/perminder-klair/subwave/main/docker-compose.byo.yml).
There `web` / `controller` / `broadcast` bind host ports themselves
(`7700` / `7701` / `7702`) — but the web image is still baked for same-origin
`/api` + `/stream.mp3`, so **your proxy then has to replicate the route table**
(`/` → web, stripped `/api/*` plus `/listen.*` → controller, `/stream*` →
broadcast unbuffered, and `/api/listener-auth` blocked) on one hostname. Use the
complete [reverse-proxy recipes](reverse-proxy.md). That's more proxy config,
not less — only worth it if you specifically want the bundled Caddy out of the
path. For most people the single-upstream setup above is the easier win.

## Notes

- **No reverse proxy needed** for LAN use — Caddy fronts `/`, `/api`, and
  `/stream.mp3` on the single host port. Already run SWAG / NPM / Traefik and
  want TLS + a hostname? See [Putting it behind your own reverse
  proxy](#putting-it-behind-your-own-reverse-proxy) above — one upstream, plus
  the one stream-buffering gotcha.
- **Updates:** one-click → Unraid's normal **Check for Updates** / **Apply
  Update**. Compose stack → stack menu → **Pull & Up**. To pin or roll back to
  a specific release, point the container's **Repository** field at a tag
  (`ghcr.io/perminder-klair/subwave-aio:1.4.2`) instead of `:latest`.
- **Max concurrent listeners:** **admin → Settings → Danger zone → Max
  listeners**, then restart the container so Icecast re-renders its config.
  This used to be reachable only through `ICECAST_MAX_CLIENTS`, which the
  one-click template does not expose and the AIO image has no `.env` for —
  so on Unraid it was unsettable. It is a station setting now. (Adding
  `ICECAST_MAX_CLIENTS` as a custom container variable still overrides the
  field; the broadcast log names which source it used on every boot.)
- **Backups:** everything lives under the appdata path
  (`/mnt/user/appdata/subwave`) — settings, library cache, archives, voices.
  Back that path up (it's already on your pool/array).

See [`deployment.md`](deployment.md) for the full cross-platform deploy matrix
and [`../DEPLOY.md`](../DEPLOY.md) for Cloudflare, updates, and operations.
