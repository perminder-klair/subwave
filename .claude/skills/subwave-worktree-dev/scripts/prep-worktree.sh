#!/usr/bin/env bash
# prep-worktree.sh — stage a SUB/WAVE git worktree so it can run the dev stack.
#
# A git worktree checks out every TRACKED file, but the dev stack also needs
# a handful of gitignored files that do NOT travel with the checkout:
#   - .env                       (root .env — the controller's ONLY env_file in dev compose:
#                                 ADMIN_*, SITE_URL, NAVIDROME_*, LLM/TTS keys)
#   - controller/.env            (LEGACY — no compose file reads it any more; its keys are
#                                 folded into the worktree's root .env where missing)
#   - web/.env.local             (dev API/stream URL overrides for the web UI; scaffolded
#                                 against $SUBWAVE_DEV_HOST, default localhost, if main has none)
#   - docker/.env                (compose variable substitution — legacy; harmless to copy if present)
#   - state/setup-config.json    (Navidrome creds the wizard saved; copying skips /onboarding)
#   - state/secrets.env          (cloud LLM/TTS API keys, if the main checkout has any)
#   - state/settings.json        (operator's LLM provider, personas, shows, TTS config)
#   - state/moods.json           (library mood tagging — produced by `npm run tag`, expensive to redo)
#   - state/sfx.json + sfx/      (sound-effects catalogue + rendered WAVs)
#   - state/jingles.json + .m3u + jingles/   (pre-rendered station idents)
#   - state/recent-plays.json    (24h play log — used by library-deep-cut + picker dedup)
#   - state/sessions/, voice/    (archived sessions + persona TTS reference voices)
#   - web/node_modules           (needed by `npm run dev`)
#   - state/                     (bind-mounted into the containers)
#
# This copies the env files from the main working tree, runs npm install, and
# mirrors the operator's DECLARATIVE state — settings, mood-tagging, sfx,
# jingles, sessions, voice — so the worktree boots into the same station the
# operator already configured on main, with the same LLM provider, personas,
# library moods, and rendered jingles. RUNTIME state (current session, queue,
# archived hourly streams, listener logs, container-generated secrets) is NOT
# copied — those would clash with whatever the worktree's containers produce
# fresh on first boot. The broadcast container generates its own
# state/icecast-secrets.env on first boot, so there's nothing to copy there.
#
# Usage:
#   prep-worktree.sh [worktree-path]   # worktree-path defaults to $PWD
#   prep-worktree.sh --reset-state     # wipe + re-scaffold state/ first
#   prep-worktree.sh --skip-npm        # skip the npm install step
#   SUBWAVE_DEV_HOST=100.x.y.z prep-worktree.sh   # host baked into a scaffolded web/.env.local
#                                                 # (e.g. a Tailscale IP for viewing from another device)

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
copy_env docker/.env

# Dev compose reads ONLY the root .env (`env_file: ./.env`) since the compose
# rename (8ec21021). A main checkout set up before that still keeps its
# Navidrome creds and API keys in controller/.env, which nothing reads — so a
# copied root .env boots a fresh station that can't reach Navidrome
# (needsSetup: true, "could not reach http://navidrome:4533"). Fold any key the
# legacy file has into the worktree's root .env, never overriding one it sets.
# ICECAST_* is skipped: the root .env also feeds compose substitution, so a
# folded password would override the one the broadcast container generates.
LEGACY_ENV="$MAIN/controller/.env"
ROOT_ENV="$WORKTREE/.env"
if [ -f "$LEGACY_ENV" ]; then
  touch "$ROOT_ENV"
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # Compare against the ORIGINAL root keys, not the growing destination.
  # Keep every eligible legacy assignment in order so Compose still resolves
  # duplicate keys and interpolation itself. Never source or re-quote values.
  merged="$(awk -f "$SCRIPT_DIR/merge-env.awk" "$ROOT_ENV" "$LEGACY_ENV")"
  if [ -n "$merged" ]; then
    printf '\n# Folded in from the main checkout'"'"'s legacy controller/.env by prep-worktree.sh\n%s\n' "$merged" >> "$ROOT_ENV"
    echo "[prep] folded legacy controller/.env into .env (root wins, ICECAST_* skipped)"
  else
    echo "[prep] keep   .env — already has every key from legacy controller/.env"
  fi
