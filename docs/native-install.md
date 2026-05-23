# SUB/WAVE Native Install (no Docker)

## Context

Today SUB/WAVE runs as five Docker containers (icecast, liquidsoap, controller, web, caddy). Operators who don't want a Docker daemon — or who want simpler upgrades, lower idle RAM, easier `journalctl`-based debugging, or a NAS/SBC that already runs other services — have no first-class path. Every component already has a native equivalent (icecast2 + liquidsoap from distro repos, Node 22 for controller + web, Piper as a static binary, Kokoro as a Python venv, Caddy as a static binary), so this is a packaging job, not a rewrite.

Goal: a parallel "native install" path that lives **alongside** the Docker stack — no change to `docker/`, no break for existing operators. Linux uses systemd units; macOS uses launchd plists. Operator runs one installer, edits one `.env`, then `systemctl --user start subwave.target` (or `launchctl load …`).

## Approach

Add three new things, change one existing file, leave Docker untouched.

1. **One small code change** so `radio.liq` honours `STATE_DIR` / `SOUNDS_DIR` instead of hardcoding `/var/sub-wave` and `/sounds`. Defaults stay at the current Docker paths, so existing containers see no behavioural change.
2. **A `scripts/install-native.sh`** that detects the OS (Debian/Ubuntu, Arch, Fedora, macOS), installs system packages, fetches Piper + Kokoro models, renders configs, and installs the unit files. Re-runnable.
3. **`systemd/` directory** with one unit per service plus an umbrella target, designed for `systemctl --user` (no root needed for the daily lifecycle).
4. **`launchd/` directory** with the macOS equivalent plists.

## File changes

### Edit (one file, one helper, ~6 lines)

- `liquidsoap/radio.liq` — add at the top:
  ```liquidsoap
  state_dir = environment.get(default="/var/sub-wave", "STATE_DIR")
  sounds_dir = environment.get(default="/sounds", "SOUNDS_DIR")
  ```
  Then string-interpolate `state_dir` / `sounds_dir` into every existing literal path (`#{state_dir}/next.txt`, `#{sounds_dir}/leadin.wav`, etc.). Docker users see identical behaviour because the defaults match the current bind-mount targets. Native users get correct paths from the systemd unit's `Environment=`.

### Create

- `scripts/install-native.sh` — idempotent installer with OS branching:
  - **apt** (Debian/Ubuntu): `nodejs npm icecast2 liquidsoap ffmpeg curl ca-certificates wget tar python3 python3-venv espeak-ng libsndfile1 gettext-base caddy`
  - **pacman** (Arch): `nodejs npm icecast liquidsoap ffmpeg python espeak-ng libsndfile caddy gettext`
  - **dnf** (Fedora): `nodejs npm icecast liquidsoap ffmpeg python3 espeak-ng libsndfile caddy gettext`
  - **brew** (macOS): `node icecast liquidsoap ffmpeg espeak-ng caddy gettext` (Kokoro skipped — see Risks)
  - Downloads Piper binary + `en_GB-alan-medium` voice into `$STATE_DIR/runtime/piper/` (host-arch aware: `x86_64`, `aarch64`, macOS asset via `uname -m`)
  - Builds Kokoro venv at `$STATE_DIR/runtime/kokoro/venv/` and downloads ONNX model + voices (Linux only on first pass)
  - Re-runs the existing `scripts/setup.sh` logic for state dirs, `.env` files, and `icecast.xml` rendering — but rewrites the ffmpeg helper to use **host** ffmpeg when docker isn't on PATH (the script already has the fallback condition, just needs the native command path filled in)
  - Builds `web/` via `npm ci && npm run build` so the standalone output exists
  - Installs unit files via `install -m 644` into `~/.config/systemd/user/` (Linux) or `~/Library/LaunchAgents/` (macOS), then `systemctl --user daemon-reload`

