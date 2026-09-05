#!/usr/bin/env bash
# SUB/WAVE broadcast supervisor: resolves the icecast secrets, renders
# icecast.xml, launches icecast2 + liquidsoap, and exits as soon as either dies
# so the container's restart policy bounces the pair together.
#
# Bash (not /bin/sh) because we need `wait -n`; the base image's /bin/sh is
# dash, which lacks it.

set -eu

# ---- Shared state bootstrap -------------------------------------------------
# Mode 777 because the controller, analyzer and liquidsoap write here as OTHER
# uids; without it an operator must chown every bind-mount source by hand.
#
# NOTHING in here is fatal (#1300 bug 10). Under `set -eu` the old bulk
# `mkdir -p a b c` / `chmod 777 a b c` made every state path load-bearing: one
# on a mount that refuses the change (read-only bind, NFS export, the
# exFAT/NTFS disk people move the stem cache to) aborted this script BEFORE
# icecast started, and compose reported only `dependency failed to start:
# container sub-wave-broadcast is unhealthy` — naming neither path nor cause.
# A station running on a degraded mount still serves and still airs the
# emergency loop; an exited container airs nothing.
#
# docker/aio/supervisor.sh keeps the same functions, list and messages;
# scripts/state-bootstrap.test.ts drives both through one table.
state_warn() { echo "broadcast: WARNING $*" >&2; }

# True when `other` can write the dir. The warning keys on this rather than on
# chmod's exit status: a mount that is already world-writable and merely
# refuses chmod is a WORKING config, and a line printed on every healthy boot
# is a line operators learn to skip.
state_writable_by_others() {
    case "$(stat -c %a "$1" 2>/dev/null || echo 0)" in
        *[2367]) return 0 ;;
        *) return 1 ;;
    esac
}

state_prepare_dir() {
    local p=$1
    mkdir -p "$p" 2>/dev/null || true
    if [ ! -d "$p" ]; then
        state_warn "state dir $p could not be created — a read-only or unwritable mount; the station boots, but anything writing there will fail"
        return 0
    fi
    chmod 777 "$p" 2>/dev/null || true
    if [ ! -w "$p" ] || ! state_writable_by_others "$p"; then
        state_warn "state dir $p is mode $(stat -c %a "$p" 2>/dev/null || echo '?') and chmod could not change it — the controller and analyzer containers write there as other uids; chown/chmod it on the host"
    fi
    return 0
}

state_prepare_file() {
    local p=$1
    local mode=${2:-}
    touch "$p" 2>/dev/null || true
    if [ ! -f "$p" ]; then
        state_warn "state file $p could not be created — a read-only or unwritable mount"
        return 0
    fi
    [ -n "$mode" ] && chmod "$mode" "$p" 2>/dev/null || true
    return 0
}

bootstrap_state_dirs() {
    local root=$1
    local dir=$2
    local sub
    state_prepare_dir "$root"
    state_prepare_dir "$dir"
    # stems + transitions are the analyzer's (uid 10001), and the only two
    # dirs worth relocating to a bigger disk. A fresh bind mount lands
    # root-owned 755, which the analyzer cannot write without the same 777
    # treatment as the rest.
    for sub in voice voices archive jingles logs sessions sfx stems transitions; do
        state_prepare_dir "$dir/$sub"
    done
    # A RELOCATED stem cache (STEMS_DIR in .env, handed down as the container
    # path SUBWAVE_STEMS_DIR) sits outside $dir, so the loop above never
    # reaches it and the bind mount would keep its root-owned 755 — the exact
    # state the loop entry above exists to prevent. Per-station subdirs under
    # it are created by the analyzer itself, which inherits this 777.
    if [ -n "${SUBWAVE_STEMS_DIR:-}" ]; then
        state_prepare_dir "$SUBWAVE_STEMS_DIR"
    fi
    # Liquidsoap's reload_mode="watch" playlists need the files to exist.
    state_prepare_file "$dir/auto.m3u" 666
    state_prepare_file "$dir/jingles.m3u" 666
    # Keep a co-located Navidrome from scanning the hourly archive mixdowns in
    # as junk "HH-00" tracks (issue #273). Harmless when paths don't overlap.
    state_prepare_file "$dir/archive/.ndignore"
    return 0
}

# Listener buffer depth comes only from the controller-written handoff. An env
# override would change Icecast's real burst without changing /now-playing or
# voice-event timing, putting every listener-facing clock on the wrong offset.
read_state_num() {
    # $1 = filename, $2 = fallback. Non-numeric or missing → fallback.
    _v=$(cat "$STATE_DIR/$1" 2>/dev/null || true)
    case "$_v" in
        ''|*[!0-9]*) echo "$2" ;;
        *) echo "$_v" ;;
    esac
}

