#!/usr/bin/env bash
# Build the SUB/WAVE images this fork publishes and push them to a local
# private registry (default 192.168.1.50:5000), for deploying this branch
# somewhere that isn't ghcr.io/perminder-klair (e.g. an Unraid box) — used
# together with docker-compose.local-registry.yml and the pre-merged
# docker-compose.unraid.yml.
#
# Usage:
#   bash scripts/push-local-registry.sh                 # the 5 the stack needs
#   bash scripts/push-local-registry.sh controller web  # just these
#   bash scripts/push-local-registry.sh tts-heavy       # opt-in, see below
#
# The default run builds caddy, broadcast, controller, web and analyzer —
# everything the compose stack starts without a profile. `tts-heavy` is a
# multi-GB PyTorch image behind a compose profile that is off by default, so it
# is built only when you name it. Naming an unknown image is an error rather
# than a silent no-op.
#
# CONFIG COMES FROM ./.env, the same file compose reads, with the same
# precedence (the shell environment wins). That matters: compose resolves image
# names from LOCAL_REGISTRY and SUBWAVE_VERSION, and this script pushing to a
# different place than the stack pulls from is the one mistake that looks like
# a broken deploy rather than a config slip.
#
#   LOCAL_REGISTRY        default 192.168.1.50:5000 — the same var the compose
#                          overlay reads. Must be trusted as an insecure (HTTP)
#                          registry in the Docker daemon on this machine AND
#                          wherever the images get pulled.
#   REGISTRY              legacy alias; still wins over LOCAL_REGISTRY if set.
#   SUBWAVE_VERSION       the tag compose pulls; used as TAG when TAG is unset.
#   TAG                   default SUBWAVE_VERSION, else latest. A sha-<shortsha>
#                          tag is ALSO pushed every time, so the deploy .env can
#                          pin or roll back via SUBWAVE_VERSION.
#   ANALYZER_HEAVY        set (e.g. =1) to build subwave-analyzer-HEAVY with the
#                          CLAP + Demucs stack instead of the lean image —
#                          matching the image name compose switches to when the
#                          same var is set. amd64-only, as in CI.
#   SITE_URL              baked into the web image's build (cosmetic — the
#                          running container reads SITE_URL at runtime instead).
#   NEXT_PUBLIC_GA_ID     baked into the web image's client bundle. This one is
#                          build-time only, so it can ONLY be set here.
#   SUBWAVE_BUILD_VERSION defaults to `git describe`.
#
# Not built here: subwave-analyzer-cuda (the GPU flavour) and subwave-aio.
# docker-compose.analyzer-gpu.yml still names ghcr.io/perminder-klair for the
# cuda image and is not repointed by the local-registry overlay, so a fork using
# it would pull upstream regardless.

set -euo pipefail
cd "$(dirname "$0")/.."

# --- config, resolved the way compose resolves it ---------------------------