fi

if [ -e "$MAIN/web/.env.local" ]; then
  copy_env web/.env.local
elif [ -e "$WORKTREE/web/.env.local" ]; then
  echo "[prep] keep   web/.env.local — already in worktree (left untouched)"
else
  # Without it the web UI calls same-origin /api, which only the prod Caddy
  # edge serves — the dev player loads but never reaches the controller.
  DEV_HOST="${SUBWAVE_DEV_HOST:-localhost}"
  printf 'NEXT_PUBLIC_API_URL=http://%s:7701\nNEXT_PUBLIC_STREAM_URL=http://%s:7702/stream.mp3\n' \
    "$DEV_HOST" "$DEV_HOST" > "$WORKTREE/web/.env.local"
  echo "[prep] wrote  web/.env.local (host $DEV_HOST — set SUBWAVE_DEV_HOST to view from another device)"
fi

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

# Mirror the operator's declarative state from main so the worktree boots
# into the same configured station (LLM provider, personas, shows, moods,
# sfx, jingles, sessions) instead of an empty default install. The helper
# below handles both files and directories; runtime state (queue.json,
# session.json, archive/, logs/, listeners.jsonl, now-playing.json) is
# deliberately NOT mirrored — those would clash with what the worktree's
# own containers produce on first boot.
copy_state_file() {
  local rel="$1"
  local src="$MAIN/state/$rel"
  local dst="$STATE/$rel"
  if [ ! -e "$src" ]; then
    echo "[prep] skip   state/$rel — not present in main"
    return
  fi
  if [ -e "$dst" ]; then
    # The mkdir above scaffolds sfx/jingles/sessions/voice as empty dirs
    # before the copy step runs, so treating "already exists" as "keep
    # untouched" would lock in those empties. If the worktree's copy is an
    # empty directory but main's is populated, replace it; otherwise honour
    # the keep so operator edits aren't clobbered.
    if [ -d "$dst" ] && [ -d "$src" ] && [ -z "$(ls -A "$dst" 2>/dev/null)" ] && [ -n "$(ls -A "$src" 2>/dev/null)" ]; then
      rmdir "$dst"
    else
      echo "[prep] keep   state/$rel — already in worktree (left untouched)"
      return
    fi
  fi
  mkdir -p "$(dirname "$dst")"
  cp -R "$src" "$dst"
  # secrets.env is mode 0600 — preserve that. The Navidrome pass in
  # setup-config.json is plaintext but the file is normal 0644.
  if [ "$rel" = "secrets.env" ]; then chmod 0600 "$dst"; fi
  echo "[prep] copied state/$rel"
}

# Onboarding shortcut: skip the /onboarding flow per branch.
copy_state_file setup-config.json
copy_state_file secrets.env

# Operator-configured station: LLM provider, personas, shows, TTS config.
# Without this the controller boots with default settings (llm.model empty),
# every LLM call returns "fetch failed", and the new skills don't run.
copy_state_file settings.json

# Library mood tagging — expensive to regenerate (`npm run tag` walks the
# whole library through the LLM). Copy as-is so the picker has the same
# mood pool the operator already tagged on main.
copy_state_file moods.json

# Sound-effects + jingles catalogue and rendered WAVs. The .json files
# carry the metadata the admin UI lists; the directories carry the actual
# audio liquidsoap mixes in.
copy_state_file sfx.json
copy_state_file sfx
copy_state_file jingles.json
copy_state_file jingles.m3u
copy_state_file jingles

# 24h play log — the picker and the new library-deep-cut skill key off
# this for dedup. Without it the worktree behaves as if nothing has ever
# been played.
copy_state_file recent-plays.json

# Archived DJ sessions + Chatterbox reference voices.
copy_state_file sessions
copy_state_file voice

echo "[prep] state/ mirrored — operator's declarative settings/moods/sfx/jingles copied; runtime state (queue, current session, archive, logs) stays fresh."

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
