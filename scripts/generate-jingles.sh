#!/usr/bin/env bash
# Render station idents into ${STATE_DIR}/jingles via the controller's Piper.
# Liquidsoap's playlist reloads automatically (no restart needed) once the
# M3U is rewritten.
#
# Edit the JINGLES array below and re-run any time you want to refresh idents.

set -euo pipefail
cd "$(dirname "$0")/.."

# Pick up STATE_DIR from docker/.env (where setup.sh wrote it) so we don't
# have to remember to export it on every run.
[[ -z "${STATE_DIR:-}" && -f docker/.env ]] && \
  STATE_DIR=$(grep -E '^STATE_DIR=' docker/.env | cut -d= -f2-)
STATE_DIR="${STATE_DIR:-$(pwd)/state}"
COMPOSE_FILE="${COMPOSE_FILE:-docker/docker-compose.prod.yml}"
COMPOSE="docker compose -f ${COMPOSE_FILE}"

JINGLES=(
  "You're listening to Subwave. Personal frequency from the homelab."
  "Subwave radio. The signal continues."
  "This is Subwave. Late night sounds for the connected few."
  "You're tuned to Subwave. Single stream, one frequency."
  "Subwave — broadcasting on whatever wavelength reaches you."
)

JINGLE_DIR_HOST="${STATE_DIR}/jingles"
JINGLE_DIR_CTR="/var/sub-wave/jingles"
M3U_HOST="${STATE_DIR}/jingles.m3u"

mkdir -p "$JINGLE_DIR_HOST"

if ! $COMPOSE ps --status running --services 2>/dev/null | grep -q '^controller$'; then
  echo "Controller container is not running. Bring the stack up first:" >&2
  echo "  $COMPOSE up -d" >&2
  exit 1
fi

# Wipe stale renders so old jingles don't linger in the playlist
rm -f "$JINGLE_DIR_HOST"/jingle-*.wav

for i in "${!JINGLES[@]}"; do
  text="${JINGLES[$i]}"
  num=$(printf '%02d' "$i")
  out_ctr="${JINGLE_DIR_CTR}/jingle-${num}.wav"
  echo "→ jingle-${num}: ${text}"
  printf '%s' "$text" | $COMPOSE exec -T controller piper \
    --model /opt/piper/voices/en_GB-alan-medium.onnx \
    --config /opt/piper/voices/en_GB-alan-medium.onnx.json \
    --output_file "$out_ctr"
done

# Write the M3U using container-side paths — Liquidsoap and the controller
# both mount the state dir at /var/sub-wave, so these paths resolve in both.
{
  echo "#EXTM3U"
  for f in "$JINGLE_DIR_HOST"/jingle-*.wav; do
    echo "${JINGLE_DIR_CTR}/$(basename "$f")"
  done
} > "$M3U_HOST"

echo "✓ Rendered ${#JINGLES[@]} jingles to ${JINGLE_DIR_HOST}"
echo "✓ Wrote playlist ${M3U_HOST}"
