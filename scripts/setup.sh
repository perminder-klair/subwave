#!/usr/bin/env bash
# SUB/WAVE setup — idempotent, no sudo.
#
# What it does (re-running is safe; nothing is overwritten unless missing):
#   1. STATE_DIR defaults to <repo>/state — point it elsewhere if you like
#   2. Creates state subdirs (voice, archive, jingles, logs) world-writable
#      because Liquidsoap runs as uid 10000 and the controller runs as root
#   3. Generates docker/.env with random Icecast passwords if missing
#   4. Generates controller/.env from controller/.env.example if missing
#   5. Syncs ICECAST_SOURCE_PASSWORD between docker/.env and controller/.env
#   6. Renders state/icecast.xml from docker/icecast.xml.template using the
#      passwords above (mounted read-only by both compose files)
#   7. Renders 30 s of low pink noise as sounds/emergency.mp3 (last-resort
#      fallback) — ffmpeg is borrowed from the Liquidsoap image, no host
#      install required
#   8. Touches auto.m3u and jingles.m3u so Liquidsoap's reload_mode="watch"
#      has something to watch on first boot

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${STATE_DIR:-$REPO_DIR/state}"
# Static, version-controlled audio assets (emergency loop + studio bed). Unlike
# STATE_DIR these live in the repo and are bind-mounted read-only at /sounds.
SOUNDS_DIR="$REPO_DIR/sounds"
DOCKER_ENV="$REPO_DIR/docker/.env"
CONTROLLER_ENV="$REPO_DIR/controller/.env"
CONTROLLER_ENV_EXAMPLE="$REPO_DIR/controller/.env.example"
ICECAST_TEMPLATE="$REPO_DIR/docker/icecast.xml.template"
ICECAST_RENDERED="$STATE_DIR/icecast.xml"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }

