#!/usr/bin/env bash
# SUB/WAVE native installer — no Docker, no daemon.
#
# Lives alongside the Docker stack (see docker/). Re-runnable: every step is
# idempotent. Detects Debian/Ubuntu, Arch, Fedora, or macOS and:
#   1. installs distro packages (Icecast, Liquidsoap, Node, ffmpeg, …)
#   2. reuses scripts/setup.sh for state dirs, .env files, icecast.xml
#   3. fetches a static Piper binary + en_GB-alan-medium voice
#   4. builds a Kokoro venv + downloads ONNX model (Linux only)
#   5. installs controller deps + builds web (Next.js standalone output)
#   6. renders a native Caddyfile (loopback upstreams, :4800 listener)
#   7. envsubst-renders systemd unit templates → ~/.config/systemd/user/
#      (Linux), or launchd plists → ~/Library/LaunchAgents/ (macOS)
#
# Run once; then edit controller/.env and start the stack with:
#   systemctl --user enable --now subwave.target           # Linux
#   launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.subwave.*.plist  # macOS

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${STATE_DIR:-$REPO_DIR/state}"
SOUNDS_DIR="${SOUNDS_DIR:-$REPO_DIR/sounds}"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

SUDO=""
if [[ $EUID -ne 0 ]] && command -v sudo &>/dev/null; then SUDO=sudo; fi

# ---- 1. OS / package-manager detection --------------------------------------
OS="$(uname -s)"
ARCH="$(uname -m)"
PM=""

if [[ "$OS" == "Darwin" ]]; then
  command -v brew >/dev/null || die "Homebrew is required on macOS. Install: https://brew.sh"
  PM=brew
elif [[ "$OS" == "Linux" ]]; then
  if   command -v apt-get &>/dev/null; then PM=apt
  elif command -v dnf     &>/dev/null; then PM=dnf
  elif command -v pacman  &>/dev/null; then PM=pacman
  else die "Unsupported Linux distro — no apt/dnf/pacman found"
  fi
else
  die "Unsupported OS: $OS (Linux + macOS only)"
fi

say "Detected $OS / $PM / arch=$ARCH"

# ---- 2. Install distro packages ---------------------------------------------
# Each branch installs the same logical set: Node 22, Icecast, Liquidsoap, ffmpeg,
# Python (for Kokoro venv), espeak-ng (Piper/Kokoro phonemes), gettext (envsubst),
# Caddy. Caddy may not be in the default repo on Debian-derived distros — the
# branch below falls back to the official Caddy apt repo, but failure isn't
# fatal because Caddy is optional (only needed for the edge-proxy unit).
case "$PM" in
  apt)
    $SUDO apt-get update
    $SUDO apt-get install -y \
      nodejs npm icecast2 liquidsoap ffmpeg curl ca-certificates wget tar \
      python3 python3-venv espeak-ng libsndfile1 gettext-base
    # Caddy isn't in Debian/Ubuntu's default repo. Try the upstream apt repo;
    # if that fails, the installer will fall back to fetching the static binary.
    if ! command -v caddy &>/dev/null; then
      if $SUDO apt-get install -y debian-keyring debian-archive-keyring apt-transport-https \
        && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
             | $SUDO gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
        && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
             | $SUDO tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null \
        && $SUDO apt-get update \
        && $SUDO apt-get install -y caddy; then
        :
      else
        warn "Could not add Caddy apt repo — will fetch static binary if Caddy unit is enabled"
      fi
    fi
    # Debian's icecast2 package enables a system-wide service on port 7702.
    # Our user unit needs that port, so disable the system unit. Idempotent —
    # silent no-op if it's already off or never enabled.
    if systemctl is-enabled --quiet icecast2 2>/dev/null \
       || systemctl is-active --quiet icecast2 2>/dev/null; then
      warn "Disabling system-wide icecast2 service so the user unit owns port 7702"
      $SUDO systemctl disable --now icecast2 || true
    fi
    ICECAST_BIN=/usr/bin/icecast2
    ;;
  dnf)
    $SUDO dnf install -y \
      nodejs npm icecast liquidsoap ffmpeg python3 espeak-ng libsndfile gettext
    command -v caddy &>/dev/null || $SUDO dnf install -y caddy || \
      warn "Caddy not in default repo — will fetch static binary if Caddy unit is enabled"
    ICECAST_BIN=$(command -v icecast || echo /usr/bin/icecast)
    ;;
  pacman)
    $SUDO pacman -S --needed --noconfirm \
      nodejs npm icecast liquidsoap ffmpeg python espeak-ng libsndfile caddy gettext
    ICECAST_BIN=$(command -v icecast || echo /usr/bin/icecast)
    ;;
  brew)
    brew install node icecast liquidsoap ffmpeg espeak-ng caddy gettext
    # Apple Silicon brew lives under /opt/homebrew; Intel under /usr/local.
    BREW_PREFIX="$(brew --prefix)"
    ICECAST_BIN="$BREW_PREFIX/bin/icecast"
    ;;
