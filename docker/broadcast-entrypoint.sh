#!/usr/bin/env bash
# SUB/WAVE broadcast supervisor: resolves the icecast secrets, renders
# icecast.xml, launches icecast2 + liquidsoap, and exits as soon as either dies
# so the container's restart policy bounces the pair together.
#
# Bash (not /bin/sh) because we need `wait -n`; the base image's /bin/sh is
# dash, which lacks it.

set -eu

# Shared state bootstrap. Mode 777 because the controller, analyzer and
# liquidsoap write here as OTHER uids; without it an operator must chown every
# bind-mount source by hand. The state ROOT is 1777 instead: the sticky bit
# still lets every uid create files there, but only a file's owner can rename or
# delete it, so a sidecar's uid cannot replace root's icecast-secrets.env.
#
# NOTHING in here is fatal (#1300 bug 10): under `set -eu` a bulk mkdir/chmod
# makes every state path load-bearing, and one unwritable mount aborts this
# script before icecast starts. A degraded mount still serves and still airs the
# emergency loop; an exited container airs nothing.
#
# docker/aio/supervisor.sh keeps the same functions, list and messages;
# scripts/state-bootstrap.test.ts drives both through one table.
state_warn() { echo "broadcast: WARNING $*" >&2; }
state_log() { echo "broadcast: $*" >&2; }

# True when `other` can write the dir. The warning keys on this rather than on
# chmod's exit status: a mount that is already world-writable and merely refuses
# chmod is a working config and must not warn on every boot.
state_writable_by_others() {
    case "$(stat -c %a "$1" 2>/dev/null || echo 0)" in
        *[2367]) return 0 ;;
        *) return 1 ;;
    esac
}

state_prepare_dir() {
    local p=$1
    local mode=${2:-777}
    mkdir -p "$p" 2>/dev/null || true
    if [ ! -d "$p" ]; then
        state_warn "state dir $p could not be created — a read-only or unwritable mount; the station boots, but anything writing there will fail"
        return 0
    fi
    chmod "$mode" "$p" 2>/dev/null || true
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
    state_prepare_dir "$root" 1777
    # A single-station install serves from the root itself; a second plain 777
    # would strip the sticky bit again.
    [ "$dir" = "$root" ] || state_prepare_dir "$dir"
    # stems + transitions are the analyzer's (uid 10001); a fresh bind mount
    # lands root-owned 755, which it cannot write without the same 777.
    for sub in voice voices archive jingles logs sessions sfx stems transitions; do
        state_prepare_dir "$dir/$sub"
    done
    # A RELOCATED stem cache (STEMS_DIR in .env, container path
    # SUBWAVE_STEMS_DIR) sits outside $dir, so the loop above never reaches it.
    # Marker initialization shares any per-station directories it creates too.
    if [ -n "${SUBWAVE_STEMS_DIR:-}" ]; then
        state_prepare_dir "$SUBWAVE_STEMS_DIR"
    fi
    # Liquidsoap's reload_mode="watch" playlists need the files to exist.
    state_prepare_file "$dir/auto.m3u" 666
    state_prepare_file "$dir/jingles.m3u" 666
    # Keeps a co-located Navidrome from scanning the hourly archive mixdowns in
    # as junk "HH-00" tracks (#273).
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

# Concurrent-listener ceiling (Icecast <limits><clients>). Two sources and the
# ENV one WINS: ICECAST_MAX_CLIENTS is wired into all three compose files, so
# demoting it would silently change a configured station on upgrade; the setting
# (stream.maxListeners -> liquidsoap_icecast_max_clients.txt) is what reaches
# AIO/Unraid, which has no .env. Echoes "<value> <source>" so the caller can log
# which won. Non-numeric or zero falls back to 100 rather than failing icecast.
# docker/aio/supervisor.sh carries the same function; scripts/max-listeners.test.ts
# drives both from one table.
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

# Trusted reverse proxies — real listener IPs in admin -> Listeners instead of
# the edge's container address. icecast-KH matches an EXACT IP: a CIDR is
# accepted and then silently never matches, so a malformed entry is DROPPED and
# named rather than interpolated (invalid XML here would stop the station
# booting).
#
#   render_trusted_proxies $1=XML fragment path, $2=source label,
#   $3..=candidate addresses (may be empty — a DNS lookup resolving nothing is
#   the documented first-cold-boot case).
#
# It also writes $STATE_DIR/trusted-proxies.json (count, addresses, source,
# dropped) so admin can explain what icecast trusted (#1613). Rewritten on EVERY
# render so it can never describe a config icecast is not running; failing to
# write it is never fatal, same rule as the state bootstrap above.
#
# docker/aio/supervisor.sh carries the same function and the same messages;
# scripts/trusted-proxies.test.ts drives both from one table.

# A dropped entry is operator input on its way into JSON, so reduce it to a safe
# token first: address / CIDR / hostname characters only, length capped. A quote
# or backslash would produce a marker the controller cannot parse.
trusted_proxy_token() {
    printf '%s' "$1" | tr -cd '0-9A-Za-z.:/_-' | cut -c1-48
}

# True when $1 has the SHAPE of an address icecast can match. A bare character
# class (`''|*[!0-9a-fA-F.:]*`) is NOT enough: it accepts every hex-only word,
# so `cafe`, `beef`, `ff` and a bare `a` pass while `caddy` is dropped, and the
# operator-facing count then claims proxies that can never match.
#
# Shape only, deliberately: whether the address is the RIGHT one is the
# operator's to know, and this must keep dropping rather than repairing.
trusted_proxy_valid() {
    local addr=$1 rest octet n=0
    # Anything with a colon is IPv6 (dots allowed for the ::ffff:1.2.3.4 form).
    # Not a full parser; icecast's own exact match is the real arbiter.
    case "$addr" in
        *:*)
            case "$addr" in *[!0-9a-fA-F:.]*) return 1 ;; esac
            case "$addr" in *[0-9a-fA-F]*) return 0 ;; *) return 1 ;; esac
            ;;
    esac
    # IPv4: exactly four dot-separated decimal octets, each 0-255.
    rest=$addr
    while [ "$n" -lt 4 ]; do
        case "$rest" in
            *.*) octet=${rest%%.*}; rest=${rest#*.} ;;
            *)   octet=$rest; rest='' ;;
        esac
        n=$(( n + 1 ))
        case "$octet" in ''|*[!0-9]*) return 1 ;; esac
        # Length first: `[ 99999999999999999999 -le 255 ]` is an arithmetic
        # error, not a false.
        [ "${#octet}" -le 3 ] || return 1
        [ "$octet" -le 255 ] || return 1
        [ "$n" -eq 4 ] || [ -n "$rest" ] || return 1
    done
    [ -z "$rest" ] || return 1
    return 0
}