# Render audio with the host's ffmpeg when present (native installs); fall back
# to running it inside the Liquidsoap image (the original Docker code path).
# Returns 127 when neither is available, which the callers treat as "skip and
# warn" — Liquidsoap will play silence on dead air without these files, which
# is recoverable.
#
# The Docker path mounts STATE_DIR at /out (chmod 777, so the image's
# liquidsoap UID can write) and SOUNDS_DIR at /sounds. The host path rewrites
# those container paths back to their real host equivalents so a single set of
# call sites covers both.
LIQUIDSOAP_IMAGE="savonet/liquidsoap:v2.2.5"
ff() {
  if command -v ffmpeg &>/dev/null; then
    local args=() a
    for a in "$@"; do
      case "$a" in
        /sounds/*) args+=("${SOUNDS_DIR}${a#/sounds}") ;;
        /out/*)    args+=("${STATE_DIR}${a#/out}") ;;
        *)         args+=("$a") ;;
      esac
    done
    ffmpeg "${args[@]}"
  elif command -v docker &>/dev/null; then
    docker run --rm --entrypoint ffmpeg \
      -v "$STATE_DIR":/out -v "$SOUNDS_DIR":/sounds "$LIQUIDSOAP_IMAGE" "$@"
  else
    return 127
  fi
}

# ---- 1. State dirs ----------------------------------------------------------
say "Using STATE_DIR=$STATE_DIR"
mkdir -p "$STATE_DIR"/{voice,archive,jingles,logs}
# 777 is intentional — containers run as different UIDs (root + uid 10000)
chmod 777 "$STATE_DIR" "$STATE_DIR"/{voice,archive,jingles,logs}
touch "$STATE_DIR/auto.m3u" "$STATE_DIR/jingles.m3u"

# ---- 2. docker/.env ---------------------------------------------------------
if [[ ! -f "$DOCKER_ENV" ]]; then
  say "Generating $DOCKER_ENV with random Icecast passwords"
  umask 077
  cat > "$DOCKER_ENV" <<EOF
ICECAST_SOURCE_PASSWORD=$(openssl rand -hex 16)
ICECAST_ADMIN_PASSWORD=$(openssl rand -hex 16)
ICECAST_RELAY_PASSWORD=$(openssl rand -hex 16)
STATE_DIR=$STATE_DIR
EOF
  umask 022
else
  say "$DOCKER_ENV exists — leaving it alone"
fi

# Pull values out for downstream steps. `set -a` exports anything we source.
set -a; . "$DOCKER_ENV"; set +a
: "${ICECAST_SOURCE_PASSWORD:?missing in $DOCKER_ENV}"
: "${ICECAST_ADMIN_PASSWORD:?missing in $DOCKER_ENV}"
: "${ICECAST_RELAY_PASSWORD:?missing in $DOCKER_ENV}"

# ---- 3. controller/.env -----------------------------------------------------
if [[ ! -f "$CONTROLLER_ENV" ]]; then
  if [[ -f "$CONTROLLER_ENV_EXAMPLE" ]]; then
    say "Seeding $CONTROLLER_ENV from .env.example (edit NAVIDROME_PASS!)"
    cp "$CONTROLLER_ENV_EXAMPLE" "$CONTROLLER_ENV"
    chmod 600 "$CONTROLLER_ENV"
  else
    warn "$CONTROLLER_ENV_EXAMPLE missing — skipping controller/.env"
  fi
fi

# Sync the source password so controller, Liquidsoap, and Icecast all agree.
if [[ -f "$CONTROLLER_ENV" ]]; then
  if grep -q '^ICECAST_SOURCE_PASSWORD=' "$CONTROLLER_ENV"; then
    # Use a sed delimiter that won't appear in a hex secret.
    sed -i.bak "s|^ICECAST_SOURCE_PASSWORD=.*|ICECAST_SOURCE_PASSWORD=$ICECAST_SOURCE_PASSWORD|" \
      "$CONTROLLER_ENV"
    rm -f "$CONTROLLER_ENV.bak"
  else
    printf '\nICECAST_SOURCE_PASSWORD=%s\n' "$ICECAST_SOURCE_PASSWORD" >> "$CONTROLLER_ENV"
  fi
fi

# ---- 4. Render icecast.xml --------------------------------------------------
if [[ ! -f "$ICECAST_TEMPLATE" ]]; then
  warn "Missing $ICECAST_TEMPLATE — cannot render Icecast config"
  exit 1
fi
say "Rendering $ICECAST_RENDERED"
if command -v envsubst &>/dev/null; then
  ICECAST_SOURCE_PASSWORD="$ICECAST_SOURCE_PASSWORD" \
  ICECAST_ADMIN_PASSWORD="$ICECAST_ADMIN_PASSWORD" \
  ICECAST_RELAY_PASSWORD="$ICECAST_RELAY_PASSWORD" \
    envsubst '${ICECAST_SOURCE_PASSWORD} ${ICECAST_ADMIN_PASSWORD} ${ICECAST_RELAY_PASSWORD}' \
    < "$ICECAST_TEMPLATE" > "$ICECAST_RENDERED"
else
  # envsubst lives in `gettext-base` on Debian; fall back to sed.
  sed \
    -e "s|\${ICECAST_SOURCE_PASSWORD}|$ICECAST_SOURCE_PASSWORD|g" \
    -e "s|\${ICECAST_ADMIN_PASSWORD}|$ICECAST_ADMIN_PASSWORD|g" \
    -e "s|\${ICECAST_RELAY_PASSWORD}|$ICECAST_RELAY_PASSWORD|g" \
    "$ICECAST_TEMPLATE" > "$ICECAST_RENDERED"
fi
chmod 644 "$ICECAST_RENDERED"

# ---- 5. Emergency audio -----------------------------------------------------
mkdir -p "$SOUNDS_DIR"
if [[ ! -f "$SOUNDS_DIR/emergency.mp3" ]]; then
  say "Generating emergency.mp3 (30 s of pink noise)"
  if ! ff -hide_banner -loglevel error \
       -f lavfi -i "anoisesrc=color=pink:duration=30:amplitude=0.05" \
       -codec:a libmp3lame -b:a 128k /sounds/emergency.mp3 -y; then
    warn "No ffmpeg or docker found — skipping emergency.mp3 (Liquidsoap plays silence on dead air)"
  fi
fi

# ---- 6. Studio bed ----------------------------------------------------------
# Continuous low-level ambient loop that Liquidsoap mixes under the broadcast.
# Masked by music, audible under ducked music when the DJ talks solo. Replace
# sounds/bed.mp3 with your own ambient loop any time.
if [[ ! -f "$SOUNDS_DIR/bed.mp3" ]]; then
  say "Generating bed.mp3 (60 s warm pink-noise studio bed)"
  if ! ff -hide_banner -loglevel error -y \
       -f lavfi -i "anoisesrc=color=pink:duration=60:amplitude=0.4" \
       -af "highpass=f=80,lowpass=f=700,volume=0.5" \
       -codec:a libmp3lame -b:a 128k /sounds/bed.mp3; then
    warn "No ffmpeg or docker found — skipping bed.mp3 (Liquidsoap runs without studio bed)"
  fi
fi

cat <<EOF

Setup complete.
  State dir : $STATE_DIR
  Docker env: $DOCKER_ENV
  Controller env: $CONTROLLER_ENV
  Icecast cfg: $ICECAST_RENDERED

Next steps:
  Dev:   cd docker && docker compose up -d
  Prod:  docker compose -f docker/docker-compose.prod.yml up -d
  Then : ./scripts/generate-jingles.sh
EOF
