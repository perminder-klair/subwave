#!/usr/bin/env bash
# librespot wrapper — the command Liquidsoap's input.external.rawaudio runs in
# spotify mode (radio.liq). librespot is a headless Spotify Connect receiver; its
# `pipe` backend writes raw stereo S16LE 44.1 kHz PCM to STDOUT, which Liquidsoap
# reads as the music source. Everything this script prints goes to STDERR so the
# PCM stream stays clean.
#
# Liquidsoap restarts the command when it exits (restart=true, and after
# restart_delay_on_error when it exits non-zero), so this script does one run
# and gets out of the way; the backoff is the mixer's.
#
# Auth (librespot ≥0.5, password login is gone): the controller writes an
# access token to state/spotify/token — minted for Spotify's OWN desktop client
# id via the admin "Sign the receiver in" flow (a token from the operator's
# Developer app authenticates but is refused at the Connect handshake with
# INVALID_CREDENTIALS; measured on 0.8.0). librespot then caches reusable
# credentials under state/spotify/cache and later runs need neither. A token
# file NEWER than the cache wins and the cache is dropped: a cache built from a
# bad token would otherwise be preferred forever.
#
# Watchdog (from lounge/tuify's librespot supervision): an "Audio key response
# timeout" followed by "Spirc shut down unexpectedly" or "Unable to read audio
# file" is a session that reconnected internally but can no longer play — kill
# it so the mixer's restart gives a clean login.
set -u

STATE_DIR="${SUBWAVE_STATE_DIR:-/var/sub-wave}"
SP_DIR="$STATE_DIR/spotify"
CACHE_DIR="$SP_DIR/cache"
TOKEN_FILE="$SP_DIR/token"
CFG_FILE="$STATE_DIR/liquidsoap_spotify.txt"
EVENT_SCRIPT="${LIBRESPOT_EVENT_SCRIPT:-/app/spotify/librespot-event.sh}"
BIN="${LIBRESPOT_BIN:-librespot}"

# Everything the receiver says also goes to a file the operator can read: the
# wrapper's stderr belongs to Liquidsoap's process, which does not forward it to
# the container log, so "why did it exit 1" was invisible from outside.
LOG_FILE="$STATE_DIR/logs/librespot.log"
logf() {
    if [ -d "$STATE_DIR/logs" ]; then
        printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG_FILE" 2>/dev/null || true
        # ~1 MB cap: keep the newest half when it grows past it.
        if [ "$(wc -c < "$LOG_FILE" 2>/dev/null || echo 0)" -gt 1048576 ]; then
            tail -n 2000 "$LOG_FILE" > "$LOG_FILE.tmp" 2>/dev/null && mv -f "$LOG_FILE.tmp" "$LOG_FILE"
        fi
    fi
}
log() { printf 'librespot-run: %s\n' "$*" >&2; logf "librespot-run: $*"; }

mkdir -p "$CACHE_DIR" 2>/dev/null || true
chmod 700 "$CACHE_DIR" 2>/dev/null || true

# Handoff from settings.update() (settings/liquidsoap.ts): KEY=value lines.
DEVICE_NAME=""
BITRATE=320
if [ -f "$CFG_FILE" ]; then
    while IFS='=' read -r k v; do
        case "$k" in
            device_name) DEVICE_NAME="$v" ;;
            bitrate) BITRATE="$v" ;;
        esac
    done < "$CFG_FILE"
fi
# Constant default — NOT the station name; see settings/liquidsoap.ts.
[ -z "$DEVICE_NAME" ] && DEVICE_NAME="SUB/WAVE"
case "$BITRATE" in 96|160|320) ;; *) BITRATE=320 ;; esac

if ! command -v "$BIN" >/dev/null 2>&1; then
    log "librespot binary not found ($BIN) — rebuild the broadcast image"
    sleep 30
    exit 2
fi

args=(
    --name "$DEVICE_NAME"
    --backend pipe
    --format S16
    --bitrate "$BITRATE"
    --cache "$CACHE_DIR"
    --disable-audio-cache
    --initial-volume 100
    --volume-ctrl fixed
    --enable-volume-normalisation
    --onevent "$EVENT_SCRIPT"
)
# --autoplay is deliberately NOT passed: the station picks every track.

# A token newer than the cached credentials replaces them (a re-sign-in).
if [ -f "$CACHE_DIR/credentials.json" ] && [ -f "$TOKEN_FILE" ] && [ "$TOKEN_FILE" -nt "$CACHE_DIR/credentials.json" ]; then
    log "token file is newer than the credential cache — signing in afresh"
    rm -f "$CACHE_DIR/credentials.json"
fi

if [ ! -f "$CACHE_DIR/credentials.json" ]; then
    if [ -f "$TOKEN_FILE" ]; then
        tok="$(sed -n 1p "$TOKEN_FILE" | tr -d '\r')"
        exp="$(sed -n 2p "$TOKEN_FILE" | tr -d '\r')"
        now_ms="$(date +%s)000"
        if [ -n "$tok" ] && [ "${exp:-0}" -gt "$now_ms" ] 2>/dev/null; then
            args+=(--access-token "$tok")
            log "first login with the controller's access token"
        else
            log "token file is stale or empty — waiting for the controller to refresh it (is the controller running and Spotify connected?)"
            sleep 15
            exit 3
        fi
    else
        log "no cached credentials and no token file — connect Spotify in admin → Settings → Music source"
        sleep 15
        exit 3
    fi
fi

# The name this receiver is REGISTERING with, for the controller to resolve
# the device by (state/spotify/device-name). The truth lives here, not in the
# settings: the handoff file can change while this process keeps its name.
printf '%s\n' "$DEVICE_NAME" > "$SP_DIR/device-name" 2>/dev/null || true
log "starting: device \"$DEVICE_NAME\", ${BITRATE} kbps"
rm -f "$SP_DIR/.audiokey-timeout"

# stderr → log with a watchdog; stdout (PCM) passes straight through to Liquidsoap.
"$BIN" "${args[@]}" 2> >(
    while IFS= read -r line; do
        printf '[librespot] %s\n' "$line" >&2
        logf "$line"
        case "$line" in
            *"Authenticated as"*) rm -f "$SP_DIR/.audiokey-timeout" ;;
            *"Audio key response timeout"*) : > "$SP_DIR/.audiokey-timeout" ;;
            *"Spirc shut down unexpectedly"*|*"Unable to read audio file"*)
                if [ -e "$SP_DIR/.audiokey-timeout" ]; then
                    log "broken session detected (audio key timeout + ${line%% *}) — killing for a clean restart"
                    # No procps in the image: the main script records the pid.
                    kill -TERM "$(cat "$SP_DIR/.pid" 2>/dev/null)" 2>/dev/null || true
                fi ;;
        esac
    done
) &
pid=$!
echo "$pid" > "$SP_DIR/.pid"
trap 'kill -TERM "$pid" 2>/dev/null' TERM INT
wait "$pid"
rc=$?
rm -f "$SP_DIR/.audiokey-timeout" "$SP_DIR/.pid"
log "exited with status $rc"
exit "$rc"
