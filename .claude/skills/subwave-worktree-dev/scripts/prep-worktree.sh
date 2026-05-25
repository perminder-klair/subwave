#!/usr/bin/env bash
# prep-worktree.sh — stage a SUB/WAVE git worktree so it can run the dev stack.
#
# A git worktree checks out every TRACKED file, but the dev stack also needs
# a handful of gitignored files that do NOT travel with the checkout:
#   - .env                       (root .env — ADMIN_USER/PASS/SITE_URL; dev compose references it as ./.env)
#   - controller/.env            (Navidrome + Ollama config; dev compose env_file)
#   - web/.env.local             (dev API/stream URL overrides for the web UI)
#   - docker/.env                (compose variable substitution — legacy; harmless to copy if present)
#   - state/setup-config.json    (Navidrome creds the wizard saved; copying skips /onboarding)
#   - state/secrets.env          (cloud LLM/TTS API keys, if the main checkout has any)
#   - web/node_modules           (needed by `npm run dev`)
#   - state/                     (bind-mounted into the containers)
#
# This copies the env files from the main working tree, runs npm install, and
# scaffolds a FRESH state/ directory — structure plus the two onboarding-skip
# files (setup-config.json + secrets.env, if they exist on main). It does NOT
# copy settings.json, session.json, queue.json, moods.json, or any archived
# sessions/jingles/voice files, so the worktree station boots clean and the
# controller writes its own defaults — but the operator lands directly on the
# player instead of /onboarding. The broadcast container generates its own
# state/icecast-secrets.env on first boot, so there's nothing to copy.
#
# Usage:
#   prep-worktree.sh [worktree-path]   # worktree-path defaults to $PWD
#   prep-worktree.sh --reset-state     # wipe + re-scaffold state/ first
#   prep-worktree.sh --skip-npm        # skip the npm install step

set -euo pipefail

WORKTREE=""
RESET_STATE=0
SKIP_NPM=0
for arg in "$@"; do
  case "$arg" in
    --reset-state) RESET_STATE=1 ;;
    --skip-npm)    SKIP_NPM=1 ;;
    -h|--help)     grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)            echo "unknown flag: $arg" >&2; exit 2 ;;
    *)             WORKTREE="$arg" ;;
  esac
done

WORKTREE="${WORKTREE:-$PWD}"
[ -d "$WORKTREE" ] || { echo "error: no such directory: $WORKTREE" >&2; exit 1; }
WORKTREE="$(cd "$WORKTREE" && pwd)"

# The main working tree is the parent of the shared (common) .git directory.
# For a linked worktree, --git-common-dir points back at the main repo's .git.
GIT_COMMON="$(git -C "$WORKTREE" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || {
  echo "error: $WORKTREE is not inside a git repository" >&2; exit 1; }
MAIN="$(cd "$(dirname "$GIT_COMMON")" && pwd)"

if [ "$MAIN" = "$WORKTREE" ]; then
  echo "error: $WORKTREE IS the main working tree — there is nothing to prep." >&2
  echo "       Use the subwave-control skill to start the stack directly." >&2
  exit 1
fi

echo "[prep] main working tree: $MAIN"
echo "[prep] target worktree:   $WORKTREE"

# ── env files ───────────────────────────────────────────────────────────────
copy_env() {
  local rel="$1"
  local src="$MAIN/$rel"
  local dst="$WORKTREE/$rel"
  if [ ! -e "$src" ]; then
    echo "[prep] skip   $rel — not present in main; the stack may not work without it"
    return
  fi
  if [ -e "$dst" ]; then
    echo "[prep] keep   $rel — already in worktree (left untouched)"
    return
  fi
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  echo "[prep] copied $rel"
}

copy_env .env
copy_env controller/.env
copy_env web/.env.local
copy_env docker/.env

# ── fresh state/ scaffold ───────────────────────────────────────────────────
STATE="$WORKTREE/state"
if [ "$RESET_STATE" = 1 ] && [ -d "$STATE" ]; then
  echo "[prep] --reset-state: removing $STATE"
  rm -rf "$STATE"
fi

mkdir -p "$STATE"/logs "$STATE"/voice "$STATE"/jingles "$STATE"/sessions "$STATE"/archive "$STATE"/sfx

