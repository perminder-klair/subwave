#!/usr/bin/env bash
# Pull latest code, rebuild changed images, and recreate only services whose
# image or config actually changed. Run from anywhere; resolves to repo root.

set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
COMPOSE="docker compose -f ${COMPOSE_FILE}"

echo "→ Pulling latest from origin"
git pull --ff-only

echo "→ Pulling base images"
$COMPOSE pull --ignore-buildable

# Stamp the build with the real version (latest tag + commits since), so the
# admin console footer and controller report the deployed version instead of the
# package.json number — which only bumps on `main` and so trails `develop` by a
# release. Empty if git/tags are unavailable; the builds then fall back to
# package.json. Exported so compose's build.args interpolation picks it up.
export SUBWAVE_BUILD_VERSION="${SUBWAVE_BUILD_VERSION:-$(git describe --tags --always --dirty 2>/dev/null || true)}"
echo "→ Building local images (version: ${SUBWAVE_BUILD_VERSION:-package.json})"
$COMPOSE build --pull

echo "→ Recreating changed services"
$COMPOSE up -d --remove-orphans

echo "→ Pruning dangling images"
docker image prune -f >/dev/null

echo
echo "✓ Update complete"
$COMPOSE ps