write_trusted_proxy_marker() {
    # $1 = count, $2 = source label, $3 = proxies JSON array, $4 = dropped array
    local dir=${STATE_DIR:-}
    [ -n "$dir" ] || return 0
    local marker=$dir/trusted-proxies.json
    local tmp=$marker.tmp
    if printf '{"count":%s,"source":"%s","proxies":%s,"dropped":%s,"at":%s}\n' \
            "$1" "$2" "$3" "$4" "$(date +%s)" > "$tmp" 2>/dev/null \
        && mv -f "$tmp" "$marker" 2>/dev/null; then
        chmod 644 "$marker" 2>/dev/null || true
    else
        rm -f "$tmp" 2>/dev/null || true
        state_warn "could not write $marker — the station is unaffected, but the admin Listeners table cannot explain a missing trusted proxy"
    fi
    return 0
}

render_trusted_proxies() {
    local xml=$1
    local source=$2
    shift 2
    local ip names="" kept="" dropped="" count=0
    : > "$xml" 2>/dev/null || true
    # Candidates arrive already word-split, so prose is dropped word by word.
    # Left alone: the list has always been space-separated (the DNS path returns
    # several addresses for one name).
    for ip in "$@"; do
        if ! trusted_proxy_valid "$ip"; then
            state_warn "ignoring malformed trusted proxy '$ip' — icecast matches an exact IP, so a CIDR, a hostname or anything else that is not an address never matches"
            dropped="$dropped,\"$(trusted_proxy_token "$ip")\""
            continue
        fi
        echo "        <x-forwarded-for>$ip</x-forwarded-for>" >> "$xml"
        names="$names $ip"
        kept="$kept,\"$ip\""
        count=$(( count + 1 ))
    done
    if [ "$count" -gt 0 ]; then
        state_log "trusting X-Forwarded-For from$names (from $source)"
    else
        state_log "no trusted proxy resolved from $source — listener IPs will show the connecting peer (docs/reverse-proxy.md)"
    fi
    write_trusted_proxy_marker "$count" "$source" "[${kept#,}]" "[${dropped#,}]"
    return 0
}

