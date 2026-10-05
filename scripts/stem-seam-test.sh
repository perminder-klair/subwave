#!/usr/bin/env bash
# Offline P -> X -> rendered clip -> Y validation using production annotations,
# cue_cut, the full dj_transition and the cross wiring lifted from radio.liq.
# Checks station crossfades 0, 0.1 and the default. Controller cues must pass
# every case; verbatim worker cues are the known-bad comparison.
#
# Requires #1774's mixer buffer fix for short station crossfades. To validate
# both PRs without merging commits, set STEM_SEAM_RADIO_REF to the pinned
# #1774 commit available in this repository. Otherwise tests this checkout's
# mixer and correctly fails on a checkout missing the required fix.
#
# Needs controller/node_modules (npm ci), Python with numpy + soundfile
# (or ANALYZER_IMAGE), and savonet/liquidsoap:v2.4.5 (or LIQ_BIN).
# Output: scripts/.fx-render/stemseam/ or STEM_SEAM_WORK.
# Residual: frame-boundary cross buffering can leave up to one 20ms frame
# of beat error. SEAM_TOLERANCE_MS defaults to 25ms.
set -euo pipefail

IMAGE="${LIQ_IMAGE:-savonet/liquidsoap:v2.4.5}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
WORK="${STEM_SEAM_WORK:-$HERE/.fx-render/stemseam}"
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"
TSX="$ROOT/controller/node_modules/.bin/tsx"
[ -x "$TSX" ] || { echo "need controller dependencies (npm ci in controller/)" >&2; exit 1; }

liq() {
  if [ -n "${LIQ_BIN:-}" ]; then
    W="$WORK" "$LIQ_BIN" "$WORK/$1" 2>&1
  else
    docker run --rm --network none --user "$(id -u):$(id -g)" -v "$WORK":/work \
      -e W=/work "$IMAGE" "/work/$1" 2>&1
  fi
}

py() {
  if [ -z "${ANALYZER_IMAGE:-}" ] && python3 -c 'import numpy, soundfile' 2>/dev/null; then
    local args=() a
    for a in "$@"; do a="${a//\/work/$WORK}"; args+=("${a//\/repo/$ROOT}"); done
    python3 "$HERE/stem-seam-test.py" "${args[@]}"
  elif [ -n "${ANALYZER_IMAGE:-}" ]; then
    docker run --rm --network none --user "$(id -u):$(id -g)" -v "$WORK":/work -v "$ROOT":/repo:ro \
      --entrypoint python3 "$ANALYZER_IMAGE" /repo/scripts/stem-seam-test.py "$@"
  else
    echo "need Python numpy + soundfile, or ANALYZER_IMAGE=<analyzer image>" >&2
    return 1
  fi
}

if [ -n "${STEM_SEAM_RADIO_REF:-}" ]; then
  radio_commit=$(git -C "$ROOT" rev-parse --verify "$STEM_SEAM_RADIO_REF^{commit}")
  git -C "$ROOT" show "$radio_commit:liquidsoap/radio.liq" > "$WORK/radio-source.liq"
  echo "Mixer source: $radio_commit (combined validation; no commits merged)"
else
  cp "$ROOT/liquidsoap/radio.liq" "$WORK/radio-source.liq"
  echo "Mixer source: this checkout ($ROOT/liquidsoap/radio.liq)"
fi
default_cross=$(py mixer /work/radio-source.liq /work)
echo "== preparing tracks + real analyze_worker.render_transition clip"
plan=$(py prepare /work /repo)
echo "   worker: $plan"
read -r blend in_cue clip_sec < <(python3 -c 'import json,sys; p=json.loads(sys.argv[1]); print(p["blend_start_sec"], p["in_cue_sec"], p["clip_sec"])' "$plan")

verdict=0
for station in 0 0.1 "$default_cross"; do
  for mode in verbatim controller; do
    name="$mode-$station"
    echo "== $name: production station crossfade ${station}s"
    STATE_DIR="$WORK/controller-state" MUSIC_LIBRARY_PATH="$WORK" \
      "$TSX" "$ROOT/controller/scripts/stem-seam-fixture.ts" "$mode" "$station" "$blend" "$in_cue" > "$WORK/fixture-$name.json"
    py render-script /work "$name" "$station" "/work/fixture-$name.json"
    rm -f "$WORK/seam-$name.wav"
    if ! liq "seam-$name.liq" > "$WORK/seam-$name.log"; then
      tail -20 "$WORK/seam-$name.log"
      echo "STEMSEAM FAIL: Liquidsoap failed ($name)"
      exit 1
    fi
    grep 'STEMSEAM:' "$WORK/seam-$name.log"
    if py analyse-render "/work/seam-$name.wav" "/work/seam-$name.log" "/work/fixture-$name.json" "$clip_sec" "${SEAM_TOLERANCE_MS:-25}"; then
      echo "   $name: beat grid intact"
    else
      echo "   $name: wrong buffer or broken beat grid"
      if [ "$mode" = controller ]; then verdict=1; fi
    fi
  done
done

if [ "$verdict" = 0 ]; then
  echo "STEMSEAM PASS: controller cues passed 0, 0.1 and default station crossfades"
else
  echo "STEMSEAM FAIL: use #1774's mixer fix before shipping these cues at short crossfades"
fi
echo "Renders and logs: $WORK"
exit "$verdict"
