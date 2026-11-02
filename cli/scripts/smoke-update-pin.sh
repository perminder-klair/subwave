#!/usr/bin/env bash
# Regression check for #2196 and #2203: the CLI must read the install's .env and
# never the .env of the directory it's run from. Only a compiled binary can show
# this bug. A Bun binary built without --no-compile-autoload-dotenv loads the
# working directory's .env into process.env at boot, which a `tsx` run doesn't,
# and compose prefers the environment over .env.
#
# It covers the first `subwave update` after a new binary (it must reach compose
# with the new version), the same update run from another project's directory,
# and the ports `subwave listen prod` reads from the install's .env.
#
# Usage: cli/scripts/smoke-update-pin.sh <path-to-compiled-subwave>
#
# Never talks to a daemon or a real station: it uses a scratch install, a scratch
# HOME, a fake `docker` and a fake browser opener first on PATH. The fake docker
# applies compose's precedence itself (environment, then the last line in .env)
# and records what `pull` and `up` would resolve. The fake opener records the URL.

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

# All older than any release this script will see, and different from each other.
old_pin=0.1.0
exported=0.2.0
foreign=0.3.0

scratch="$(mktemp -d)"
trap 'rm -rf -- "${scratch:?}"' EXIT
mkdir -p "$scratch/bin" "$scratch/home" "$scratch/elsewhere" "$scratch/empty"

# Another project's directory, with a .env that must never reach the CLI.
printf 'SUBWAVE_VERSION=%s\nCADDY_PORT=7799\n' "$foreign" >"$scratch/elsewhere/.env"

cat >"$scratch/bin/docker" <<'FAKE'
#!/usr/bin/env bash
case " $* " in
  *" ps -q "*) echo fake-container ;;
  *" pull "* | *" up "*)
    if [ -n "${SUBWAVE_VERSION+set}" ]; then
      resolved="$SUBWAVE_VERSION"
    else
      resolved="$(sed -n 's/^SUBWAVE_VERSION=//p' .env | tail -n 1)"
    fi
    verb=pull
    case " $* " in *" up "*) verb=up ;; esac
    echo "$verb $resolved" >>"$SMOKE_LOG"
    ;;
esac
FAKE
chmod +x "$scratch/bin/docker"

for opener in xdg-open open; do
  cat >"$scratch/bin/$opener" <<'FAKE'
#!/usr/bin/env bash
echo "$1" >>"$SMOKE_LOG"
FAKE
  chmod +x "$scratch/bin/$opener"
done

failures=0

check() { # check <label> <wanted> <got>
  if [ "$2" = "$3" ]; then
    echo "ok   - $1"
  else
    echo "FAIL - $1: wanted '$2', got '$3'"
    failures=$((failures + 1))
  fi
}

# Scaffolds an install whose .env carries the given extra line(s).
scaffold() { # scaffold <name> <extra .env line(s)>
  local install="$scratch/$1"
  mkdir -p "$install"
  cat >"$install/docker-compose.yml" <<'COMPOSE'
services:
  controller:
    image: ghcr.io/perminder-klair/subwave-controller:${SUBWAVE_VERSION:-latest}
COMPOSE
  printf 'ADMIN_USER=admin\nADMIN_PASS=smoke\n%s\n' "$2" >"$install/.env"
}

# Runs the binary from <cwd> with a scratch HOME and the fakes first on PATH.
# VAR=value pairs before `--` go into the run's environment; the rest are the
# subwave arguments. Returns the binary's exit status.
run_cli() { # run_cli <name> <cwd> [VAR=value...] -- <subwave args...>
  local name="$1" cwd="$2"
  shift 2
  local vars=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
    vars+=("$1")
    shift
  done
  shift
  (
    cd "$cwd"
    env -u SUBWAVE_VERSION -u SUBWAVE_HOME -u CADDY_PORT \
      HOME="$scratch/home" \
      XDG_CONFIG_HOME="$scratch/home/.config" \
      PATH="$scratch/bin:$PATH" \
      SMOKE_LOG="$scratch/$name.log" \
      ${vars[@]+"${vars[@]}"} "$binary" "$@"
  ) </dev/null >"$scratch/$name.out" 2>&1
}

# Scaffolds an install with the given pin line and runs `subwave update` from
# inside it, which is the directory whose .env an autoloading binary picks up.
# Extra args are VAR=value pairs for the run's environment.
run_update() { # run_update <name> <pin line> [VAR=value...]
  local name="$1" pin_line="$2" install="$scratch/$1"
  shift 2
  scaffold "$name" "$pin_line"
  if ! run_cli "$name" "$install" SUBWAVE_HOME="$install" "$@" -- update; then
    echo "FAIL - $name: subwave update exited non-zero"
    failures=$((failures + 1))
  fi
}

