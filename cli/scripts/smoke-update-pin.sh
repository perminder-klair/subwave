#!/usr/bin/env bash
# Regression check for #2196: the first `subwave update` after a new binary must
# reach compose with the new version. Only a compiled binary can show this bug.
# It loads the working directory's .env into process.env at boot, which a `tsx`
# run doesn't, and compose prefers the environment over .env.
#
# Usage: cli/scripts/smoke-update-pin.sh <path-to-compiled-subwave>
#
# Never talks to a daemon or a real station: it uses a scratch install, a scratch
# HOME and a fake `docker` first on PATH. The fake applies compose's precedence
# itself (environment, then .env) and records what `pull` and `up` would resolve.

set -euo pipefail

if [ "$#" -ne 1 ] || [ ! -x "$1" ]; then
  echo "usage: $0 <path-to-compiled-subwave>" >&2
  exit 2
fi
binary="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"

if ! target="$("$binary" --version)"; then
  echo "could not run $binary" >&2
  exit 2
fi
target="${target#v}"
if [[ ! "$target" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || [[ "$target" == 0.0.0* ]]; then
  echo "$binary reports version '$target', which has no published tag to pin to" >&2
  exit 2
fi

# Both older than any release this script will see, and different from each other.
old_pin=0.1.0
exported=0.2.0

scratch="$(mktemp -d)"
trap 'rm -rf -- "${scratch:?}"' EXIT
mkdir -p "$scratch/bin" "$scratch/home"

cat >"$scratch/bin/docker" <<'FAKE'
#!/usr/bin/env bash
case " $* " in
  *" ps -q "*) echo fake-container ;;
  *" pull "* | *" up "*)
    if [ -n "${SUBWAVE_VERSION+set}" ]; then
      resolved="$SUBWAVE_VERSION"
    else
      resolved="$(sed -n 's/^SUBWAVE_VERSION=//p' .env)"
    fi
    verb=pull
    case " $* " in *" up "*) verb=up ;; esac
    echo "$verb $resolved" >>"$SMOKE_LOG"
    ;;
esac
FAKE
chmod +x "$scratch/bin/docker"

failures=0

check() { # check <label> <wanted> <got>
  if [ "$2" = "$3" ]; then
    echo "ok   - $1"
  else
    echo "FAIL - $1: wanted '$2', got '$3'"
    failures=$((failures + 1))
  fi
}

# Scaffolds an install pinned to $old_pin and runs `subwave update` from inside
# it, which is what makes the binary load that .env. Extra args are VAR=value
# pairs for the run's environment.
run_update() { # run_update <name> [VAR=value...]
  local name="$1" install="$scratch/$1"
  shift
  mkdir -p "$install"
  cat >"$install/docker-compose.yml" <<'COMPOSE'
services:
  controller:
    image: ghcr.io/perminder-klair/subwave-controller:${SUBWAVE_VERSION:-latest}
COMPOSE
  printf 'ADMIN_USER=admin\nADMIN_PASS=smoke\nSUBWAVE_VERSION=%s\n' "$old_pin" >"$install/.env"

  if ! (
    cd "$install"
    env -u SUBWAVE_VERSION \
      HOME="$scratch/home" \
      XDG_CONFIG_HOME="$scratch/home/.config" \
      SUBWAVE_HOME="$install" \
      PATH="$scratch/bin:$PATH" \
      SMOKE_LOG="$scratch/$name.log" \
      "$@" "$binary" update
  ) </dev/null >"$scratch/$name.out" 2>&1; then
    echo "FAIL - $name: subwave update exited non-zero"
    failures=$((failures + 1))
  fi
}

pin_in() { sed -n 's/^SUBWAVE_VERSION=//p' "$scratch/$1/.env"; }
resolved_by() { sed -n "s/^$2 //p" "$scratch/$1.log" 2>/dev/null || true; }

# The operator's flow: the pin in .env is behind the binary.
run_update first-run
check "first run: .env moves to the new pin" "$target" "$(pin_in first-run)"
check "first run: pull resolves the new version" "$target" "$(resolved_by first-run pull)"
check "first run: up resolves the new version" "$target" "$(resolved_by first-run up)"

# A real shell export isn't the autoloaded pin, so it stays in charge. The .env
# check proves the run reached the move rather than passing by doing nothing.
run_update shell-export "SUBWAVE_VERSION=$exported"
check "shell export: .env still moves to the new pin" "$target" "$(pin_in shell-export)"
check "shell export: pull keeps the exported version" "$exported" "$(resolved_by shell-export pull)"
check "shell export: up keeps the exported version" "$exported" "$(resolved_by shell-export up)"

if [ "$failures" -ne 0 ]; then
  echo
  echo "$failures check(s) failed against $binary ($target). subwave update output:"
  cat "$scratch/first-run.out" "$scratch/shell-export.out"
  exit 1
fi
echo "all checks passed against $binary ($target)"