# Icecast passwords (state/icecast-secrets.env). Precedence: env override >
# persisted file > freshly generated hex.
#
# The file is DATA, never sourced: only the three known keys are read, and
# every value, whether it came from the env or the file, must pass
# icecast_secret_valid before it is used. Each one is written back to the file,
# spliced into icecast.xml by sed (where `|`, `&` and `\` are special, and `<`
# and `&` are special again in XML) and read again by the controller's regex
# (broadcast/listeners.ts), so a character any of those three would reinterpret
# is refused, not escaped. A refused value is named in a warning and resolution
# falls through to the next source: never fatal, same rule as the bootstrap.
#
# The file is trusted only when it is a regular file (not a symlink) owned by
# the uid this script writes as. The state root is shared with containers that
# run as other uids; anything else is ignored with a warning and replaced by
# write_icecast_secrets.
#
# docker/aio/supervisor.sh carries the same functions and the same messages;
# scripts/icecast-secrets.test.ts drives both from one table.
ICECAST_SECRET_CHARS='A-Z a-z 0-9 . _ ~ + = @ ! % ^ * , : / ? # -'

icecast_secret_valid() {
    case "$1" in
        ''|*[!A-Za-z0-9._~+=@!%^*,:/?#-]*) return 1 ;;
    esac
    return 0
}

# The uid this script's own files land as next to $1. Normally `id -u`, but a
# root-squashed NFS export or a user-namespaced runtime maps it, and a file this
# script wrote must still be recognised as its own. Falls back to `id -u` when
# the dir cannot be written.
icecast_secrets_owner() {
    local probe uid=''
    probe=$(mktemp "$1.XXXXXX" 2>/dev/null) || probe=''
    if [ -n "$probe" ]; then
        uid=$(stat -c %u "$probe" 2>/dev/null || true)
        rm -f "$probe" 2>/dev/null || true
    fi
    [ -n "$uid" ] || uid=$(id -u)
    echo "$uid"
}

# Reads $1 into _ICS_SOURCE / _ICS_ADMIN / _ICS_RELAY, each empty when absent
# or refused.
read_icecast_secrets_file() {
    local file=$1 line key val owner want
    _ICS_SOURCE='' _ICS_ADMIN='' _ICS_RELAY=''
    if [ -L "$file" ]; then
        state_warn "ignoring $file — it is a symlink, not a file this script wrote; the Icecast passwords will be regenerated unless ICECAST_*_PASSWORD is set"
        return 0
    fi
    [ -e "$file" ] || return 0
    if [ ! -f "$file" ] || [ ! -r "$file" ]; then
        state_warn "ignoring $file — not a readable regular file; the Icecast passwords will be regenerated unless ICECAST_*_PASSWORD is set"
        return 0
    fi
    owner=$(stat -c %u "$file" 2>/dev/null || echo '?')
    want=$(icecast_secrets_owner "$file")
    if [ "$owner" != "$want" ]; then
        state_warn "ignoring $file — owned by uid $owner, not uid $want which writes it; the Icecast passwords will be regenerated unless ICECAST_*_PASSWORD is set"
        return 0
    fi
    while IFS= read -r line || [ -n "$line" ]; do
        line=${line%$'\r'}
        key=${line%%=*}
        [ "$key" != "$line" ] || continue
        val=${line#*=}
        case "$key" in
            ICECAST_SOURCE_PASSWORD|ICECAST_ADMIN_PASSWORD|ICECAST_RELAY_PASSWORD) ;;
            *) continue ;;
        esac
        # A hand edit may quote the value; the controller strips one pair too.
        case "$val" in
            \"*\") val=${val#\"}; val=${val%\"} ;;
            \'*\') val=${val#\'}; val=${val%\'} ;;
        esac
        if ! icecast_secret_valid "$val"; then
            state_warn "ignoring $key in $file — it holds a character outside [$ICECAST_SECRET_CHARS]; it will be replaced"
            continue
        fi
        case "$key" in
            ICECAST_SOURCE_PASSWORD) _ICS_SOURCE=$val ;;
            ICECAST_ADMIN_PASSWORD) _ICS_ADMIN=$val ;;
            ICECAST_RELAY_PASSWORD) _ICS_RELAY=$val ;;
        esac
    done < "$file" || true
    return 0
}