stream_buffer_seconds() {
    read_state_num liquidsoap_stream_buffer_seconds.txt 22
}

# Concurrent-listener ceiling (Icecast <limits><clients>). Two sources, and the
# ENV one WINS: ICECAST_MAX_CLIENTS shipped long before the setting and is wired
# into all three compose files, so demoting it would silently change a
# configured station on upgrade. The setting
# (stream.maxListeners -> liquidsoap_icecast_max_clients.txt) is what reaches
# AIO/Unraid, where there is no .env to put the var in at all.
#
# Echoes "<value> <source>" so the caller can LOG which source won. An operator
# editing the admin field on a station whose .env pins the var otherwise sees
# the number save and nothing happen.
#
# A non-numeric or zero value would render a station nobody can tune into (or
# invalid XML), so either source falls back to 100 rather than failing icecast
# at boot. docker/aio/supervisor.sh carries the same function; both are driven
# from one table by scripts/max-listeners.test.ts.
resolve_max_clients() {
    _src=ICECAST_MAX_CLIENTS
    _v="${ICECAST_MAX_CLIENTS:-}"
    if [ -z "$_v" ]; then
        _src=settings
        _v=$(read_state_num liquidsoap_icecast_max_clients.txt 100)
    fi
    case "$_v" in
        *[!0-9]*|''|0) echo "100 fallback:$_v@$_src" ;;
        *) echo "$_v $_src" ;;
    esac
}

# Sourcing with SUBWAVE_BROADCAST_LIB=1 defines the helpers above WITHOUT
# booting a station, so scripts/state-bootstrap.test.ts can drive them.
if [ "${SUBWAVE_BROADCAST_LIB:-}" = "1" ]; then
    return 0 2>/dev/null || exit 0
fi

# ---- Multi-station pointer resolution ---------------------------------------
# state/stations/active.json ({"activeId":"<slug>"}) picks the station dir this
# boot serves; install-level files (icecast secrets) stay at $STATE_ROOT. No jq
# in this image — the sed matches the controller's canonical output and the
# slug charset [a-z0-9-]; a hand-mangled file falls back to the root.
STATE_ROOT=/var/sub-wave
STATE_DIR="$STATE_ROOT"
ACTIVE_FILE="$STATE_ROOT/stations/active.json"
if [ -f "$ACTIVE_FILE" ]; then
    ACTIVE_ID=$(sed -n 's/.*"activeId"[[:space:]]*:[[:space:]]*"\([a-z0-9][a-z0-9-]\{0,40\}\)".*/\1/p' "$ACTIVE_FILE" | head -n1)
    if [ -n "$ACTIVE_ID" ] && [ -d "$STATE_ROOT/stations/$ACTIVE_ID" ]; then
        STATE_DIR="$STATE_ROOT/stations/$ACTIVE_ID"
        echo "broadcast: active station '$ACTIVE_ID' → $STATE_DIR" >&2
    else
        echo "broadcast: WARNING stations/active.json unresolvable (id='$ACTIVE_ID') — using root" >&2
    fi
fi
export SUBWAVE_STATE_DIR="$STATE_DIR"

SECRETS=$STATE_ROOT/icecast-secrets.env
TEMPLATE=/etc/icecast2/icecast.xml.template
RENDERED=/etc/icecast2/icecast.xml

bootstrap_state_dirs "$STATE_ROOT" "$STATE_DIR"

# The compose logs bind mount lands owned by root on first boot; liquidsoap
# (uid 10000) writes radio.log there.
mkdir -p /var/log/liquidsoap
chown -R liquidsoap:liquidsoap /var/log/liquidsoap 2>/dev/null || true

# Rotate radio.log on boot once it passes 50MB — liquidsoap has no size-based
# rotation and appends forever; boot is the one safe moment (fd not yet held).
# One .old generation caps disk at ~2x the threshold.
RADIO_LOG=/var/log/liquidsoap/radio.log
if [ -f "$RADIO_LOG" ] && [ "$(stat -c %s "$RADIO_LOG" 2>/dev/null || echo 0)" -gt 52428800 ]; then
    mv -f "$RADIO_LOG" "$RADIO_LOG.old"
    echo "broadcast: rotated oversized radio.log to radio.log.old" >&2
fi

