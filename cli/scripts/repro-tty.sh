#!/bin/sh
# Faithful repro of the curl|sh → exec subwave init </dev/tty path.
#
# `curl … | sh` leaves sh's stdin attached to the curl pipe (not a TTY).
# We simulate that by running this whole script through a sh process whose
# stdin we explicitly close, so the inner shell's stdin is non-TTY. Then we
# exec the binary with `</dev/tty`, which is exactly what install.sh does.
#
# Usage: bash cli/scripts/repro-tty.sh
#
# Bails into init with `--home /tmp/sw-test` so it can't clobber your real
# ~/subwave install while you're testing.

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

# Inner sh sees stdin closed (mimics the curl pipe that's done sending).
# Then we redirect /dev/tty onto fd 0 and exec the binary — same handshake
# install.sh does after the operator answers Y to "Run init now?".
sh -c '
  exec </dev/tty
  exec "'"$BIN"'" --home /tmp/sw-test init
' <&-
