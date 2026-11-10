#!/usr/bin/env bash
# Pull latest code, rebuild changed images, and recreate only services whose
# image or config actually changed. Run from anywhere; resolves to repo root.

set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${COMPOSE_FILE:-}" && -f .env ]]; then
  COMPOSE_FILE=$(grep -E "^COMPOSE_FILE=" .env | cut -d= -f2- | tail -n1)
fi
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
IFS=: read -r -a COMPOSE_FILES <<< "$COMPOSE_FILE"
COMPOSE_ARGS=()
for compose_file in "${COMPOSE_FILES[@]}"; do COMPOSE_ARGS+=(-f "$compose_file"); done
COMPOSE=(docker compose "${COMPOSE_ARGS[@]}")

# Guard against wrong-compose-file orphan wipes: `up -d --remove-orphans` removes
# any project container not defined in $COMPOSE_FILE, and all three compose files
# share one project name, so the wrong file would delete the other stack's
# services. Detect the file the running containers were launched from (the
# com.docker.compose.project.config_files label, same signal cli/src/compose.ts
# reads) and bail if it disagrees. Nothing running means nothing to protect.
SELECTED_ABS="$(cd "$(dirname "${COMPOSE_FILES[0]}")" && pwd)/$(basename "${COMPOSE_FILES[0]}")"
RUNNING_IDS="$("${COMPOSE[@]}" ps -q 2>/dev/null || true)"
if [ -n "$RUNNING_IDS" ]; then
  ACTIVE_CFG=""
  for id in $RUNNING_IDS; do
    # config_files can be a comma-separated list if the operator stacked -f
    # flags; the first entry is the primary file.
    ACTIVE_CFG="$(docker inspect \
      --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' \
      "$id" 2>/dev/null | cut -d, -f1)"
    [ -n "$ACTIVE_CFG" ] && break
  done
  if [ -n "$ACTIVE_CFG" ] && [ "$ACTIVE_CFG" != "$SELECTED_ABS" ]; then
    echo "✗ Running containers were launched from:" >&2
    echo "    $ACTIVE_CFG" >&2
    echo "  but this update targets:" >&2
    echo "    $SELECTED_ABS" >&2
    echo "  Running --remove-orphans against the wrong file would delete the" >&2
    echo "  other stack's services. Re-run with COMPOSE_FILE set to match, e.g.:" >&2
    echo "    COMPOSE_FILE=$(basename "$ACTIVE_CFG") $0" >&2
    exit 1
  fi
fi

echo "→ Pulling latest from origin"
git pull --ff-only

echo "→ Pulling base images"
"${COMPOSE[@]}" pull --ignore-buildable

# Stamp the build with the real version (latest tag + commits since), since
# package.json only bumps on `main` and trails `develop` by a release. Empty when
# git/tags are unavailable (builds fall back to package.json). Exported so
# compose's build.args interpolation picks it up.
export SUBWAVE_BUILD_VERSION="${SUBWAVE_BUILD_VERSION:-$(git describe --tags --always --dirty 2>/dev/null || true)}"
echo "→ Building local images (version: ${SUBWAVE_BUILD_VERSION:-package.json})"
"${COMPOSE[@]}" build --pull

echo "→ Recreating changed services"
"${COMPOSE[@]}" up -d --remove-orphans

echo "→ Pruning dangling images"
docker image prune -f >/dev/null

echo
echo "✓ Update complete"
"${COMPOSE[@]}" ps