# Liquidsoap inside the container runs as a non-host uid and writes
# state/logs/radio.log on boot. A fresh mkdir gives 755, which makes that write
# fail with EACCES and crash-loops the container. Widen the tree so every
# container uid can read+write. (The main checkout ends up 777 the same way
# after its first container run; this just front-loads it.)
#
# `|| true` because re-running prep against an established worktree hits files
# the container created as root — those are already 0666/0777 from the container's
# umask, so the chmod is a no-op but bash still errors on the EPERM. Don't bail
# the whole prep over cosmetic permission warnings on a re-run.
chmod -R a+rwX "$STATE" 2>/dev/null || true

# icecast-secrets.env — the broadcast container generates this on first boot
# if it doesn't exist (mode 0644 so liquidsoap inside the same container can
# source it), so worktrees don't need to copy anything. The file is just
# three ICECAST_*_PASSWORD lines; a fresh worktree gets fresh passwords on
# first `docker compose up -d`. Nothing to scaffold here.

# Liquidsoap starts BEFORE the controller, so these must exist at boot or
# radio.liq errors on the missing read. The controller would otherwise write
# them on startup (see controller/src/settings.ts). Values are the code
# defaults: jingleRatio 30, crossfadeDuration 10.0.
[ -f "$STATE/liquidsoap_jingle_ratio.txt" ] || { echo 30   > "$STATE/liquidsoap_jingle_ratio.txt"; echo "[prep] wrote state/liquidsoap_jingle_ratio.txt (30)"; }
[ -f "$STATE/liquidsoap_crossfade.txt" ]    || { echo 10.0 > "$STATE/liquidsoap_crossfade.txt";    echo "[prep] wrote state/liquidsoap_crossfade.txt (10.0)"; }

# Playlists liquidsoap watches with reload_mode="watch" — must exist as files.
[ -f "$STATE/auto.m3u" ]    || { : > "$STATE/auto.m3u";    echo "[prep] touched state/auto.m3u (empty — controller refills it)"; }
[ -f "$STATE/jingles.m3u" ] || { : > "$STATE/jingles.m3u"; echo "[prep] touched state/jingles.m3u (empty — run generate-jingles.sh later if wanted)"; }

# setup-config.json carries the Navidrome creds the first-run wizard saved.
# Without it, controller/src/setup/firstRun.ts reports needsSetup=true and the
# player redirects to /onboarding on every page load. Copy it from main so the
# worktree boots straight into the player — the operator already onboarded
# once in the main checkout, no need to do it again per branch. secrets.env
# is the matching file for cloud LLM/TTS API keys; copy it too if present.
copy_state_file() {
  local rel="$1"
  local src="$MAIN/state/$rel"
  local dst="$STATE/$rel"
  if [ ! -e "$src" ]; then
    echo "[prep] skip   state/$rel — not present in main"
    return
  fi
  if [ -e "$dst" ]; then
    echo "[prep] keep   state/$rel — already in worktree (left untouched)"
    return
  fi
  cp "$src" "$dst"
  # secrets.env is mode 0600 — preserve that. The Navidrome pass in
  # setup-config.json is plaintext but the file is normal 0644.
  if [ "$rel" = "secrets.env" ]; then chmod 0600 "$dst"; fi
  echo "[prep] copied state/$rel"
}

copy_state_file setup-config.json
copy_state_file secrets.env

echo "[prep] state/ scaffolded — no settings/sessions/queue/moods copied; the controller writes defaults on first boot."

# ── web dependencies ────────────────────────────────────────────────────────
if [ "$SKIP_NPM" = 1 ]; then
  echo "[prep] --skip-npm: leaving web/node_modules as-is"
elif [ -d "$WORKTREE/web/node_modules" ]; then
  echo "[prep] web/node_modules already present — skipping npm install"
else
  echo "[prep] installing web dependencies (npm install — can take a few minutes)…"
  ( cd "$WORKTREE/web" && npm install )
  echo "[prep] web dependencies installed"
fi

cat <<EOM

[prep] done. Start the dev stack from the worktree:
  cd "$WORKTREE" && docker compose -f docker-compose.dev.yml up -d --build   # --build bakes worktree controller changes into the image
  cd "$WORKTREE/web" && npm run dev                                           # web hot-reloads — run this in the background

Verify on-air (give Liquidsoap ~5s to connect):
  curl -sf http://localhost:7701/health    # expect {"status":"on-air"}
  curl -sf -o /dev/null -w '%{http_code}\\n' http://localhost:7700   # expect 200
EOM
