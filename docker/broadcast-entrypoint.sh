#!/usr/bin/env bash
# SUB/WAVE broadcast supervisor.
#
# Bash (not /bin/sh) because we need `wait -n` to react to whichever child
# exits first. The savonet/liquidsoap base image's /bin/sh is dash, which
# lacks `wait -n`; bash is in the same image (debian) so this is free.
#
# Launches icecast2 and liquidsoap in one container and exits as soon as
# either dies, so the container's restart policy bounces the pair together.
# This replaces the earlier two-container split (subwave-icecast +
# subwave-liquidsoap) and the icecast-secrets handshake that bridged them.
#
# Boot sequence:
#   1. Pre-create the shared /var/sub-wave subdirs with mode 777 so the
#      controller (running as a different uid) can write into them. Same role
#      the old subwave-icecast entrypoint played for the wider stack — it just
#      happens to also be where this container's own state lives now.
#   2. Resolve the three ICECAST_*_PASSWORD values. Precedence (unchanged):
#        env override > persisted state/icecast-secrets.env > freshly generated.
#      The resolved values are still written back to state/icecast-secrets.env
#      for operator visibility and to keep the documented "delete the file +
#      restart to rotate" path working.
#   3. Render icecast.xml from the baked-in template.
#   4. Launch icecast2 (as icecast2 user) in the background.
#   5. Wait for icecast to accept HTTP connections (so liquidsoap doesn't
#      immediately fail its source connect).
#   6. Launch liquidsoap (as liquidsoap user) in the background with the
#      resolved ICECAST_SOURCE_PASSWORD + ICECAST_HOST=localhost in its env.
#   7. `wait -n` for whichever exits first; tear the other down; exit.

set -eu

SECRETS=/var/sub-wave/icecast-secrets.env
TEMPLATE=/etc/icecast2/icecast.xml.template
RENDERED=/etc/icecast2/icecast.xml

# ---- Bootstrap shared state dirs --------------------------------------------
# The controller container (different uid) also writes here. Mode 777 keeps
# this hands-off — operators don't have to chown bind-mount sources before
# the first boot succeeds.

mkdir -p /var/sub-wave \
         /var/sub-wave/voice \
         /var/sub-wave/voices \
         /var/sub-wave/archive \
         /var/sub-wave/jingles \
         /var/sub-wave/logs \
         /var/sub-wave/sessions \
         /var/sub-wave/sfx \
         /var/sub-wave/channels
chmod 777 /var/sub-wave \
          /var/sub-wave/voice \
          /var/sub-wave/voices \
          /var/sub-wave/archive \
          /var/sub-wave/jingles \
          /var/sub-wave/logs \
          /var/sub-wave/sessions \
          /var/sub-wave/sfx \
          /var/sub-wave/channels
# Bootstrap empty m3u files Liquidsoap's reload_mode="watch" needs to see.
touch /var/sub-wave/auto.m3u /var/sub-wave/jingles.m3u
chmod 666 /var/sub-wave/auto.m3u /var/sub-wave/jingles.m3u
# Tell a co-located Navidrome to skip the archive dir — its hourly mixdowns are
# the station's own recordings, not library tracks, and otherwise get scanned in
# as junk "HH-00" entries that confuse the DJ (issue #273). Harmless when
# Navidrome lives elsewhere / doesn't overlap this path.
touch /var/sub-wave/archive/.ndignore

# Liquidsoap writes radio.log to /var/log/liquidsoap as uid 10000. Compose
# usually bind-mounts ${STATE_DIR}/logs over this path; that bind mount lands
# owned by root on first boot, so chown it to the liquidsoap user.
mkdir -p /var/log/liquidsoap
chown -R liquidsoap:liquidsoap /var/log/liquidsoap 2>/dev/null || true