# Sets and exports ICECAST_SOURCE/ADMIN/RELAY_PASSWORD from the env, then $1,
# then openssl.
resolve_icecast_secrets() {
    local file=$1 part name fileval val
    read_icecast_secrets_file "$file"
    for part in SOURCE ADMIN RELAY; do
        name=ICECAST_${part}_PASSWORD
        fileval=_ICS_$part
        val=${!name:-}
        if [ -n "$val" ] && ! icecast_secret_valid "$val"; then
            state_warn "ignoring $name from the environment — it holds a character outside [$ICECAST_SECRET_CHARS], which icecast.xml cannot carry safely; using the persisted or a generated password instead"
            val=''
        fi
        [ -n "$val" ] || val=${!fileval}
        [ -n "$val" ] || val=$(openssl rand -hex 16)
        printf -v "$name" '%s' "$val"
        export "${name?}"
    done
    return 0
}

# Written back for operator visibility + the documented "delete + restart to
# rotate" path. Through a fresh mktemp file and a rename, so the write never
# follows whatever sits at $1 (the rename replaces a symlink, it does not write
# through it). 0600: only root reads it (this script, and the controller off the
# shared mount in broadcast/listeners.ts). A failed write warns, never aborts.
write_icecast_secrets() {
    local file=$1 tmp
    tmp=$(mktemp "$file.XXXXXX" 2>/dev/null) || tmp=''
    if [ -n "$tmp" ] \
        && printf 'ICECAST_SOURCE_PASSWORD=%s\nICECAST_ADMIN_PASSWORD=%s\nICECAST_RELAY_PASSWORD=%s\n' \
            "$ICECAST_SOURCE_PASSWORD" "$ICECAST_ADMIN_PASSWORD" "$ICECAST_RELAY_PASSWORD" > "$tmp" 2>/dev/null \
        && chmod 600 "$tmp" 2>/dev/null \
        && mv -fT "$tmp" "$file" 2>/dev/null; then
        return 0
    fi
    [ -z "$tmp" ] || rm -f "$tmp" 2>/dev/null || true
    state_warn "could not write $file — the station runs on these Icecast passwords, but they will change on the next restart"
    return 0
}

