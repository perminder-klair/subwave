#!/usr/bin/env bash
# SUB/WAVE health probe. Auto-detects which compose file is live and which
# host port Caddy is mapped to, then runs the canonical checks:
#   - container status
#   - /api/health
#   - /api/now-playing (proves the full pipeline, not just that a container is up)
#   - log scan for errors over the last 2 minutes
#
# Exits 0 if everything looks healthy, 1 otherwise.
# Designed to be readable to a human at a glance, not a strict CI gate.

set -u

# Resolve repo root from this script's location (works regardless of cwd).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO" || { echo "subwave repo not at $REPO"; exit 2; }

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

echo "=== containers ==="
docker compose -f "$COMPOSE" ps
echo

echo "=== $API_BASE/health ==="
HEALTH=$(curl -sf --max-time 5 "$API_BASE/health" 2>&1)
HEALTH_RC=$?
if [ $HEALTH_RC -eq 0 ]; then
  echo "$HEALTH"
else
  echo "FAILED (curl exit $HEALTH_RC)"
fi
echo

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

echo "=== errors in last 2m ==="
ANY_ERRS=0
SERVICES=$(docker compose -f "$COMPOSE" config --services 2>/dev/null)
for svc in $SERVICES; do
  errs=$(docker compose -f "$COMPOSE" logs --since 2m --tail 80 "$svc" 2>&1 \
         | grep -iE "error|fail|exception|fatal" \
         | grep -viE "no error|errors: 0|stderr|--with-stderr" \
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
if [ $HEALTH_RC -ne 0 ] || [ $NP_RC -ne 0 ] || [ $ANY_ERRS -ne 0 ]; then
  exit 1
fi
exit 0
