# Running SUB/WAVE on Unraid

SUB/WAVE is a multi-container Compose stack, so on Unraid it runs through the
**Compose Manager Plus** plugin rather than as individual Community Applications
templates. Start to on-air is about five minutes.

> Community Applications is a single-container catalogue — it can't one-click a
> Compose stack. Compose Manager Plus is the supported way to run one, and it
> uses the exact same `docker-compose.yml` as every other host, so you stay on
> the maintained file with nothing Unraid-specific to drift.

## Prerequisites

- Unraid 7.x with **Docker enabled** and the array (or a pool) started, so you
  have somewhere on disk for appdata.
- The **Community Applications** plugin (ships with Unraid).

## 1. Install Compose Manager Plus

**Apps** tab → search **Compose Manager Plus** (by `mstrhakr`) → **Install** the
stable release. It adds a **Compose** section to the **Docker** tab.

## 2. Create the stack

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
> `./state` would write SUB/WAVE's growing state — hourly archives, the library
> cache, rendered voices — onto the boot stick. Point it at your pool/array
> (`/mnt/user/appdata/subwave/state`) instead. Docker creates the folder on
> first start.

## 3. Pull and start

From the stack's action menu pick **Pull & Up** (not plain *Compose Up*).

> The compose file carries `build:` blocks so a source checkout can rebuild
> locally. The Unraid project directory has no source, so a plain *up* would try
> to build and fail. **Pull & Up** fetches the prebuilt images from GHCR first,
> then starts them — no build. (Alternatively, delete the `build:` blocks and a
> plain *up* works too.)

First pull is ~1–2 GB. When it finishes you'll have five running containers.
Flip the stack's **Autostart → ON** so it comes back after a reboot.

## 4. Finish setup

Open `http://YOUR-UNRAID-IP:7700/onboarding`, sign in with the `ADMIN_USER` /
`ADMIN_PASS` you set, and the wizard collects everything else — Navidrome, the
LLM provider, TTS, the DJ persona. The player is at `http://YOUR-UNRAID-IP:7700`.

## The AI DJ on Unraid: Ollama (local **or** cloud)

SUB/WAVE ships a first-class **"Ollama — local/cloud"** provider. Most Unraid
boxes don't have a big GPU, so the nicest path is Ollama's **cloud models**,
which offload inference — even a low-power box (e.g. an Intel N95) handles them
fine:

1. **Apps** tab → install the official **ollama** container (defaults are right:
   port `11434`, appdata `/mnt/user/appdata/ollama`, `OLLAMA_HOST=0.0.0.0:11434`).
2. Open the ollama container's **Console** and run `ollama signin`; approve the
   printed link in your browser (needs an Ollama account; `:cloud` models need a
   cloud subscription). Auth persists in the appdata volume.
3. In SUB/WAVE: **admin → Settings → LLM Provider** → provider
   **Ollama — local/cloud**, server URL `http://host.docker.internal:11434`,
   model a `:cloud` tag (e.g. `glm-5.2:cloud`) — or a small local tag like
   `llama3.2:3b` if you'd rather run on CPU. **Save LLM provider**.

`host.docker.internal` resolves from SUB/WAVE's containers to the Unraid host,
where the ollama container publishes `11434`.

## Notes

- **No reverse proxy needed** for LAN use — Caddy fronts `/`, `/api`, and
  `/stream.mp3` on the single `CADDY_PORT`. If you already run SWAG / NPM /
  Traefik and want TLS + a hostname, front `CADDY_PORT` with it, or switch to
  [`docker-compose.byo.yml`](https://raw.githubusercontent.com/perminder-klair/subwave/main/docker-compose.byo.yml).
- **Updates:** stack menu → **Pull & Up** (or **Check for Updates**).
- **Backups:** everything lives under `STATE_DIR`
  (`/mnt/user/appdata/subwave`) — settings, library cache, archives, voices.
  Back that path up (it's already on your pool/array).

See [`deployment.md`](deployment.md) for the full cross-platform deploy matrix
and [`../DEPLOY.md`](../DEPLOY.md) for Cloudflare, updates, and operations.
