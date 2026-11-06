#!/usr/bin/env bash
# Regression check for #2262: on Linux, every Clack prompt in a compiled binary
# crashed with `ESPIPE: invalid seek, read` on its first keypress. Bun's
# /dev/tty ReadStream reads with pread, which a Linux tty rejects. Only a
# compiled binary built after patch-clack, run under a real pty, shows this bug.
#
# Usage: cli/scripts/smoke-tty-prompt.sh <path-to-compiled-subwave>
#
# Linux only: it drives the binary through util-linux `script -qec`, which gives
# it a pty. Each case waits for a prompt to render, sends keys, and fails on
# ESPIPE, on a prompt that never appears, or on a run that doesn't finish. Never
# talks to a daemon: a scratch install, a scratch HOME and a fake `docker` first
# on PATH that reports a running prod stack.

set -euo pipefail

if [ "$#" -ne 1 ] || [ ! -x "$1" ]; then
  echo "usage: $0 <path-to-compiled-subwave>" >&2
  exit 2
fi
binary="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"

if [ "$(uname -s)" != Linux ]; then
  echo "$0 targets Linux (util-linux script); this is $(uname -s)" >&2
  exit 2
fi
if ! script --version 2>/dev/null | grep -q util-linux; then
  echo "$0 needs util-linux script on PATH" >&2
  exit 2
fi

# Seconds to wait for each prompt to render, and for each whole run.
prompt_wait=15
run_timeout=30

scratch="$(mktemp -d)"
trap 'rm -rf -- "${scratch:?}"' EXIT
mkdir -p "$scratch/bin" "$scratch/home"

cat >"$scratch/bin/docker" <<'FAKE'
#!/usr/bin/env bash
case " $* " in
  *" ps -q "*) echo fake-container ;;
  *" config --services "*) printf 'controller\nweb\n' ;;
  *" inspect "*) exit 1 ;;
esac
FAKE
chmod +x "$scratch/bin/docker"

# A prod install for stop and restart to find.
install="$scratch/install"
mkdir -p "$install"
cat >"$install/docker-compose.yml" <<'COMPOSE'
services:
  controller:
    image: ghcr.io/perminder-klair/subwave-controller:latest
COMPOSE
printf 'ADMIN_USER=admin\nADMIN_PASS=smoke\n' >"$install/.env"

failures=0

# The pty output with line breaks, ANSI escapes and spaces removed, so a prompt
# drawn in pieces (Clack moves the cursor rather than printing some spaces)
# still matches as one string. squash does the same to the text to look for.
flat() { tr -d '\r\n' <"$1" | sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g' | tr -d ' '; }
squash() { printf '%s' "$1" | tr -d ' '; }

# Waits until the run's output shows <text>, then sends <keys> to the pty.
# Returns non-zero if <text> never shows.
await_then_send() { # await_then_send <out> <text> <keys>
  local i
  for ((i = 0; i < prompt_wait * 10; i++)); do
    if flat "$1" | grep -qF -- "$(squash "$2")"; then
      sleep 0.5 # let the prompt switch the pty to raw mode
      printf '%b' "$3"
      return 0
    fi
    sleep 0.1
  done
  return 1
}

# Runs `subwave <args>` under a pty, then feeds it one step at a time. Each step
# is a "<prompt text>|<keys>" pair; <keys> takes printf %b escapes. Passes when
# the run finishes in time, shows no ESPIPE, reaches every prompt, and ends with
# <wanted> in its output.
run_case() { # run_case <name> <wanted> <args> <step>...
  local name="$1" wanted="$2" args="$3" out="$scratch/$1.out" step code=0
  shift 3
  : >"$out"

  {
    for step in "$@"; do
      if ! await_then_send "$out" "${step%%|*}" "${step#*|}"; then
        echo "never saw prompt: ${step%%|*}" >"$scratch/$name.missing"
        break
      fi
    done
    # Holding the pty's input open until the run ends keeps `script` from
    # passing EOF to a prompt early.
    while [ ! -e "$scratch/$name.done" ]; do sleep 0.1; done
  } | (
    cd "$scratch"
    rc=0
    HOME="$scratch/home" \
      XDG_CONFIG_HOME="$scratch/home/.config" \
      PATH="$scratch/bin:$PATH" \
      timeout "$run_timeout" script -qec "'$binary' $args" /dev/null || rc=$?
    touch "$scratch/$name.done"
    exit "$rc"
  ) >"$out" 2>&1 || code=$?

  local text
  text="$(flat "$out")"
  if [[ "$text" == *ESPIPE* ]]; then
    echo "FAIL - $name: ESPIPE (#2262)"
  elif [ -e "$scratch/$name.missing" ]; then
    echo "FAIL - $name: $(cat "$scratch/$name.missing")"
  elif [ "$code" -eq 124 ]; then
    echo "FAIL - $name: still running after ${run_timeout}s"
  elif [[ "$text" != *"$(squash "$wanted")"* ]]; then
    echo "FAIL - $name: never printed '$wanted' (exit $code)"
  else
    echo "ok   - $name"
    return 0
  fi
  failures=$((failures + 1))
}

# init's first prompt is a text prompt and touches nothing before it. Ctrl-C at
# it must cancel cleanly.
run_case init-cancel "Cancelled." "--home '$scratch/init-cancel' init" \
  "Install directory|\\003"

# A typed answer has to land: type a path, Enter, and the next prompt (a select)
# must appear before Ctrl-C cancels it.
run_case init-answer "Cancelled." "--home '$scratch/init-answer' init" \
  "Install directory|\\025$scratch/init-answer\\r" \
  "Deployment shape|\\003"

# The reporter's commands. stop's confirm defaults to no on prod, so Enter
# answers it; restart's service select is cancelled.
run_case stop-confirm "cancelled." "--home '$install' stop" \
  "Stop the|\\r"
run_case restart-select "Cancelled." "--home '$install' restart" \
  "Which service?|\\003"

if [ "$failures" -ne 0 ]; then
  echo
  echo "$failures check(s) failed against $binary. pty output:"
  for out in "$scratch"/*.out; do
    echo "--- $(basename "$out" .out)"
    sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g' "$out" | tr -d '\r'
  done
  exit 1
fi
echo "all checks passed against $binary"
