#!/usr/bin/env bash
# Regression check for #2205: `subwave update` must exit non-zero when any step
# fails (stack not running, git pull, image pull, build, up), so a script or cron
# job can tell that an update didn't land. A failed image pull still runs build
# and up, but ends with a stale-images warning instead of "update complete".
#
# Usage: cli/scripts/smoke-update-exit.sh <path-to-subwave>
#
# Works with a compiled binary or a wrapper around `tsx src/cli.ts`, and needs no
# tagged version. Never talks to a daemon or a real station: it uses scratch
# installs, a scratch HOME and fake `docker` and `git` first on PATH. The fakes
# log each verb they're asked for and fail on request:
#   FAKE_STACK_DOWN=1   `docker compose ps -q` reports no containers
#   FAKE_PULL_EXIT=n    exit code of `docker compose pull`
#   FAKE_BUILD_EXIT=n   exit code of `docker compose build`
#   FAKE_UP_EXIT=n      exit code of `docker compose up`
#   FAKE_GIT_EXIT=n     exit code of `git`

set -euo pipefail

if [ "$#" -ne 1 ] || [ ! -x "$1" ]; then
  echo "usage: $0 <path-to-subwave>" >&2
  exit 2
fi
binary="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"

scratch="$(mktemp -d)"
trap 'rm -rf -- "${scratch:?}"' EXIT
mkdir -p "$scratch/bin" "$scratch/home"

cat >"$scratch/bin/docker" <<'FAKE'
#!/usr/bin/env bash
case " $* " in
  *" ps -q "*) [ "${FAKE_STACK_DOWN:-0}" = 1 ] || echo fake-container ;;
  *" ps --format "*) ;;
  *" inspect "*) ;;
  *" pull "*) echo pull >>"$SMOKE_LOG"; exit "${FAKE_PULL_EXIT:-0}" ;;
  *" build "*) echo build >>"$SMOKE_LOG"; exit "${FAKE_BUILD_EXIT:-0}" ;;
  *" up "*) echo up >>"$SMOKE_LOG"; exit "${FAKE_UP_EXIT:-0}" ;;
esac
exit 0
FAKE

cat >"$scratch/bin/git" <<'FAKE'
#!/usr/bin/env bash
echo git >>"$SMOKE_LOG"
exit "${FAKE_GIT_EXIT:-0}"
FAKE
chmod +x "$scratch/bin/docker" "$scratch/bin/git"

guard=()
if command -v timeout >/dev/null 2>&1; then guard=(timeout 60); fi

failures=0

check() { # check <label> <wanted> <got>
  if [ "$2" = "$3" ]; then
    echo "ok   - $1"
  else
    echo "FAIL - $1: wanted '$2', got '$3'"
    failures=$((failures + 1))
  fi
}

# Scaffolds a standalone or clone install and runs `subwave update` from inside
# it. Extra args are VAR=value pairs for the run's environment. Leaves the exit
# code in $scratch/<name>.code, the output in .out and the verbs in .log.
run_update() { # run_update <name> <standalone|clone> [VAR=value...]
  local name="$1" mode="$2" install="$scratch/$1" code=0
  shift 2
  mkdir -p "$install"
  cat >"$install/docker-compose.yml" <<'COMPOSE'
services:
  controller:
    image: ghcr.io/perminder-klair/subwave-controller:${SUBWAVE_VERSION:-latest}
COMPOSE
  printf 'ADMIN_USER=admin\nADMIN_PASS=smoke\n' >"$install/.env"
  if [ "$mode" = clone ]; then
    mkdir -p "$install/controller" "$install/web"
    echo '{}' >"$install/controller/package.json"
    echo '{}' >"$install/web/package.json"
  fi
  : >"$scratch/$name.log"

  (
    cd "$install"
    env -u SUBWAVE_VERSION \
      HOME="$scratch/home" \
      XDG_CONFIG_HOME="$scratch/home/.config" \
      SUBWAVE_HOME="$install" \
      PATH="$scratch/bin:$PATH" \
      SMOKE_LOG="$scratch/$name.log" \
      "$@" ${guard[@]+"${guard[@]}"} "$binary" update
  ) </dev/null >"$scratch/$name.out" 2>&1 || code=$?
  echo "$code" >"$scratch/$name.code"
}