# Rotate radio.log on boot once it passes 50MB. Liquidsoap has no size-based
# rotation of its own and appends forever (200MB+ after a couple of months);
# boot is the one safe moment to move it since liquidsoap isn't holding the
# fd yet. One .old generation caps disk at ~2x the threshold.
RADIO_LOG=/var/log/liquidsoap/radio.log
if [ -f "$RADIO_LOG" ] && [ "$(stat -c %s "$RADIO_LOG" 2>/dev/null || echo 0)" -gt 52428800 ]; then
    mv -f "$RADIO_LOG" "$RADIO_LOG.old"
    echo "broadcast: rotated oversized radio.log to radio.log.old" >&2
fi

# ---- Resolve passwords ------------------------------------------------------
# Capture env values FIRST so sourcing the secrets file can't clobber them.

ENV_SRC="${ICECAST_SOURCE_PASSWORD:-}"
ENV_ADM="${ICECAST_ADMIN_PASSWORD:-}"
ENV_REL="${ICECAST_RELAY_PASSWORD:-}"

if [ -f "$SECRETS" ]; then
    # shellcheck disable=SC1090
    . "$SECRETS"
fi

# Env values win when present (operator override via root .env).
[ -n "$ENV_SRC" ] && ICECAST_SOURCE_PASSWORD="$ENV_SRC"
[ -n "$ENV_ADM" ] && ICECAST_ADMIN_PASSWORD="$ENV_ADM"
[ -n "$ENV_REL" ] && ICECAST_RELAY_PASSWORD="$ENV_REL"

# Anything still empty gets a fresh random value.
[ -z "${ICECAST_SOURCE_PASSWORD:-}" ] && ICECAST_SOURCE_PASSWORD="$(openssl rand -hex 16)"
[ -z "${ICECAST_ADMIN_PASSWORD:-}"  ] && ICECAST_ADMIN_PASSWORD="$(openssl rand -hex 16)"
[ -z "${ICECAST_RELAY_PASSWORD:-}"  ] && ICECAST_RELAY_PASSWORD="$(openssl rand -hex 16)"

cat > "$SECRETS" <<EOF
ICECAST_SOURCE_PASSWORD=$ICECAST_SOURCE_PASSWORD
ICECAST_ADMIN_PASSWORD=$ICECAST_ADMIN_PASSWORD
ICECAST_RELAY_PASSWORD=$ICECAST_RELAY_PASSWORD
EOF
# 0600: the file holds the Icecast passwords. Only root reads it — this
# entrypoint sources it (as root, before dropping to the icecast2/liquidsoap
# users via sudo -E), and the controller container (also root) reads it off the
# shared /var/sub-wave mount in broadcast/listeners.ts. No non-root reader
# needs it, so keep it owner-only.
chmod 600 "$SECRETS"

export ICECAST_SOURCE_PASSWORD ICECAST_ADMIN_PASSWORD ICECAST_RELAY_PASSWORD
# Liquidsoap connects to icecast over loopback inside this container.
# radio.liq reads ICECAST_HOST (default "icecast"); override here so the
# stock script keeps working without a code edit.
export ICECAST_HOST=localhost

# ---- Render icecast.xml -----------------------------------------------------
# Plain sed is enough for four placeholders; the secrets are hex and the
# listener cap numeric, so there's no escaping risk. Using `|` as the sed
# delimiter keeps slashes safe.

# Concurrent-listener ceiling (<limits><clients>). Empty/unset → the stock 100.
# A non-numeric value would render invalid XML and fail icecast at boot, so
# fall back to the default with a warning instead of taking the stream down.
ICECAST_MAX_CLIENTS="${ICECAST_MAX_CLIENTS:-100}"
case "$ICECAST_MAX_CLIENTS" in
    *[!0-9]*|'')
        echo "broadcast: ICECAST_MAX_CLIENTS='$ICECAST_MAX_CLIENTS' is not a number — using 100" >&2
        ICECAST_MAX_CLIENTS=100
        ;;
esac

