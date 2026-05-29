#!/bin/sh
# SUB/WAVE — standalone CLI installer.
#
# Detects the host OS + architecture, downloads the matching `subwave`
# binary from the latest GitHub Release, and places it on PATH.
#
# Usage:
#   curl -fsSL https://cli.getsubwave.com | sh
#   curl -fsSL https://cli.getsubwave.com | sh -s -- --version v1.2.3
#   curl -fsSL https://cli.getsubwave.com | sh -s -- --dir ~/.local/bin
#
# Supported targets: linux-x64, linux-arm64, darwin-x64, darwin-arm64.
# Bun-compiled binaries ship as single files — no extraction, no
# dependencies. Default install path is /usr/local/bin/subwave (with sudo
# fallback if it isn't writable); pass --dir to override.

set -eu

REPO="perminder-klair/subwave"
BIN_NAME="subwave"
VERSION=""
INSTALL_DIR=""

# ---- arg parsing -----------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      VERSION="${2:-}"
      shift 2 || { echo "missing value for --version" >&2; exit 2; }
      ;;
    --version=*)
      VERSION="${1#--version=}"
      shift
      ;;
    --dir)
      INSTALL_DIR="${2:-}"
      shift 2 || { echo "missing value for --dir" >&2; exit 2; }
      ;;
    --dir=*)
      INSTALL_DIR="${1#--dir=}"
      shift
      ;;
    -h|--help)
      cat <<'HELP'
Usage: curl -fsSL https://cli.getsubwave.com | sh [-s -- [options]]

Options:
  --version <tag>   install a specific release (e.g. v1.2.3). Default: latest
  --dir <path>      install dir (default: /usr/local/bin)
  -h, --help        show this help
HELP
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      exit 2
      ;;
  esac
done

# ---- platform detection ----------------------------------------------------
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS" in
  linux)  TARGET_OS="linux" ;;
  darwin) TARGET_OS="darwin" ;;
  *) echo "unsupported OS: $OS (linux or macOS only)" >&2; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64)  TARGET_ARCH="x64" ;;
  arm64|aarch64) TARGET_ARCH="arm64" ;;
  *) echo "unsupported arch: $ARCH (x86_64 or arm64 only)" >&2; exit 1 ;;
esac

ASSET="${BIN_NAME}-${TARGET_OS}-${TARGET_ARCH}"

# ---- resolve release tag ---------------------------------------------------
if [ -z "$VERSION" ]; then
  # GitHub redirects /releases/latest to /releases/tag/<latest>; we capture
  # the resolved URL and pull the tag off the end. Works without a token.
  if ! VERSION="$(
    curl -fsSL -o /dev/null -w '%{url_effective}' \
      "https://github.com/${REPO}/releases/latest" \
      | sed -E 's|.*/tag/(.+)$|\1|'
  )"; then
    echo "could not resolve latest release. Pass --version <tag> explicitly." >&2
    exit 1
  fi
fi

URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET}"

# ---- install dir -----------------------------------------------------------
if [ -z "$INSTALL_DIR" ]; then
  INSTALL_DIR="/usr/local/bin"
fi

# Need elevated privileges if the dir isn't writable. Tested separately so
# we can give a clear message instead of failing silently on the mv.
NEEDS_SUDO=0
if [ ! -w "$INSTALL_DIR" ]; then
  if ! mkdir -p "$INSTALL_DIR" 2>/dev/null; then
    NEEDS_SUDO=1
  elif [ ! -w "$INSTALL_DIR" ]; then
    NEEDS_SUDO=1
  fi
fi

if [ "$NEEDS_SUDO" = "1" ]; then
  if ! command -v sudo >/dev/null 2>&1; then
    echo "$INSTALL_DIR is not writable and sudo is unavailable." >&2
    echo "Pass --dir <writable-path> to install elsewhere (e.g. ~/.local/bin)." >&2
    exit 1
  fi
fi

# ---- download + install ----------------------------------------------------
echo "==> SUB/WAVE CLI installer"
echo "  target:  ${TARGET_OS}-${TARGET_ARCH}"
echo "  version: ${VERSION}"
echo "  source:  ${URL}"
echo "  dest:    ${INSTALL_DIR}/${BIN_NAME}"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

if ! curl -fsSL "$URL" -o "$TMPDIR/$BIN_NAME"; then
  echo "download failed. Check the release exists at:" >&2
  echo "  https://github.com/${REPO}/releases/tag/${VERSION}" >&2
  exit 1
fi
chmod +x "$TMPDIR/$BIN_NAME"

if [ "$NEEDS_SUDO" = "1" ]; then
  echo "  (elevating with sudo to write to $INSTALL_DIR)"
  sudo mkdir -p "$INSTALL_DIR"
  sudo mv "$TMPDIR/$BIN_NAME" "$INSTALL_DIR/$BIN_NAME"
else
  mkdir -p "$INSTALL_DIR"
  mv "$TMPDIR/$BIN_NAME" "$INSTALL_DIR/$BIN_NAME"
fi

echo
echo "✓ installed $BIN_NAME to $INSTALL_DIR/$BIN_NAME"
echo

# Check the binary is on PATH; if not, hint at PATH editing.
if ! command -v "$BIN_NAME" >/dev/null 2>&1; then
  echo "Note: $INSTALL_DIR is not on your PATH."
  echo "      Add it (or move $INSTALL_DIR/$BIN_NAME to a directory that is):"
  echo "      export PATH=\"$INSTALL_DIR:\$PATH\""
  echo
fi

# Offer to chain straight into a scaffold + start when running interactively.
#
# We must NOT drive the *interactive* `subwave init` through the curl pipe.
# On macOS, Bun doesn't deliver stdin bytes when the binary is launched from a
# parent whose own stdin is piped (oven-sh/bun#13374) — even after an
# `exec </dev/tty` re-attach. The first Clack prompt then renders and hangs
# forever in raw mode, swallowing Ctrl-C. (Running `subwave init` directly from
# the operator's own shell is fine — stdin is a real controlling TTY there.)
#
# So instead we confirm at the SHELL level (POSIX `read </dev/tty`, which is
# unaffected by the Bun bug) and run the NON-interactive `subwave init --yes`.
# `--yes` has no prompts, so stdin is irrelevant and nothing can hang. It
# scaffolds with sane defaults (home ~/subwave, prod, admin user "admin",
# generated password printed below) and brings the stack up. Operators who
# want the interactive wizard answer "n" and run `subwave init` themselves.
#
# Non-interactive callers (CI, Docker builds, anything without /dev/tty) skip
# the prompt and see the Next: hint below.
if [ -t 1 ] && [ -r /dev/tty ]; then
  printf '\nScaffold + start SUB/WAVE now with defaults? [Y/n] '
  reply=""
  read -r reply </dev/tty || reply=""
  case "${reply:-y}" in
    y|Y|yes|YES)
      echo
      "$INSTALL_DIR/$BIN_NAME" init --yes
      status=$?
      if [ "$status" -eq 0 ]; then
        echo
        echo "Customize anytime with \`$BIN_NAME setup\` (Navidrome, LLM, TTS, DJ)."
      fi
      exit "$status"
      ;;
  esac
  echo
fi

echo "Next:"
echo "  $BIN_NAME init           # scaffold a fresh install at ~/subwave (interactive wizard)"
echo "  $BIN_NAME setup          # configure Navidrome, LLM, TTS, DJ"
echo "  $BIN_NAME start          # docker compose up -d"