esac

LIQUIDSOAP_BIN="$(command -v liquidsoap || true)"
NODE_BIN="$(command -v node || true)"
CADDY_BIN="$(command -v caddy || true)"
[[ -n "$LIQUIDSOAP_BIN" ]] || die "liquidsoap not found on PATH after install"
[[ -n "$NODE_BIN" ]]       || die "node not found on PATH after install"
[[ -x "$ICECAST_BIN" ]]    || warn "icecast binary not at $ICECAST_BIN — service may fail"

# Modern Node check. Controller targets Node 22; warn if older.
NODE_MAJOR="$($NODE_BIN -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  warn "Node $($NODE_BIN -v) is older than the controller's tested floor (v20)."
  warn "Consider NodeSource (https://github.com/nodesource/distributions) for Node 22."
fi

# ---- 3. State dirs, .env, icecast.xml ---------------------------------------
say "Running scripts/setup.sh (state dirs + passwords + icecast.xml)"
# setup.sh now prefers host ffmpeg over docker; see the ff() helper there.
STATE_DIR="$STATE_DIR" "$REPO_DIR/scripts/setup.sh"

# Logs directory — liquidsoap's settings.log.file.path is "$STATE_DIR/logs/radio.log".
mkdir -p "$STATE_DIR/logs"

# ---- 4. Piper ---------------------------------------------------------------
PIPER_DIR="$STATE_DIR/runtime/piper"
PIPER_VERSION="2023.11.14-2"
mkdir -p "$PIPER_DIR"

case "$OS:$ARCH" in
  Linux:x86_64)    PIPER_ASSET="piper_linux_x86_64.tar.gz" ;;
  Linux:aarch64)   PIPER_ASSET="piper_linux_aarch64.tar.gz" ;;
  Linux:armv7l)    PIPER_ASSET="piper_linux_armv7l.tar.gz" ;;
  Darwin:x86_64)   PIPER_ASSET="piper_macos_x64.tar.gz" ;;
  Darwin:arm64)    PIPER_ASSET="piper_macos_aarch64.tar.gz" ;;
  *) die "No Piper release for $OS:$ARCH — file an issue if you need one" ;;
esac

if [[ ! -x "$PIPER_DIR/piper" ]]; then
  say "Fetching Piper $PIPER_VERSION ($PIPER_ASSET)"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/$PIPER_ASSET" \
    "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/${PIPER_ASSET}"
  # The release tarball ships everything inside a top-level `piper/` dir.
  # --strip-components=1 flattens it so binary + libs sit directly in PIPER_DIR.
  tar -xzf "$tmp/$PIPER_ASSET" -C "$PIPER_DIR" --strip-components=1
  rm -rf "$tmp"
fi

if [[ ! -f "$PIPER_DIR/en_GB-alan-medium.onnx" ]]; then
  say "Fetching Piper voice en_GB-alan-medium"
  curl -fsSL -o "$PIPER_DIR/en_GB-alan-medium.onnx" \
    https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/en_GB-alan-medium.onnx
  curl -fsSL -o "$PIPER_DIR/en_GB-alan-medium.onnx.json" \
    https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/en_GB-alan-medium.onnx.json