# Listener buffer depth (<burst-size>) — audio bursted to a client on connect
# so a coverage gap drains the buffer instead of stalling (issue #993).
#
# Sized in SECONDS and converted to bytes here, because burst-size is a byte
# count and a fixed one means wildly different depths per bitrate: the old
# hardcoded 512 KB was ~22s at 192k but ~66s at 64k, so the stations least able
# to afford lag got the most of it (issue #1114). Deriving from the live
# bitrate keeps the depth an operator picks the depth they actually get.
#
# Sources, in precedence order: env override > settings (written by the
# controller on save) > default. Read from the shared state dir rather than
# passed in, so a settings change applies on the next broadcast bounce with no
# compose edit.
read_state_num() {
    # $1 = filename, $2 = fallback. Non-numeric or missing → fallback.
    _v=$(cat "/var/sub-wave/$1" 2>/dev/null || true)
    case "$_v" in
        ''|*[!0-9]*) echo "$2" ;;
        *) echo "$_v" ;;
    esac
}

STREAM_BITRATE="${ICECAST_STREAM_BITRATE:-$(read_state_num liquidsoap_stream_bitrate.txt 192)}"
BUFFER_SECONDS="${ICECAST_BUFFER_SECONDS:-$(read_state_num liquidsoap_stream_buffer_seconds.txt 22)}"
case "$STREAM_BITRATE" in *[!0-9]*|'') STREAM_BITRATE=192 ;; esac
case "$BUFFER_SECONDS" in *[!0-9]*|'') BUFFER_SECONDS=22 ;; esac
[ "$BUFFER_SECONDS" -gt 60 ] && BUFFER_SECONDS=60

# kbps → bytes/sec is bitrate * 1000 / 8 = bitrate * 125.
ICECAST_BURST_SIZE=$(( BUFFER_SECONDS * STREAM_BITRATE * 125 ))

# queue-size is the per-client backlog before Icecast drops a lagging listener.
# It must comfortably exceed burst-size or a client is evicted the moment it
# falls behind its own primed buffer. 4x the burst (floored at the historical
# 2 MB) preserves the ~minute of rope issue #993 wanted at the default depth
# while still scaling with a deeper buffer.
ICECAST_QUEUE_SIZE=$(( ICECAST_BURST_SIZE * 4 ))
[ "$ICECAST_QUEUE_SIZE" -lt 2097152 ] && ICECAST_QUEUE_SIZE=2097152

echo "broadcast: listener buffer ${BUFFER_SECONDS}s @ ${STREAM_BITRATE}kbps" \
     "→ burst-size ${ICECAST_BURST_SIZE}B, queue-size ${ICECAST_QUEUE_SIZE}B" >&2

# Listener auth (#478). The controller writes state/icecast_listener_auth.txt
# ('true'/'false') from settings.privacy.listenerAuth; only the literal value
# "true" enables (mirroring the archive_enabled pattern — missing/garbled file
# means public). When enabled, every stream mount gets an
# <authentication type="url"> block: icecast POSTs each listener connect to
# the controller, which admits it with an `icecast-auth-user: 1` header. The
# password itself lives ONLY in the controller's settings.json — password
# changes apply live, and this render only matters when the toggle flips
# (which the admin UI routes through the existing restart-mixer flow).
LISTENER_AUTH_FLAG=/var/sub-wave/icecast_listener_auth.txt
LISTENER_AUTH_URL="${LISTENER_AUTH_URL:-http://controller:7701/listener-auth}"
MOUNTS_XML=/etc/icecast2/listener-auth-mounts.xml
: > "$MOUNTS_XML"
if [ "$(cat "$LISTENER_AUTH_FLAG" 2>/dev/null | tr -d '[:space:]')" = "true" ]; then
    echo "broadcast: listener auth ON — mounts require credentials via $LISTENER_AUTH_URL" >&2
    for MOUNT in /stream.mp3 /stream.opus /stream.flac /stream.aac; do
        cat >> "$MOUNTS_XML" <<EOF
    <mount type="normal">
        <mount-name>$MOUNT</mount-name>
        <authentication type="url">
            <option name="listener_add" value="$LISTENER_AUTH_URL"/>
            <option name="auth_header" value="icecast-auth-user: 1"/>
        </authentication>
    </mount>