# Read one KEY from ./.env. Deliberately simple: every value below is a
# host:port, a tag, a flag or a URL — none carry spaces or inline comments, and
# this is a build script, not a config loader. (controller/src/setup/secrets.ts
# is the careful parser, for the values where a misread costs a secret.)
from_env_file() {
  [ -f .env ] || return 0
  sed -n "s/^[[:space:]]*\(export[[:space:]]\{1,\}\)\?$1=//p" .env \
    | tail -n 1 \
    | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# Environment beats .env beats the default — compose's own precedence.
resolve() {
  local var="$1" def="${2-}" cur from
  cur="${!var-}"
  if [ -n "$cur" ]; then printf '%s' "$cur"; return 0; fi
  from="$(from_env_file "$var")"
  printf '%s' "${from:-$def}"
}

LOCAL_REGISTRY="$(resolve LOCAL_REGISTRY 192.168.1.50:5000)"
# REGISTRY is the name this script shipped with; keep it working, but the
# compose files say LOCAL_REGISTRY, so that is what fills the default.
REGISTRY="${REGISTRY:-$LOCAL_REGISTRY}"
SUBWAVE_VERSION="$(resolve SUBWAVE_VERSION '')"
TAG="${TAG:-${SUBWAVE_VERSION:-latest}}"
ANALYZER_HEAVY="$(resolve ANALYZER_HEAVY '')"
SITE_URL="$(resolve SITE_URL '')"
NEXT_PUBLIC_GA_ID="$(resolve NEXT_PUBLIC_GA_ID '')"
CHATTERBOX_TORCH_INDEX_URL="$(resolve CHATTERBOX_TORCH_INDEX_URL 'https://download.pytorch.org/whl/cpu')"
CHATTERBOX_TORCH_SPEC="$(resolve CHATTERBOX_TORCH_SPEC '')"
SUBWAVE_BUILD_VERSION="${SUBWAVE_BUILD_VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo unknown)}"
SHA_TAG="sha-$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

# The analyzer ships in two flavours under DIFFERENT image names, and compose
# switches between them on this same variable — so the build has to follow it or
# `ANALYZER_HEAVY=1` asks the registry for an image nobody ever pushed. Args and
# platform match .github/workflows/publish-images.yml.
if [ -n "$ANALYZER_HEAVY" ]; then
  ANALYZER_IMAGE="subwave-analyzer-heavy"
  ANALYZER_ARGS="--platform linux/amd64 --build-arg WITH_CLAP=1 --build-arg WITH_DEMUCS=1"
else
  ANALYZER_IMAGE="subwave-analyzer"
  ANALYZER_ARGS="--build-arg WITH_CLAP=0 --build-arg WITH_DEMUCS=0"
fi

# selector|published image name|dockerfile|extra build flags
# The selector is what you type as an argument; the image name is what gets
# pushed. They differ for the heavy analyzer, which is the whole reason this is
# four fields and not three. `|` because dockerfile paths contain no pipes.
IMAGES=(
  "caddy|subwave-caddy|docker/Dockerfile.caddy|"
  "broadcast|subwave-broadcast|docker/Dockerfile.broadcast|"
  "controller|subwave-controller|docker/Dockerfile.controller|--build-arg SUBWAVE_BUILD_VERSION=${SUBWAVE_BUILD_VERSION}"
  "web|subwave-web|web/Dockerfile|--build-arg SITE_URL=${SITE_URL} --build-arg NEXT_PUBLIC_GA_ID=${NEXT_PUBLIC_GA_ID} --build-arg SUBWAVE_BUILD_VERSION=${SUBWAVE_BUILD_VERSION}"
  "analyzer|${ANALYZER_IMAGE}|docker/Dockerfile.analyzer|${ANALYZER_ARGS}"
  # amd64-only image, and compose pins `platform: linux/amd64` — build it as
  # amd64 or the pinned service cannot run what was pushed.
  "tts-heavy|subwave-tts-heavy|docker/Dockerfile.tts-heavy|--platform linux/amd64 --build-arg CHATTERBOX_TORCH_INDEX_URL=${CHATTERBOX_TORCH_INDEX_URL} --build-arg CHATTERBOX_TORCH_SPEC=${CHATTERBOX_TORCH_SPEC}"
)

# Built only when named: multi-GB, and its compose profile is off by default.
OPTIONAL="tts-heavy"

# --- selection --------------------------------------------------------------

selectors=()
for entry in "${IMAGES[@]}"; do selectors+=("${entry%%|*}"); done

wanted=()
if [ "$#" -gt 0 ]; then
  for arg in "$@"; do
    known=0
    for s in "${selectors[@]}"; do [ "$s" = "$arg" ] && known=1; done
    if [ "$known" -ne 1 ]; then
      echo "unknown image \"$arg\" — choose from: ${selectors[*]}" >&2
      exit 2
    fi
    wanted+=("$arg")
  done
else
  for s in "${selectors[@]}"; do
    case " $OPTIONAL " in *" $s "*) continue ;; esac
    wanted+=("$s")
  done
fi

echo "registry : ${REGISTRY}"
echo "tags     : ${TAG}$([ "$TAG" != "$SHA_TAG" ] && echo " + ${SHA_TAG}")"
echo "building : ${wanted[*]}"
echo

# --- build + push -----------------------------------------------------------

for entry in "${IMAGES[@]}"; do
  selector="${entry%%|*}"; rest="${entry#*|}"
  name="${rest%%|*}";     rest="${rest#*|}"
  dockerfile="${rest%%|*}"
  build_args="${rest#*|}"

  match=0
  for w in "${wanted[@]}"; do [ "$w" = "$selector" ] && match=1; done
  [ "$match" -eq 1 ] || continue

  image="${REGISTRY}/${name}"
  # Tag once when TAG already IS the sha tag (SUBWAVE_VERSION pinned to it).
  tags=(-t "${image}:${TAG}")
  [ "$TAG" != "$SHA_TAG" ] && tags+=(-t "${image}:${SHA_TAG}")

  echo "==> building ${image}:${TAG} (${dockerfile})"
  # shellcheck disable=SC2086  # build_args is an intentional word-split list
  docker build -f "$dockerfile" $build_args "${tags[@]}" .

  echo "==> pushing ${image}:${TAG}"
  docker push "${image}:${TAG}"
  if [ "$TAG" != "$SHA_TAG" ]; then
    echo "==> pushing ${image}:${SHA_TAG}"
    docker push "${image}:${SHA_TAG}"
  fi
done

echo
echo "done. The stack pulls these as \${LOCAL_REGISTRY:-192.168.1.50:5000}/<image>:\${SUBWAVE_VERSION:-latest}"