fi

PIPER_BIN="$PIPER_DIR/piper"
PIPER_VOICE="$PIPER_DIR/en_GB-alan-medium.onnx"
PIPER_VOICE_CONFIG="$PIPER_DIR/en_GB-alan-medium.onnx.json"

# ---- 5. Kokoro (Linux only on first pass) -----------------------------------
KOKORO_DIR="$STATE_DIR/runtime/kokoro"
KOKORO_PYTHON="$KOKORO_DIR/venv/bin/python"
KOKORO_MODEL="$KOKORO_DIR/models/kokoro-v1.0.onnx"
KOKORO_VOICES="$KOKORO_DIR/models/voices-v1.0.bin"
KOKORO_WORKER="$REPO_DIR/controller/scripts/kokoro_worker.py"

if [[ "$OS" == "Linux" ]]; then
  if [[ ! -x "$KOKORO_PYTHON" ]]; then
    say "Building Kokoro venv at $KOKORO_DIR/venv"
    mkdir -p "$KOKORO_DIR/venv" "$KOKORO_DIR/models"
    python3 -m venv "$KOKORO_DIR/venv"
    "$KOKORO_DIR/venv/bin/pip" install --quiet --no-cache-dir --upgrade pip
    "$KOKORO_DIR/venv/bin/pip" install --quiet --no-cache-dir \
      kokoro-onnx==0.4.9 soundfile==0.12.1
  fi
  if [[ ! -f "$KOKORO_MODEL" ]]; then
    say "Fetching Kokoro model + voice bundle"
    curl -fsSL -o "$KOKORO_MODEL" \
      https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
    curl -fsSL -o "$KOKORO_VOICES" \
      https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
  fi
else
  # tts.js's isAvailable() short-circuits on a missing python binary, so a
  # non-existent path is a clean "not available" signal rather than a runtime
  # crash mid-line.
  say "Skipping Kokoro on macOS — Piper + cloud TTS cover every codepath"
  KOKORO_PYTHON="/nonexistent/kokoro-python"
fi

# ---- 6. Controller deps + web build -----------------------------------------
say "Installing controller deps (npm ci)"
( cd "$REPO_DIR/controller" && npm ci )
TSX_BIN="$REPO_DIR/controller/node_modules/.bin/tsx"
[[ -x "$TSX_BIN" ]] || die "tsx not found at $TSX_BIN after npm ci"

say "Building web (Next.js standalone output)"
( cd "$REPO_DIR/web" && npm ci && npm run build )

# Next standalone output bundles only the runtime files; static assets + public/
# are *not* traced in, so the Dockerfile copies them in next to server.js. Do
# the same here so the unit can launch from .next/standalone with no extra
# WorkingDirectory tricks.
STAND="$REPO_DIR/web/.next/standalone"
rm -rf "$STAND/.next/static" "$STAND/public"
cp -R "$REPO_DIR/web/.next/static" "$STAND/.next/static"
cp -R "$REPO_DIR/web/public"        "$STAND/public"

# ---- 7. Caddyfile (loopback upstreams, :4800) -------------------------------
mkdir -p "$STATE_DIR/caddy"
sed \
  -e 's|icecast:7702|127.0.0.1:7702|g' \
  -e 's|controller:7701|127.0.0.1:7701|g' \
  -e 's|web:7700|127.0.0.1:7700|g' \
  -e 's|^:80 {|:4800 {|' \
  "$REPO_DIR/docker/Caddyfile" > "$STATE_DIR/caddy/Caddyfile"

# ---- 8. Render unit files ---------------------------------------------------
# envsubst pulls these out of the env. Exporting `REPO` (not REPO_DIR) so the
# templates can use ${REPO} — matches the docs section in systemd/README.md.
export REPO="$REPO_DIR"
export STATE_DIR SOUNDS_DIR ICECAST_BIN LIQUIDSOAP_BIN NODE_BIN CADDY_BIN TSX_BIN \
       PIPER_BIN PIPER_VOICE PIPER_VOICE_CONFIG \
       KOKORO_PYTHON KOKORO_WORKER KOKORO_MODEL KOKORO_VOICES