# ---- Resolve passwords ------------------------------------------------------
# Precedence: env override > persisted secrets file > freshly generated.
# Capture env values FIRST so sourcing the secrets file can't clobber them.

ENV_SRC="${ICECAST_SOURCE_PASSWORD:-}"
ENV_ADM="${ICECAST_ADMIN_PASSWORD:-}"
ENV_REL="${ICECAST_RELAY_PASSWORD:-}"

if [ -f "$SECRETS" ]; then
    # shellcheck disable=SC1090
    . "$SECRETS"
fi

[ -n "$ENV_SRC" ] && ICECAST_SOURCE_PASSWORD="$ENV_SRC"
[ -n "$ENV_ADM" ] && ICECAST_ADMIN_PASSWORD="$ENV_ADM"
[ -n "$ENV_REL" ] && ICECAST_RELAY_PASSWORD="$ENV_REL"

[ -z "${ICECAST_SOURCE_PASSWORD:-}" ] && ICECAST_SOURCE_PASSWORD="$(openssl rand -hex 16)"
[ -z "${ICECAST_ADMIN_PASSWORD:-}"  ] && ICECAST_ADMIN_PASSWORD="$(openssl rand -hex 16)"
[ -z "${ICECAST_RELAY_PASSWORD:-}"  ] && ICECAST_RELAY_PASSWORD="$(openssl rand -hex 16)"

# Written back for operator visibility + the documented "delete + restart to
# rotate" path.
cat > "$SECRETS" <<EOF
ICECAST_SOURCE_PASSWORD=$ICECAST_SOURCE_PASSWORD
ICECAST_ADMIN_PASSWORD=$ICECAST_ADMIN_PASSWORD
ICECAST_RELAY_PASSWORD=$ICECAST_RELAY_PASSWORD
EOF
# 0600 — only root reads it (this entrypoint, and the controller container off
# the shared mount in broadcast/listeners.ts).
chmod 600 "$SECRETS"

export ICECAST_SOURCE_PASSWORD ICECAST_ADMIN_PASSWORD ICECAST_RELAY_PASSWORD
# Liquidsoap connects over loopback inside this container; radio.liq reads
# ICECAST_HOST (default "icecast").
export ICECAST_HOST=localhost

# ---- Render icecast.xml -----------------------------------------------------
# Substitution is plain sed with `|` delimiters — the secrets are hex and every
# other value numeric, so there's no escaping risk.

# Concurrent-listener ceiling — see resolve_max_clients above for the two
# sources and why env wins.
MAX_CLIENTS_LINE="$(resolve_max_clients)"
ICECAST_MAX_CLIENTS="${MAX_CLIENTS_LINE%% *}"
echo "broadcast: max listeners $ICECAST_MAX_CLIENTS (from ${MAX_CLIENTS_LINE#* })" >&2

# Listener buffer depth (<burst-size>, #993/#1114). Sized in SECONDS and
# converted per bitrate here, because burst-size is a byte count — a fixed one
# means wildly different depths per mount (512 KB is ~22s at 192k, ~66s at
# 64k). Read from controller-written state so the real and advertised depths
# stay identical; a settings change applies on the next container bounce.
STREAM_BITRATE="${ICECAST_STREAM_BITRATE:-$(read_state_num liquidsoap_stream_bitrate.txt 192)}"
BUFFER_SECONDS="$(stream_buffer_seconds)"
case "$STREAM_BITRATE" in *[!0-9]*|'') STREAM_BITRATE=192 ;; esac
case "$BUFFER_SECONDS" in *[!0-9]*|'') BUFFER_SECONDS=22 ;; esac
[ "$BUFFER_SECONDS" -gt 60 ] && BUFFER_SECONDS=60

# FLAC is VBR with no bitrate setting — ~900 kbps is a typical average for
# 44.1/16 stereo, close enough for a buffer depth.
OPUS_BITRATE="${ICECAST_OPUS_BITRATE:-$(read_state_num liquidsoap_opus_bitrate.txt 96)}"
AAC_BITRATE="${ICECAST_AAC_BITRATE:-$(read_state_num liquidsoap_aac_bitrate.txt 192)}"
case "$OPUS_BITRATE" in *[!0-9]*|'') OPUS_BITRATE=96 ;; esac
case "$AAC_BITRATE" in *[!0-9]*|'') AAC_BITRATE=192 ;; esac
FLAC_BITRATE_EST=900

# kbps → bytes/sec is bitrate * 1000 / 8 = bitrate * 125.
ICECAST_BURST_SIZE=$(( BUFFER_SECONDS * STREAM_BITRATE * 125 ))