EOF
    done
    # Channel mounts (/ch/<id>/stream.mp3) are spawned at runtime by the
    # channel supervisor — possibly AFTER this render — so they can't be
    # enumerated here. A default mount carries the same auth for every mount
    # without an explicit block above, present or future.
    cat >> "$MOUNTS_XML" <<EOF
    <mount type="default">
        <authentication type="url">
            <option name="listener_add" value="$LISTENER_AUTH_URL"/>
            <option name="auth_header" value="icecast-auth-user: 1"/>
        </authentication>
    </mount>
EOF
fi

# `r` splices the generated mount blocks (empty file = nothing) where the
# marker sits, then the marker line itself is deleted.
sed \
    -e "s|\${ICECAST_SOURCE_PASSWORD}|$ICECAST_SOURCE_PASSWORD|g" \
    -e "s|\${ICECAST_ADMIN_PASSWORD}|$ICECAST_ADMIN_PASSWORD|g" \
    -e "s|\${ICECAST_RELAY_PASSWORD}|$ICECAST_RELAY_PASSWORD|g" \
    -e "s|\${ICECAST_MAX_CLIENTS}|$ICECAST_MAX_CLIENTS|g" \
    -e "s|\${ICECAST_BURST_SIZE}|$ICECAST_BURST_SIZE|g" \
    -e "s|\${ICECAST_QUEUE_SIZE}|$ICECAST_QUEUE_SIZE|g" \
    -e "/<!--@LISTENER_AUTH_MOUNTS@-->/r $MOUNTS_XML" \
    -e "/<!--@LISTENER_AUTH_MOUNTS@-->/d" \
    "$TEMPLATE" > "$RENDERED"
chown icecast2 "$RENDERED" 2>/dev/null || true

# ---- Launch icecast in the background --------------------------------------

echo "broadcast: starting icecast2" >&2
sudo -E -u icecast2 icecast2 -n -c "$RENDERED" &
ICECAST_PID=$!

# Wait up to ~10s for icecast to accept HTTP. Without this, liquidsoap can
# beat icecast to the punch and bail with "Cannot connect to remote host" on
# its very first source connect.
for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS http://localhost:7702/ > /dev/null 2>&1; then
        echo "broadcast: icecast accepting connections after ${i}s" >&2
        break
    fi
    sleep 1
done

# ---- Launch liquidsoap in the background -----------------------------------

echo "broadcast: starting liquidsoap" >&2
# TEMPORARY (re-harden later): run liquidsoap as root instead of dropping to
# the `liquidsoap` user. The savonet base image bump 2.2.5 -> 2.4.4 changed the
# `liquidsoap` user's uid (10000 -> 100), so the persisted state files under the
# bind-mounted /var/sub-wave (e.g. now-playing.json, owned 10000:10001 mode 644
# by the old image) became unwritable to uid 100 — every on_meta write EACCES'd
# and the UI froze one song behind. Root ignores those perms. Restore the
# privilege drop once the state files are chowned to the new liquidsoap uid
# (needs settings.init.allow_root reverted in radio.liq too).
liquidsoap /etc/liquidsoap/radio.liq &
LIQ_PID=$!

# ---- Sub-station channel supervisor -----------------------------------------
# state/channels.json (written by the controller's settings layer) lists the
# enabled sub-station channels: {"channels":[{"id":"kids","telnetPort":1235}]}.
# A background reconciler diffs running channel liquidsoaps against it every
# 15s — spawn new, kill removed, respawn dead — so adding a channel in the
# admin UI goes on air without a container restart. Channel processes are NOT
# fate-shared with the main pair: only icecast/main-liquidsoap death restarts
# the container (channels are respawned by the reconciler after it).
# Each child runs the SAME radio.liq, parameterized by env (see the
# SUB-STATION PARAMETERS block at the top of radio.liq).