exit_of() { cat "$scratch/$1.code"; }
ran() { if grep -qx "$2" "$scratch/$1.log"; then echo yes; else echo no; fi; }
says() { if grep -qF "$2" "$scratch/$1.out"; then echo yes; else echo no; fi; }

# 1. Standalone, everything works.
run_update sa-ok standalone
check "standalone ok: exits 0" 0 "$(exit_of sa-ok)"
check "standalone ok: says update complete" yes "$(says sa-ok 'update complete')"
check "standalone ok: pulled" yes "$(ran sa-ok pull)"
check "standalone ok: ran up" yes "$(ran sa-ok up)"

# 2. Standalone, stack not running: nothing happens, and that's a failure.
run_update sa-down standalone FAKE_STACK_DOWN=1
check "stack down: exits 1" 1 "$(exit_of sa-down)"
check "stack down: no pull" no "$(ran sa-down pull)"
check "stack down: no up" no "$(ran sa-down up)"

# 3. Standalone, image pull fails but up works: the misleading case.
run_update sa-pull standalone FAKE_PULL_EXIT=1
check "standalone pull fails: exits 1" 1 "$(exit_of sa-pull)"
check "standalone pull fails: still runs up" yes "$(ran sa-pull up)"
check "standalone pull fails: no update complete" no "$(says sa-pull 'update complete')"
check "standalone pull fails: warns images may be stale" yes "$(says sa-pull 'images may be stale')"

# 4. Standalone, up fails.
run_update sa-up standalone FAKE_UP_EXIT=1
check "standalone up fails: exits 1" 1 "$(exit_of sa-up)"
check "standalone up fails: no update complete" no "$(says sa-up 'update complete')"

# 5. Clone, git pull fails: stops before compose.
run_update cl-git clone FAKE_GIT_EXIT=1
check "clone git pull fails: exits 1" 1 "$(exit_of cl-git)"
check "clone git pull fails: ran git" yes "$(ran cl-git git)"
check "clone git pull fails: no pull" no "$(ran cl-git pull)"
check "clone git pull fails: no build" no "$(ran cl-git build)"
check "clone git pull fails: no up" no "$(ran cl-git up)"

# 6. Clone, build fails: stops before up.
run_update cl-build clone FAKE_BUILD_EXIT=1
check "clone build fails: exits 1" 1 "$(exit_of cl-build)"
check "clone build fails: ran build" yes "$(ran cl-build build)"
check "clone build fails: no up" no "$(ran cl-build up)"

# 7. Clone, image pull fails: build and up still run, verdict is a warning.
run_update cl-pull clone FAKE_PULL_EXIT=1
check "clone pull fails: exits 1" 1 "$(exit_of cl-pull)"
check "clone pull fails: still builds" yes "$(ran cl-pull build)"
check "clone pull fails: still runs up" yes "$(ran cl-pull up)"
check "clone pull fails: no update complete" no "$(says cl-pull 'update complete')"
check "clone pull fails: warns images may be stale" yes "$(says cl-pull 'images may be stale')"

# 8. Clone, everything works.
run_update cl-ok clone
check "clone ok: exits 0" 0 "$(exit_of cl-ok)"
check "clone ok: says update complete" yes "$(says cl-ok 'update complete')"
check "clone ok: ran git" yes "$(ran cl-ok git)"
check "clone ok: pulled" yes "$(ran cl-ok pull)"
check "clone ok: built" yes "$(ran cl-ok build)"
check "clone ok: ran up" yes "$(ran cl-ok up)"

if [ "$failures" -ne 0 ]; then
  echo
  echo "$failures check(s) failed against $binary. subwave update output:"
  for out in "$scratch"/*.out; do
    echo "--- $(basename "$out" .out) (exit $(cat "${out%.out}.code"))"
    cat "$out"
  done
  exit 1
fi
echo "all checks passed against $binary"
