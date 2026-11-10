#!/bin/sh
# Repro of the curl|sh → exec subwave init </dev/tty path: run through a sh
# whose stdin is closed (mimicking the curl pipe), then exec the binary with
# `</dev/tty`, as install.sh does.
#
# Usage: bash cli/scripts/repro-tty.sh
# Uses `--home /tmp/sw-test` so it can't clobber a real ~/subwave install.

set -eu

BIN="$(cd "$(dirname "$0")/.." && pwd)/dist/subwave-darwin-arm64"

if [ ! -x "$BIN" ]; then
  echo "missing binary: $BIN" >&2
  echo "run 'npm --prefix cli run build:darwin-arm64' first." >&2
  exit 1
fi

echo "==> repro: non-TTY parent → exec '$BIN init' </dev/tty"
echo "==> using --home /tmp/sw-test (won't touch your real ~/subwave)"
echo

# Inner sh sees stdin closed; /dev/tty is then redirected onto fd 0 before exec,
# the same handshake install.sh does.
sh -c '
  exec </dev/tty
  exec "'"$BIN"'" --home /tmp/sw-test init
' <&-