reconcile_channels() {
    local manifest=/var/sub-wave/channels.json
    local want=""
    if [ -f "$manifest" ]; then
        # -> "id port" per line. jq failure (half-written file) = keep current.
        want=$(jq -r '.channels[]? | "\(.id) \(.telnetPort)"' "$manifest" 2>/dev/null) || return 0
    fi

    # Kill children that left the manifest / changed port; forget dead ones.
    local id
    for id in "${!CHANNEL_PIDS[@]}"; do
        local keep=0 wid wport
        while read -r wid wport; do
            [ "$wid" = "$id" ] && [ "$wport" = "${CHANNEL_PORTS[$id]}" ] && keep=1
        done <<< "$want"
        if ! kill -0 "${CHANNEL_PIDS[$id]}" 2>/dev/null; then
            echo "broadcast: channel '$id' liquidsoap died — will respawn" >&2
            unset "CHANNEL_PIDS[$id]" "CHANNEL_PORTS[$id]"
        elif [ "$keep" = 0 ]; then
            echo "broadcast: stopping channel '$id' (removed from manifest)" >&2
            kill -TERM "${CHANNEL_PIDS[$id]}" 2>/dev/null || true
            unset "CHANNEL_PIDS[$id]" "CHANNEL_PORTS[$id]"
        fi
    done

    # Spawn manifest entries with no live child. Ids/ports are validated by
    # the controller, but sanitize anyway — they become paths and env values.
    local wid wport
    while read -r wid wport; do
        [ -n "$wid" ] || continue
        case "$wid" in *[!a-z0-9-]*) continue ;; esac
        case "$wport" in ''|*[!0-9]*) continue ;; esac
        if [ -z "${CHANNEL_PIDS[$wid]:-}" ]; then
            local cdir=/var/sub-wave/channels/$wid
            mkdir -p "$cdir"
            chmod 777 "$cdir" 2>/dev/null || true
            # reload_mode="watch" playlists need the files to exist at boot.
            touch "$cdir/auto.m3u" "$cdir/jingles.m3u"
            chmod 666 "$cdir/auto.m3u" "$cdir/jingles.m3u" 2>/dev/null || true
            echo "broadcast: starting channel '$wid' liquidsoap (telnet :$wport, mount /ch/$wid)" >&2
            CHANNEL_STATE="$cdir" MOUNT_PREFIX="/ch/$wid" TELNET_PORT="$wport" CHANNEL_ID="$wid" \
                liquidsoap /etc/liquidsoap/radio.liq &
            CHANNEL_PIDS[$wid]=$!
            CHANNEL_PORTS[$wid]=$wport
        fi
    done <<< "$want"
}

channel_supervisor() {
    declare -A CHANNEL_PIDS CHANNEL_PORTS
    stop_channels() {
        local id
        for id in "${!CHANNEL_PIDS[@]}"; do
            kill -TERM "${CHANNEL_PIDS[$id]}" 2>/dev/null || true
        done
        exit 0
    }
    trap stop_channels INT TERM
    while true; do
        reconcile_channels
        # Interruptible sleep so TERM tears channels down promptly.
        sleep 15 &
        wait $! || true
    done
}

channel_supervisor &
CHANNELS_PID=$!

# ---- Wait for either to die, then exit -------------------------------------
# `wait -n` is a bash builtin (and not yet in dash, which is /bin/sh on the
# savonet image — hence the bash shebang at the top). If either child exits,
# kill the other and propagate the exit code so docker restarts the container.

trap 'kill -TERM "$ICECAST_PID" "$LIQ_PID" "$CHANNELS_PID" 2>/dev/null || true' INT TERM

wait -n "$ICECAST_PID" "$LIQ_PID"
EXIT=$?

echo "broadcast: child exited ($EXIT) — taking the others down" >&2
kill -TERM "$ICECAST_PID" "$LIQ_PID" "$CHANNELS_PID" 2>/dev/null || true
wait 2>/dev/null || true

exit "$EXIT"