if [[ "$OS" == "Linux" ]]; then
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  for f in "$REPO_DIR"/systemd/*.service "$REPO_DIR"/systemd/*.target; do
    [[ -e "$f" ]] || continue
    name="$(basename "$f")"
    envsubst < "$f" > "$UNIT_DIR/$name"
    chmod 644 "$UNIT_DIR/$name"
  done
  systemctl --user daemon-reload
  say "Installed systemd units into $UNIT_DIR"
elif [[ "$OS" == "Darwin" ]]; then
  AGENT_DIR="$HOME/Library/LaunchAgents"
  mkdir -p "$AGENT_DIR"

  # ICECAST_SOURCE_PASSWORD for the liquidsoap plist comes from docker/.env
  # (setup.sh keeps a single canonical copy there). launchd plists can't
  # EnvironmentFile= the way systemd can, so we inline it.
  if [[ -f "$REPO_DIR/docker/.env" ]]; then
    set -a; . "$REPO_DIR/docker/.env"; set +a
  fi
  export ICECAST_SOURCE_PASSWORD="${ICECAST_SOURCE_PASSWORD:-}"

  # Splice controller/.env into the controller plist as <key>/<string> pairs.
  # This block replaces the ${CONTROLLER_DOTENV_PLIST_DICT} placeholder.
  build_plist_dict() {
    local env_file="$1" k v line
    [[ -f "$env_file" ]] || return 0
    while IFS= read -r line || [[ -n "$line" ]]; do
      # Skip blanks + comment-only lines.
      [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
      # Split on first =.
      k="${line%%=*}"; v="${line#*=}"
      # Trim whitespace + surrounding quotes.
      k="$(printf '%s' "$k" | tr -d '[:space:]')"
      [[ -z "$k" ]] && continue
      v="${v#\"}"; v="${v%\"}"; v="${v#\'}"; v="${v%\'}"
      # XML-escape.
      v="${v//&/&amp;}"; v="${v//</&lt;}"; v="${v//>/&gt;}"
      printf '    <key>%s</key>\n    <string>%s</string>\n' "$k" "$v"
    done < "$env_file"
  }
  CONTROLLER_DOTENV_PLIST_DICT="$(build_plist_dict "$REPO_DIR/controller/.env" || true)"
  export CONTROLLER_DOTENV_PLIST_DICT

  for f in "$REPO_DIR"/launchd/com.subwave.*.plist; do
    [[ -e "$f" ]] || continue
    name="$(basename "$f")"
    envsubst < "$f" > "$AGENT_DIR/$name"
  done
  say "Installed LaunchAgent plists into $AGENT_DIR"
fi

# ---- 9. Done ---------------------------------------------------------------
cat <<EOF

Native install ready.
  STATE_DIR : $STATE_DIR
  Repo      : $REPO_DIR
  Piper     : $PIPER_BIN
EOF
if [[ "$OS" == "Linux" ]]; then
  echo "  Kokoro    : $KOKORO_PYTHON"
fi
cat <<EOF

Next steps:
  1. Edit controller/.env  (Navidrome creds, LLM keys, ADMIN_USER/ADMIN_PASS).
EOF

if [[ "$OS" == "Linux" ]]; then
cat <<'EOF'
  2. systemctl --user enable --now subwave.target
  3. systemctl --user status 'subwave-*'
  4. (optional) systemctl --user enable --now subwave-caddy.service   # :4800 edge proxy
  5. journalctl --user -u subwave-controller -f                       # tail controller logs

If you want services to start at boot without you logging in:
  loginctl enable-linger "$USER"
EOF
else
cat <<'EOF'
  2. Re-run this installer after editing controller/.env — launchd has no
     EnvironmentFile equivalent, so the installer inlines the .env into the
     controller plist.
  3. for s in icecast liquidsoap controller web; do
       launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.subwave.$s.plist
     done
  4. tail -f $STATE_DIR/logs/controller.err
EOF
fi