- `systemd/subwave.target` — wants/requires the four service units; one symbolic entry point.
- `systemd/subwave-icecast.service` — `ExecStart=/usr/bin/icecast2 -c $STATE_DIR/icecast.xml`, `Restart=on-failure`.
- `systemd/subwave-liquidsoap.service` — depends on icecast being up (`After=`/`Wants=`), runs `/usr/bin/liquidsoap $REPO/liquidsoap/radio.liq` with `Environment=STATE_DIR=…` and `SOUNDS_DIR=…`. Telnet stays bound to 127.0.0.1:1234.
- `systemd/subwave-controller.service` — `WorkingDirectory=$REPO/controller`, `EnvironmentFile=$REPO/controller/.env`, `ExecStart=/usr/bin/npx tsx src/server.ts` (matches the existing Dockerfile.controller entry). Sets `STATE_DIR`, `SOUNDS_DIR`, `PIPER_BIN`, `KOKORO_*` to point at the runtime tree created above.
- `systemd/subwave-web.service` — `WorkingDirectory=$REPO/web`, `ExecStart=/usr/bin/node .next/standalone/server.js`, port 7700.
- `systemd/subwave-caddy.service` — optional; only enabled if the operator wants the prod-style edge proxy on `:7700`. Same `Caddyfile` as `docker/Caddyfile`, with container hostnames swapped for `127.0.0.1`.
- `launchd/com.subwave.{icecast,liquidsoap,controller,web,caddy}.plist` — macOS analogues. `KeepAlive=true` for auto-restart, `RunAtLoad=true` for boot. Logs to `$STATE_DIR/logs/<service>.{out,err}`.
- `DEPLOY.md` — add a "Native install (no Docker)" section: `./scripts/install-native.sh`, edit `controller/.env`, `systemctl --user enable --now subwave.target`. Document the three day-to-day commands: `systemctl --user status subwave-*`, `journalctl --user -u subwave-controller -f`, `systemctl --user restart subwave-controller`.

### Reused, not rewritten

- `scripts/setup.sh` — `install-native.sh` sources or calls it for the state-dir + `.env` + `icecast.xml` work; only the ffmpeg helper inside it needs a host-native code path.
- `controller/src/config.ts:11-18` — already env-driven, no change.
- `docker/icecast.xml.template` — same template works natively.
- `docker/Caddyfile` — copied into install tree with `s/icecast:7702/127.0.0.1:7702/` etc.; routing logic is identical.

### Why not parameterise `radio.liq` more aggressively

The codebase already treats `STATE_DIR` and `SOUNDS_DIR` as the only two host-vs-container path knobs. Following the same convention in `radio.liq` keeps it consistent and avoids inventing new env vars. Anything beyond those two (queue file names, jingle ratio file path, etc.) is internal layout — both sides agree on it, so it doesn't need a knob.

## Risks / open items

- **Kokoro on macOS**: `kokoro-onnx` on Apple Silicon historically has fiddly ONNX runtime / wheel issues. First pass: Linux only. Mac operators get Piper + cloud TTS, which covers every codepath. Revisit if anyone asks.
- **Piper architecture**: x86_64 only in the Docker image. Pi 4/5 operators (aarch64) get the `linux_aarch64` Piper release — `install-native.sh` picks via `uname -m`.
- **Icecast packaging conflict**: Debian's `icecast2` ships a default `/etc/icecast2/icecast.xml` and enables a system service on install. Installer must `systemctl disable --now icecast2` (system unit) so our user-mode unit owns port 7702. Worth a clear warning before the disable.
- **Port 80 / 443**: rootless `systemctl --user` can't bind `<1024`. Caddy unit defaults to `:7700` (matches current Docker setup); operators wanting `:80` need `setcap` on the Caddy binary or a system-mode unit. Document both.
- **State dir permissions**: no more cross-UID problem (everything runs as the operator), so the `chmod 777` in `setup.sh` becomes unnecessary natively. Leave it alone — harmless and keeps `setup.sh` reusable.

## Verification

1. **Smoke test on Debian 12 VM** (closest to the prod target):
   - Fresh checkout, `./scripts/install-native.sh`, edit `controller/.env` with Navidrome creds + an LLM key.
   - `systemctl --user enable --now subwave.target`
   - `systemctl --user status subwave-*` — all four (or five with caddy) should be `active (running)`.
   - `curl -fsS http://127.0.0.1:7701/health` returns 200.
   - `curl -fsS -I http://127.0.0.1:7702/stream.mp3` returns `200 OK` with `Content-Type: audio/mpeg`.
   - Open `http://127.0.0.1:7700`, hit play, confirm audio.
2. **Regression test on macOS**: same flow with `launchctl load` instead. Skip Kokoro; verify Piper voice plays.
3. **Docker regression**: bring up `docker compose -f docker/docker-compose.yml up -d` after the `radio.liq` change. Confirm `now-playing.json` still updates on each track and that voice ducking still fires. Proves the `radio.liq` env defaults didn't break the container path — this is the only existing-user-impacting change in the whole plan.
4. **`/var/sub-wave` residual check**: grep the running tree for any residual `/var/sub-wave` string lookups outside the documented two — should be zero.