# Escapes $1 for an XML attribute value. The replacements are quoted so bash
# 5.2's patsub_replacement does not read `&` as "the matched text".
xml_escape() {
    local s=$1
    s=${s//'&'/'&amp;'}
    s=${s//'<'/'&lt;'}
    s=${s//'>'/'&gt;'}
    s=${s//'"'/'&quot;'}
    printf '%s' "$s"
}

# Sourcing with SUBWAVE_BROADCAST_LIB=1 defines the helpers above WITHOUT
# booting a station, so scripts/state-bootstrap.test.ts can drive them.
if [ "${SUBWAVE_BROADCAST_LIB:-}" = "1" ]; then
    return 0 2>/dev/null || exit 0
fi

# Multi-station pointer: state/stations/active.json ({"activeId":"<slug>"}) picks
# the station dir this boot serves; install-level files (icecast secrets) stay at
# $STATE_ROOT. No jq in this image — the sed matches the controller's canonical
# output and the slug charset [a-z0-9-]; a hand-mangled file falls back to root.
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

# Icecast passwords: env override > persisted secrets file > freshly generated,
# read as data and validated (see resolve_icecast_secrets above).
resolve_icecast_secrets "$SECRETS"
write_icecast_secrets "$SECRETS"
# Liquidsoap connects over loopback inside this container; radio.liq reads
# ICECAST_HOST (default "icecast").
export ICECAST_HOST=localhost

# Render icecast.xml. Substitution is plain sed with `|` delimiters. That is safe
# only because resolve_icecast_secrets refuses any password holding a character
# sed or XML would reinterpret, and every other value is numeric.
MAX_CLIENTS_LINE="$(resolve_max_clients)"
ICECAST_MAX_CLIENTS="${MAX_CLIENTS_LINE%% *}"
echo "broadcast: max listeners $ICECAST_MAX_CLIENTS (from ${MAX_CLIENTS_LINE#* })" >&2

# Listener buffer depth (<burst-size>, #993/#1114). Sized in SECONDS and
# converted per bitrate here, because burst-size is a BYTE count: a fixed one
# means wildly different depths per mount (512 KB is ~22s at 192k, ~66s at 64k).
# Read from controller-written state so real and advertised depths stay
# identical; a settings change applies on the next container bounce.
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
# falls behind its own primed buffer; 4x, floored at 2 MB (#993).
ICECAST_QUEUE_SIZE=$(( ICECAST_BURST_SIZE * 4 ))
[ "$ICECAST_QUEUE_SIZE" -lt 2097152 ] && ICECAST_QUEUE_SIZE=2097152

echo "broadcast: listener buffer ${BUFFER_SECONDS}s @ mp3 ${STREAM_BITRATE}kbps" \
     "/ opus ${OPUS_BITRATE}kbps / aac ${AAC_BITRATE}kbps / flac ~${FLAC_BITRATE_EST}kbps" >&2

# Listener auth (#478): only a literal 'true' in the controller-written flag
# enables it (missing/garbled -> public). Each stream mount then gets an
# <authentication type="url"> block and icecast POSTs listener connects to the
# controller. The password lives ONLY in settings.json and applies live; this
# render matters only when the toggle flips.
LISTENER_AUTH_FLAG=$STATE_DIR/icecast_listener_auth.txt
LISTENER_AUTH_URL="${LISTENER_AUTH_URL:-http://controller:7701/listener-auth}"
# Escaped once: it lands inside an XML attribute, and a query string's `&` is
# legitimate in a URL but not in icecast.xml.
LISTENER_AUTH_URL_XML=$(xml_escape "$LISTENER_AUTH_URL")
LISTENER_AUTH=false
if [ "$(cat "$LISTENER_AUTH_FLAG" 2>/dev/null | tr -d '[:space:]')" = "true" ]; then
    LISTENER_AUTH=true
    echo "broadcast: listener auth ON — mounts require credentials via $LISTENER_AUTH_URL" >&2
fi

# One <mount> block per stream mount, ALWAYS rendered (not just under auth):
# burst-size is a byte count, so the global <limits> value sized for MP3 lands
# wrong elsewhere (22s of mp3-192k is ~43s of opus-96k, ~6s of FLAC).
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
            echo "            <option name=\"listener_add\" value=\"$LISTENER_AUTH_URL_XML\"/>"
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

# ICECAST_TRUSTED_PROXY_IPS (explicit) wins over DNS for
# ICECAST_TRUSTED_PROXY_HOSTS (default 'caddy', the bundled edge).
#
# The DNS path is best-effort and misses the first cold boot (caddy depends_on
# this container being healthy, so the name cannot resolve yet) and misses
# forever on docker-compose.byo.yml, where there is no caddy service at all —
# which is why the marker records the source tried, not just the count (#1613).
# A miss degrades to the connecting peer's address, never to a wrong IP. Pin the
# edge with ICECAST_TRUSTED_PROXY_IPS (docs/reverse-proxy.md).
TRUSTED_XML=/etc/icecast2/trusted-proxies.xml
TRUSTED_LIST=""
TRUSTED_SOURCE=ICECAST_TRUSTED_PROXY_IPS
if [ -n "${ICECAST_TRUSTED_PROXY_IPS:-}" ]; then
    TRUSTED_LIST=$(echo "$ICECAST_TRUSTED_PROXY_IPS" | tr ',' ' ')
else
    TRUSTED_SOURCE=ICECAST_TRUSTED_PROXY_HOSTS
    for _host in $(echo "${ICECAST_TRUSTED_PROXY_HOSTS:-caddy}" | tr ',' ' '); do
        # ahosts, not hosts: `getent hosts` returns ONE address family, so on a
        # dual-stack network it can return only the IPv6 while Caddy dials over
        # IPv4, and the exact-IP match never fires.
        _found=$(getent ahosts "$_host" 2>/dev/null | awk '{print $1}' | sort -u || true)
        [ -n "$_found" ] && TRUSTED_LIST="$TRUSTED_LIST $_found"
    done
fi
# Unquoted on purpose — the list is space-separated candidates.
# shellcheck disable=SC2086
render_trusted_proxies "$TRUSTED_XML" "$TRUSTED_SOURCE" $TRUSTED_LIST

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

# Launch the pair, then wait for either to die.
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
# TEMPORARY (re-harden later): run liquidsoap as root instead of dropping to the
# `liquidsoap` user. The savonet bump 2.2.5 -> 2.4.4 changed that user's uid
# (10000 -> 100), making persisted state files unwritable. Restore the privilege
# drop once they are chowned (also revert settings.init.allow_root in radio.liq).
liquidsoap /etc/liquidsoap/radio.liq &
LIQ_PID=$!

trap 'kill -TERM "$ICECAST_PID" "$LIQ_PID" 2>/dev/null || true' INT TERM

wait -n "$ICECAST_PID" "$LIQ_PID"
EXIT=$?

echo "broadcast: child exited ($EXIT) — taking the other down" >&2
kill -TERM "$ICECAST_PID" "$LIQ_PID" 2>/dev/null || true
wait 2>/dev/null || true

exit "$EXIT"