# queue-size is the per-client backlog before Icecast drops a lagging listener.
# It must comfortably exceed burst-size or a client is evicted the moment it
# falls behind its own primed buffer; 4x (floored at the historical 2 MB)
# preserves #993's ~minute of rope while scaling with a deeper buffer.
ICECAST_QUEUE_SIZE=$(( ICECAST_BURST_SIZE * 4 ))
[ "$ICECAST_QUEUE_SIZE" -lt 2097152 ] && ICECAST_QUEUE_SIZE=2097152

echo "broadcast: listener buffer ${BUFFER_SECONDS}s @ mp3 ${STREAM_BITRATE}kbps" \
     "/ opus ${OPUS_BITRATE}kbps / aac ${AAC_BITRATE}kbps / flac ~${FLAC_BITRATE_EST}kbps" >&2

# Listener auth (#478): only a literal 'true' in the controller-written flag
# enables (missing/garbled → public). Each stream mount then gets an
# <authentication type="url"> block; icecast POSTs listener connects to the
# controller. The password lives ONLY in settings.json — changes apply live;
# this render only matters when the toggle flips (which rides restart-mixer).
LISTENER_AUTH_FLAG=$STATE_DIR/icecast_listener_auth.txt
LISTENER_AUTH_URL="${LISTENER_AUTH_URL:-http://controller:7701/listener-auth}"
LISTENER_AUTH=false
if [ "$(cat "$LISTENER_AUTH_FLAG" 2>/dev/null | tr -d '[:space:]')" = "true" ]; then
    LISTENER_AUTH=true
    echo "broadcast: listener auth ON — mounts require credentials via $LISTENER_AUTH_URL" >&2
fi

# One <mount> block per stream mount, ALWAYS rendered (not just under auth):
# burst-size is a byte count, so the global <limits> value — sized for MP3 —
# lands wildly wrong on the other mounts (22s of mp3-192k is ~43s of opus-96k
# and ~6s of FLAC). Per-mount queue-size scales for the same reason.
MOUNTS_XML=/etc/icecast2/stream-mounts.xml
: > "$MOUNTS_XML"
emit_mount() {
    # $1 = mount path, $2 = kbps used to size this mount's burst
    _burst=$(( BUFFER_SECONDS * $2 * 125 ))
    _queue=$(( _burst * 4 ))
    [ "$_queue" -lt 2097152 ] && _queue=2097152
    echo "broadcast:   $1 @ ${2}kbps → burst-size ${_burst}B, queue-size ${_queue}B" >&2
    {
        echo '    <mount type="normal">'
        echo "        <mount-name>$1</mount-name>"
        echo "        <burst-size>$_burst</burst-size>"
        echo "        <queue-size>$_queue</queue-size>"
        if [ "$LISTENER_AUTH" = true ]; then
            echo '        <authentication type="url">'
            echo "            <option name=\"listener_add\" value=\"$LISTENER_AUTH_URL\"/>"
            echo '            <option name="auth_header" value="icecast-auth-user: 1"/>'
            echo '        </authentication>'
        fi
        echo '    </mount>'
    } >> "$MOUNTS_XML"
}
emit_mount /stream.mp3  "$STREAM_BITRATE"
emit_mount /stream.opus "$OPUS_BITRATE"
emit_mount /stream.flac "$FLAC_BITRATE_EST"
emit_mount /stream.aac  "$AAC_BITRATE"

# Trusted reverse proxies — real listener IPs in admin → Listeners instead of
# the edge's container address. icecast-KH matches an EXACT IP only (a CIDR is
# accepted and then silently never matches), so the address must be resolved.
# ICECAST_TRUSTED_PROXY_IPS (explicit) wins over DNS for
# ICECAST_TRUSTED_PROXY_HOSTS (default 'caddy', the bundled edge).
#
# The DNS path is deliberately best-effort and misses the first cold boot:
# caddy depends_on this container being healthy, so the name cannot resolve
# yet — every later restart picks it up. A miss degrades to the old behaviour
# (proxy IP shown), never to a wrong IP. For first-boot accuracy, pin the edge
# and set ICECAST_TRUSTED_PROXY_IPS (docs/deployment.md).
TRUSTED_XML=/etc/icecast2/trusted-proxies.xml
: > "$TRUSTED_XML"
TRUSTED_LIST=""
if [ -n "${ICECAST_TRUSTED_PROXY_IPS:-}" ]; then
    TRUSTED_LIST=$(echo "$ICECAST_TRUSTED_PROXY_IPS" | tr ',' ' ')