pin_in() { sed -n 's/^SUBWAVE_VERSION=//p' "$scratch/$1/.env" | tail -n 1; }
resolved_by() { sed -n "s/^$2 //p" "$scratch/$1.log" 2>/dev/null || true; }

check_first_run() { # check_first_run <name> <label>
  check "$2: .env moves to the new pin" "$target" "$(pin_in "$1")"
  check "$2: pull resolves the new version" "$target" "$(resolved_by "$1" pull)"
  check "$2: up resolves the new version" "$target" "$(resolved_by "$1" up)"
}

# The operator's flow: the pin in .env is behind the binary.
run_update first-run "SUBWAVE_VERSION=$old_pin"
check_first_run first-run "first run"

# A hand-edited pin can carry an inline comment, which compose drops. The move
# has to recognise the pin all the same.
run_update inline-comment "SUBWAVE_VERSION=$old_pin # pinned"
check_first_run inline-comment "inline comment"
run_update quoted-comment "SUBWAVE_VERSION=\"$old_pin\" # pinned"
check_first_run quoted-comment "quoted pin with a comment"

# Compose takes the last of a duplicated pin, so moving any other line sends the
# next run back to the old version.
run_update duplicated "SUBWAVE_VERSION=$old_pin
SUBWAVE_VERSION=$old_pin"
check_first_run duplicated "duplicated pin"

# A real shell export beats .env in compose, so it stays in charge. The .env
# check proves the run reached the move rather than passing by doing nothing.
run_update shell-export "SUBWAVE_VERSION=$old_pin" "SUBWAVE_VERSION=$exported"
check "shell export: .env still moves to the new pin" "$target" "$(pin_in shell-export)"
check "shell export: pull keeps the exported version" "$exported" "$(resolved_by shell-export pull)"
check "shell export: up keeps the exported version" "$exported" "$(resolved_by shell-export up)"

# Run from another project's directory with --home: that directory's .env (a
# different SUBWAVE_VERSION) must not reach compose (#2203).
scaffold foreign-cwd "SUBWAVE_VERSION=$old_pin"
if ! run_cli foreign-cwd "$scratch/elsewhere" -- --home "$scratch/foreign-cwd" update; then
  echo "FAIL - foreign-cwd: subwave update exited non-zero"
  failures=$((failures + 1))
fi
check_first_run foreign-cwd "foreign cwd"

# The URL the fake opener received. The opener is spawned detached, so give it a
# moment to write after the binary exits.
opened_by() { # opened_by <name>
  local i
  for i in $(seq 1 50); do
    [ -s "$scratch/$1.log" ] && break
    sleep 0.1
  done
  tail -n 1 "$scratch/$1.log" 2>/dev/null || true
}

listen() { # listen <name> <cwd> [VAR=value...] -- <subwave args...>
  if ! run_cli "$@"; then
    echo "FAIL - $1: subwave listen exited non-zero"
    failures=$((failures + 1))
  fi
}

# A custom Caddy port lives in the install's .env. `listen prod` has to find it
# wherever it runs from, and a shell export still wins, as it does in compose.
scaffold ports "CADDY_PORT=7788"
listen ports-install-cwd "$scratch/ports" -- --home "$scratch/ports" listen prod
check "ports, install cwd: listen uses the install's CADDY_PORT" \
  "http://localhost:7788/listen" "$(opened_by ports-install-cwd)"
listen ports-foreign-cwd "$scratch/elsewhere" -- --home "$scratch/ports" listen prod
check "ports, foreign cwd: listen ignores that directory's CADDY_PORT" \
  "http://localhost:7788/listen" "$(opened_by ports-foreign-cwd)"
listen ports-empty-cwd "$scratch/empty" -- --home "$scratch/ports" listen prod
check "ports, empty cwd: listen uses the install's CADDY_PORT" \
  "http://localhost:7788/listen" "$(opened_by ports-empty-cwd)"
listen ports-shell-export "$scratch/empty" CADDY_PORT=7790 -- --home "$scratch/ports" listen prod
check "ports, shell export: the exported CADDY_PORT wins" \
  "http://localhost:7790/listen" "$(opened_by ports-shell-export)"
scaffold ports-comment "CADDY_PORT=7788 # custom"
listen ports-comment "$scratch/empty" -- --home "$scratch/ports-comment" listen prod
check "ports, inline comment: the comment is dropped" \
  "http://localhost:7788/listen" "$(opened_by ports-comment)"

if [ "$failures" -ne 0 ]; then
  echo
  echo "$failures check(s) failed against $binary ($target). subwave output:"
  for out in "$scratch"/*.out; do
    echo "--- $(basename "$out" .out)"
    cat "$out"
  done
  exit 1
fi
echo "all checks passed against $binary ($target)"
