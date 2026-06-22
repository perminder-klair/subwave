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
> `/mnt/user/appdata/subwave`, never `/boot/...`.

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

## Notes

- **No reverse proxy needed** for LAN use — Caddy fronts `/`, `/api`, and
  `/stream.mp3` on the single host port. If you already run SWAG / NPM /
  Traefik and want TLS + a hostname, front that port with it, or (Compose stack)
  switch to
  [`docker-compose.byo.yml`](https://raw.githubusercontent.com/perminder-klair/subwave/main/docker-compose.byo.yml).
- **Updates:** one-click → Unraid's normal **Check for Updates** / **Apply
  Update**. Compose stack → stack menu → **Pull & Up**.
- **Backups:** everything lives under the appdata path
  (`/mnt/user/appdata/subwave`) — settings, library cache, archives, voices.
  Back that path up (it's already on your pool/array).

See [`deployment.md`](deployment.md) for the full cross-platform deploy matrix
and [`../DEPLOY.md`](../DEPLOY.md) for Cloudflare, updates, and operations.