else
    for _host in $(echo "${ICECAST_TRUSTED_PROXY_HOSTS:-caddy}" | tr ',' ' '); do
        # ahosts, not hosts: `getent hosts` returns ONE address family, so on a
        # dual-stack network it can hand back only the IPv6 while Caddy dials
        # icecast over IPv4 — and the exact-IP match then never fires.
        _found=$(getent ahosts "$_host" 2>/dev/null | awk '{print $1}' | sort -u || true)
        [ -n "$_found" ] && TRUSTED_LIST="$TRUSTED_LIST $_found"
    done
fi

# Only hex/dot/colon runs are addresses. A malformed entry is dropped rather
# than interpolated — invalid XML here would turn a cosmetic setting into a
# station that won't boot.
TRUSTED_COUNT=0
for _ip in $TRUSTED_LIST; do
    case "$_ip" in
        ''|*[!0-9a-fA-F.:]*)
            echo "broadcast: WARNING ignoring malformed trusted proxy '$_ip'" >&2
            continue
            ;;
    esac
    echo "        <x-forwarded-for>$_ip</x-forwarded-for>" >> "$TRUSTED_XML"
    TRUSTED_COUNT=$(( TRUSTED_COUNT + 1 ))
done
if [ "$TRUSTED_COUNT" -gt 0 ]; then
    echo "broadcast: trusting X-Forwarded-For from$(sed 's/.*<x-forwarded-for>/ /;s|</x-forwarded-for>||' "$TRUSTED_XML" | tr '\n' ' ')" >&2
else
    echo "broadcast: no trusted proxy resolved — listener IPs will show the connecting peer" >&2
fi

# `r` splices the generated blocks (empty file = nothing) where each marker
# sits, then the marker line itself is deleted.
sed \
    -e "s|\${ICECAST_SOURCE_PASSWORD}|$ICECAST_SOURCE_PASSWORD|g" \
    -e "s|\${ICECAST_ADMIN_PASSWORD}|$ICECAST_ADMIN_PASSWORD|g" \
    -e "s|\${ICECAST_RELAY_PASSWORD}|$ICECAST_RELAY_PASSWORD|g" \
    -e "s|\${ICECAST_MAX_CLIENTS}|$ICECAST_MAX_CLIENTS|g" \
    -e "s|\${ICECAST_BURST_SIZE}|$ICECAST_BURST_SIZE|g" \
    -e "s|\${ICECAST_QUEUE_SIZE}|$ICECAST_QUEUE_SIZE|g" \
    -e "/<!--@STREAM_MOUNTS@-->/r $MOUNTS_XML" \
    -e "/<!--@STREAM_MOUNTS@-->/d" \
    -e "/<!--@TRUSTED_PROXIES@-->/r $TRUSTED_XML" \
    -e "/<!--@TRUSTED_PROXIES@-->/d" \
    "$TEMPLATE" > "$RENDERED"
chown icecast2 "$RENDERED" 2>/dev/null || true

# ---- Launch the pair, then wait for either to die ---------------------------

echo "broadcast: starting icecast2" >&2
sudo -E -u icecast2 icecast2 -n -c "$RENDERED" &
ICECAST_PID=$!

# Wait up to ~10s for icecast to accept HTTP, or liquidsoap can beat it and
# bail with "Cannot connect to remote host" on its first source connect.
for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS http://localhost:7702/ > /dev/null 2>&1; then
        echo "broadcast: icecast accepting connections after ${i}s" >&2
        break
    fi
    sleep 1
done

echo "broadcast: starting liquidsoap" >&2
# TEMPORARY (re-harden later): run liquidsoap as root instead of dropping to
# the `liquidsoap` user. The savonet base bump 2.2.5 → 2.4.4 changed that
# user's uid (10000 → 100), making state files persisted by the old image
# unwritable — every on_meta write EACCES'd and the UI froze one song behind.
# Restore the privilege drop once the state files are chowned to the new uid
# (needs settings.init.allow_root reverted in radio.liq too).
liquidsoap /etc/liquidsoap/radio.liq &
LIQ_PID=$!

trap 'kill -TERM "$ICECAST_PID" "$LIQ_PID" 2>/dev/null || true' INT TERM

wait -n "$ICECAST_PID" "$LIQ_PID"
EXIT=$?

echo "broadcast: child exited ($EXIT) — taking the other down" >&2
kill -TERM "$ICECAST_PID" "$LIQ_PID" 2>/dev/null || true
wait 2>/dev/null || true

exit "$EXIT"
