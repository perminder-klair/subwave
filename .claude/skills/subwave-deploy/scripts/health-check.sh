#!/usr/bin/env bash
# SUB/WAVE health probe. Auto-detects which compose file is live and which
# host port Caddy is mapped to, then runs the canonical checks:
#   - container status
#   - /api/health
#   - /api/now-playing (proves the full pipeline, not just that a container is up)
#   - /stream.mp3 audio level (proves the stream carries SOUND, not silence)
#   - log scan for errors over the last 2 minutes
#
# Why the audio level check: /api/health returns "on-air" and bytes keep
# flowing down /stream.mp3 even when Liquidsoap has a wedged source feeding
# the Icecast mount digital silence. "on-air" + byte flow is NOT proof of a
# working stream — only a non-silent audio level is. This is the failure
# mode a near-simultaneous controller+broadcast recreate can leave behind.
#
# Exits 0 if everything looks healthy, 1 otherwise.
# Designed to be readable to a human at a glance, not a strict CI gate.

set -u

# Resolve the repo root from this script's own location — it lives at
# <repo>/.claude/skills/subwave-deploy/scripts/health-check.sh.
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || (cd "$SCRIPT_DIR/../../../.." && pwd))
cd "$REPO" || { echo "subwave repo not found at $REPO"; exit 2; }

# --- pick the live compose file ---------------------------------------------
PROD="docker-compose.yml"
BYO="docker-compose.byo.yml"
DEV="docker-compose.dev.yml"
COMPOSE=""
for f in "$PROD" "$BYO" "$DEV"; do
  if [ -n "$(docker compose -f "$f" ps -q 2>/dev/null)" ]; then
    COMPOSE="$f"
    break
  fi
done

if [ -z "$COMPOSE" ]; then
  echo "No SUB/WAVE containers are running (checked $PROD, $BYO, and $DEV)."
  exit 1
fi

echo "Compose file: $COMPOSE"

# --- find the edge port -----------------------------------------------------
# In prod, Caddy fronts everything. In dev, no Caddy — fall back to controller.
EDGE=""
if docker compose -f "$COMPOSE" ps caddy 2>/dev/null | grep -q "Up"; then
  CADDY_PORT=$(docker compose -f "$COMPOSE" port caddy 80 2>/dev/null | awk -F: '{print $NF}' | tr -d '[:space:]')
  if [ -n "$CADDY_PORT" ]; then
    EDGE="http://localhost:$CADDY_PORT"
    API_BASE="$EDGE/api"
  fi
fi
if [ -z "$EDGE" ]; then
  # Dev: hit the controller container directly via its mapped port if any,
  # otherwise via `docker exec`. Simpler path: ask docker for the port.
  CTRL_PORT=$(docker compose -f "$COMPOSE" port controller 7701 2>/dev/null | awk -F: '{print $NF}' | tr -d '[:space:]')
  if [ -n "$CTRL_PORT" ]; then
    EDGE="http://localhost:$CTRL_PORT"
    API_BASE="$EDGE"            # no /api prefix when hitting controller directly
  else
    echo "Could not find an exposed edge port (neither caddy:80 nor controller:7701 mapped)."
    echo "You can still inspect via: docker compose -f $COMPOSE exec controller curl -s localhost:7701/health"
    exit 1
  fi
fi

echo "Edge:         $EDGE"
echo "API base:     $API_BASE"
echo

# --- containers -------------------------------------------------------------
echo "=== containers ==="
docker compose -f "$COMPOSE" ps
echo

# --- health -----------------------------------------------------------------
echo "=== $API_BASE/health ==="
HEALTH=$(curl -sf --max-time 5 "$API_BASE/health" 2>&1)
HEALTH_RC=$?
if [ $HEALTH_RC -eq 0 ]; then
  echo "$HEALTH"
else
  echo "FAILED (curl exit $HEALTH_RC)"
fi
echo

# --- now-playing ------------------------------------------------------------
echo "=== $API_BASE/now-playing ==="
NP=$(curl -sf --max-time 5 "$API_BASE/now-playing" 2>&1)
NP_RC=$?
if [ $NP_RC -eq 0 ]; then
  if command -v jq >/dev/null 2>&1; then
    echo "$NP" | jq -r '
      "track:   \(.nowPlaying.artist // "?") — \(.nowPlaying.title // "?")",
      "dj:      \(.dj.name // "?")",
      "mood:    \(.context.dominantMood // "?")",
      "weather: \(.context.weather.condition // "?") \(.context.weather.temp // "?")°C @ \(.context.weather.location // "?")"
    ' 2>/dev/null || echo "$NP"
  else
    echo "$NP"
  fi
else
  echo "FAILED (curl exit $NP_RC)"
fi
echo

# --- audio level (stream carries sound, not silence) ------------------------
# "on-air" + byte flow is not proof. A wedged Liquidsoap source feeds the
# Icecast mount digital silence (~-91 dB) while every other check stays green.
# Capture a few seconds and measure the mean volume with ffmpeg.
echo "=== $EDGE/stream.mp3 audio level ==="
SILENT=0
if command -v ffmpeg >/dev/null 2>&1; then
  TMP_MP3=$(mktemp /tmp/sw-healthcheck-XXXXXX.mp3)
  curl -s --max-time 14 "$EDGE/stream.mp3" -o "$TMP_MP3" 2>/dev/null
  BYTES=$(wc -c < "$TMP_MP3" 2>/dev/null | tr -d '[:space:]')
  if [ "${BYTES:-0}" -lt 20000 ]; then
    echo "FAILED — only ${BYTES:-0} bytes captured (stream not delivering audio)"
    SILENT=1
  else
    MEAN=$(ffmpeg -hide_banner -i "$TMP_MP3" -af volumedetect -f null /dev/null 2>&1 \
           | grep -oE 'mean_volume: -?[0-9.]+ dB' | grep -oE -- '-?[0-9.]+' | head -1)
    if [ -z "$MEAN" ]; then
      echo "could not measure (ffmpeg produced no mean_volume) — inspect manually"
    else
      # -50 dB threshold: real broadcast audio sits around -8 to -16 dB;
      # a wedged/silent stream reads ~-91 dB. Anything below -50 is silence.
      BELOW=$(awk -v m="$MEAN" 'BEGIN { print (m < -50) ? 1 : 0 }')
      if [ "$BELOW" = "1" ]; then
        echo "SILENT — mean_volume ${MEAN} dB (stream is on-air but carrying no sound)"
        echo "  → Liquidsoap likely has a wedged source. Fix: docker compose -f $COMPOSE restart"
        SILENT=1
      else
        echo "ok — mean_volume ${MEAN} dB"
      fi
    fi
  fi
  rm -f "$TMP_MP3"
else
  echo "skipped — ffmpeg not on PATH (cannot verify the stream carries sound)"
fi
echo

# --- recent errors ----------------------------------------------------------
# Note: the audio probe above disconnects mid-stream, which makes Caddy log a
# benign "aborting with incomplete response / context canceled" for
# /stream.mp3. That (and any normal stream-client disconnect) is filtered out
# below so it doesn't read as a deploy failure.
#
# Also filtered: Liquidsoap's playlist-parser probing. On startup (and on the
# first track resolve) it tries every registered parser in order — the XML and
# SCPLS parsers reject non-matching content by raising, and Liquidsoap 2.4.x
# prints those internal exceptions to stderr as "Error -1: Exception raised:
# xml error: expected root element" / "...: Not_found" with backtraces. They
# land exactly in the post-restart window this scan covers. Benign; the M3U
# parser wins right after. Keep the patterns anchored to "Exception raised:"
# so a real error elsewhere still trips the scan.
#
# Also filtered: the controller's raw LLM debug capture (settings
# llm.debugRawRequests or LLM_DEBUG_RAW). When on, every outbound model
# request body is mirrored to stderr — a "[llm-debug-raw]" header line plus
# one huge single-line JSON body starting {"model": — and prompt text inside
# routinely contains words like "fail"/"error". Diagnostic mirroring, not a
# fault; without this filter the scan false-fails whenever the toggle is on.
echo "=== errors in last 2m ==="
ANY_ERRS=0
SERVICES=$(docker compose -f "$COMPOSE" config --services 2>/dev/null)
for svc in $SERVICES; do
  errs=$(docker compose -f "$COMPOSE" logs --since 2m --tail 80 "$svc" 2>&1 \
         | grep -iE "error|fail|exception|fatal" \
         | grep -viE "no error|errors: 0|stderr|--with-stderr" \
         | grep -viE "aborting with incomplete response|context canceled|reading: context" \
         | grep -vE "Exception raised: xml error: expected root element|Exception raised: Not_found" \
         | grep -vE '\[llm-debug-raw\]|\| \{"model":' \
         | head -3)
  if [ -n "$errs" ]; then
    echo "--- $svc ---"
    echo "$errs"
    ANY_ERRS=1
  fi
done
if [ $ANY_ERRS -eq 0 ]; then
  echo "(none)"
fi

echo
# --- exit code summary ------------------------------------------------------
if [ $HEALTH_RC -ne 0 ] || [ $NP_RC -ne 0 ] || [ $ANY_ERRS -ne 0 ] || [ $SILENT -ne 0 ]; then
  exit 1
fi
exit 0
