#!/usr/bin/env bash
# SUB/WAVE all-in-one supervisor — runs icecast2 + liquidsoap (the broadcast
# pair), the controller, the web UI, and Caddy in ONE container
# (docker/Dockerfile.aio). Everything shares localhost + /var/sub-wave, so the
# file-based IPC works unchanged; only *_HOST/*_URL overrides repoint loopback.
#
# Each service runs in its own restart loop, so a web or controller crash does
# NOT take the station off the air. The broadcast pair is launched as a unit
# (mirroring docker/broadcast-entrypoint.sh): if either dies both are bounced.
#
# Bash (not /bin/sh) for `wait -n`.
set -u

SECRETS=/var/sub-wave/icecast-secrets.env
TEMPLATE=/etc/icecast2/icecast.xml.template
RENDERED=/etc/icecast2/icecast.xml

# Multi-station pointer (kept in lockstep with docker/broadcast-entrypoint.sh).
# Called at the top of run_broadcast so every mixer relaunch re-resolves.
#
# Both paths are env-overridable so scripts/aio-log-link.test.ts can drive
# link_liquidsoap_log() against a scratch dir; neither var is set in the image.
STATE_ROOT="${SUBWAVE_STATE_ROOT:-/var/sub-wave}"
LIQ_LOG_DIR="${SUBWAVE_LIQ_LOG_DIR:-/var/log/liquidsoap}"
STATE_DIR="$STATE_ROOT"
resolve_state_dir() {
	STATE_DIR="$STATE_ROOT"
	local active="$STATE_ROOT/stations/active.json" id=""
	if [ -f "$active" ]; then
		id=$(sed -n 's/.*"activeId"[[:space:]]*:[[:space:]]*"\([a-z0-9][a-z0-9-]\{0,40\}\)".*/\1/p' "$active" | head -n1)
		if [ -n "$id" ] && [ -d "$STATE_ROOT/stations/$id" ]; then
			STATE_DIR="$STATE_ROOT/stations/$id"
			log "active station '$id' → $STATE_DIR"
		else
			log "WARNING stations/active.json unresolvable (id='$id') — using root"
		fi
	fi
	export SUBWAVE_STATE_DIR="$STATE_DIR"
}

log() { echo "[subwave-aio] $*" >&2; }

# ---------------------------------------------------------------------------
# Shared state bootstrap — same functions, list and messages as
# docker/broadcast-entrypoint.sh, which carries the full rationale (#1300 bug
# 10); scripts/state-bootstrap.test.ts drives both through one table, because
# them drifting apart is how the bug returns.
#
# Nothing here is fatal. This script runs under `set -u` (not -e), so its copy
# of the old bulk chmod merely printed a raw `chmod:` line naming no cause;
# the entrypoint's identical block ran under `set -eu` and aborted the
# container outright.
# ---------------------------------------------------------------------------
state_warn() { log "WARNING $*"; }

# True when `other` can write the dir — see the entrypoint on why the warning
# keys on this rather than on chmod's exit status.
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
		state_warn "state dir $p is mode $(stat -c %a "$p" 2>/dev/null || echo '?') and chmod could not change it — the controller and analyzer write there as other uids; chown/chmod it on the host"
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
	# stems + transitions are the analyzer's, and the only two dirs worth
	# relocating to a bigger disk — a bind mount there lands root-owned 755,
	# which the analyzer cannot write without this chmod.
	for sub in voice voices archive jingles logs sessions sfx stems transitions; do
		state_prepare_dir "$dir/$sub"
	done
	# A RELOCATED stem cache (SUBWAVE_STEMS_DIR — the container path of the
	# mount; compose sets it from STEMS_DIR, AIO operators pass -e) sits
	# outside $dir, so the loop above never reaches it and the mount would
	# keep its root-owned 755. Per-station subdirs under it are created by the
	# analyzer itself, which inherits this 777.
	if [ -n "${SUBWAVE_STEMS_DIR:-}" ]; then
		state_prepare_dir "$SUBWAVE_STEMS_DIR"
	fi
	# Liquidsoap's reload_mode="watch" playlists need the files to exist.
	state_prepare_file "$dir/auto.m3u" 666
	state_prepare_file "$dir/jingles.m3u" 666
	# Keep a co-located Navidrome from scanning the hourly archive mixdowns
	# in as junk "HH-00" tracks (issue #273).
	state_prepare_file "$dir/archive/.ndignore"
	return 0
}

init_state() {
	bootstrap_state_dirs /var/sub-wave /var/sub-wave

	link_liquidsoap_log

	# Rotate radio.log on boot once it passes 50MB (liquidsoap appends
	# forever; boot is the one safe moment — fd not yet held). Rotating via
	# $LIQ_LOG_DIR matters: after link_liquidsoap_log it resolves to wherever
	# radio.log actually lands, which the state path can miss.
	RADIO_LOG="$LIQ_LOG_DIR/radio.log"
	if [ -f "$RADIO_LOG" ] && [ "$(stat -c %s "$RADIO_LOG" 2>/dev/null || echo 0)" -gt 52428800 ]; then
		mv -f "$RADIO_LOG" "$RADIO_LOG.old"
		echo "supervisor: rotated oversized radio.log to radio.log.old" >&2
	fi
}

# ---------------------------------------------------------------------------
# Point /var/log/liquidsoap at the state ROOT's logs/ (#1196: radio.log must
# survive recreates; routes/debug.ts tails <stateRoot>/logs/radio.log) — but
# never at the cost of the station: radio.liq opens the log path as its FIRST
# lifecycle step, so an unopenable path is a fatal startup error, not a
# degraded log. Every branch below must end in a path liquidsoap can open,
# verified by probe.
#
# #1196's original fix linked unconditionally and guarded on -L only. If
# <state>/logs was itself a symlink back at /var/log/liquidsoap (a natural
# pre-#1196 host-side workaround), the two closed an ELOOP cycle the guard
# never repaired — an unbreakable crash loop "Restart mixer" couldn't touch.
# ---------------------------------------------------------------------------
link_liquidsoap_log() {
	local target="$STATE_ROOT/logs"

	# 1. Heal a broken state-side logs link. `-d` is false for dangling AND
	#    looping symlinks — exactly the set worth replacing. A link that
	#    resolves elsewhere is an operator parking logs on another disk on
	#    purpose — left alone.
	if [ -L "$target" ] && [ ! -d "$target" ]; then
		log "WARNING $target is a broken symlink (-> $(readlink "$target" 2>/dev/null || echo '?')) — replacing it with a real directory"
		rm -f "$target" 2>/dev/null || true
	fi

	# 1b. A state-side link that resolves INTO the container log path is the
	#     #1196 cycle half in disguise — it only looks healthy while the fresh
	#     image's plain /var/log/liquidsoap still exists. Linking $LIQ_LOG_DIR
	#     at a path that resolves to itself can only re-create the cycle, so
	#     replace the link with a real directory now (keeps persistence).
	if [ -L "$target" ] && [ -d "$target" ] && command -v realpath >/dev/null 2>&1; then
		local target_real liq_real
		target_real=$(realpath -m -- "$target" 2>/dev/null || true)
		liq_real=$(realpath -m -- "$LIQ_LOG_DIR" 2>/dev/null || true)
		if [ -n "$target_real" ] && [ "$target_real" = "$liq_real" ]; then
			log "WARNING $target resolves into $LIQ_LOG_DIR — the #1196 cycle half; replacing it with a real directory"
			rm -f "$target" 2>/dev/null || true
		fi
	fi

	mkdir -p "$target" 2>/dev/null || true
	chmod 777 "$target" 2>/dev/null || true

	# 2. Point the in-container path at it — unless something is mounted
	#    there (an operator's bind mount is already persistent; use as-is).
	#    The mountpoint test must come BEFORE any `rm -rf`: rm on a
	#    mountpoint can't remove the mountpoint but DOES delete everything
	#    inside — wiping the log history the mount exists to keep.
	if [ -d "$target" ]; then
		if [ -e "$LIQ_LOG_DIR" ] && [ ! -L "$LIQ_LOG_DIR" ] && is_mountpoint "$LIQ_LOG_DIR"; then
			log "$LIQ_LOG_DIR is a mountpoint — leaving it as-is; radio.log stays there"
		else
			# rm first: `ln -s` onto a surviving directory would
			# silently create the link INSIDE it.
			[ -L "$LIQ_LOG_DIR" ] || rm -rf "$LIQ_LOG_DIR" 2>/dev/null || true
			if [ -e "$LIQ_LOG_DIR" ] && [ ! -L "$LIQ_LOG_DIR" ]; then
				# Unremovable yet not detected as a mountpoint
				# (exotic mount setups) — same outcome, use as-is.
				log "$LIQ_LOG_DIR survived removal (bind mount?) — leaving it; radio.log stays there"
			else
				# -f replaces an existing link (including a looping
				# one); -n keeps it from being planted inside a
				# link-to-directory.
				ln -sfn "$target" "$LIQ_LOG_DIR" 2>/dev/null || true
			fi
		fi
	else
		log "WARNING $target is not a usable directory — not linking $LIQ_LOG_DIR at it"
	fi

	# 3. Prove liquidsoap can open a file there before handing over the path
	#    — the backstop that turns the whole ELOOP class into a warning. Any
	#    failing shape falls back to a container-local dir: no persistence,
	#    but the station stays on the air.
	if ! probe_log_dir; then
		log "WARNING $LIQ_LOG_DIR is unopenable — falling back to a container-local log dir; radio.log will NOT persist in the state dir"
		# A mountpoint can be neither removed nor replaced — rebuild
		# unmounted paths only (rm -rf on a failing mount would just strip
		# the operator's files without fixing the path).
		if ! is_mountpoint "$LIQ_LOG_DIR"; then
			rm -rf "$LIQ_LOG_DIR" 2>/dev/null || true
			mkdir -p "$LIQ_LOG_DIR" 2>/dev/null || true
		fi
		probe_log_dir || log "ERROR $LIQ_LOG_DIR is still unopenable — liquidsoap will fail to start"
	fi

	# Deliberately NOT recursive: liquidsoap only needs to create/append
	# radio.log in the directory itself, and an operator who pointed
	# <state>/logs at their own disk shouldn't have its contents re-owned.
	chmod 777 "$LIQ_LOG_DIR" 2>/dev/null || true
	chown liquidsoap:liquidsoap "$LIQ_LOG_DIR" 2>/dev/null || true
}

# Can a file actually be created under $LIQ_LOG_DIR? Runs as root, so it proves
# the PATH resolves (the ELOOP/dangling class), not that the liquidsoap user
# has write permission — that's the chmod/chown above.
probe_log_dir() {
	local probe="$LIQ_LOG_DIR/.write-probe"
	: > "$probe" 2>/dev/null || return 1
	rm -f "$probe" 2>/dev/null || true
	return 0
}

# Is $1 a mountpoint? Falls back to /proc/self/mountinfo (field 5 is the mount
# point) so the answer never degrades to "not a mount" just because the
# `mountpoint` binary is missing.
is_mountpoint() {
	if command -v mountpoint >/dev/null 2>&1; then
		mountpoint -q "$1" 2>/dev/null
	else
		awk -v p="$1" '$5 == p { found = 1; exit } END { exit found ? 0 : 1 }' /proc/self/mountinfo 2>/dev/null
	fi
}

# ---------------------------------------------------------------------------
# Warn loudly if /var/sub-wave isn't a mounted volume: everything the station
# writes would live in the container's writable layer and be wiped by the next
# image update. A bare `docker run` that forgets `-v` is the footgun (#902); a
# real mount gets its own /proc/mounts entry, an overlay dir doesn't.
# ---------------------------------------------------------------------------
warn_if_state_unmounted() {
	if ! grep -q ' /var/sub-wave ' /proc/mounts 2>/dev/null; then
		log "################################################################"
		log "WARNING: /var/sub-wave is NOT a mounted volume."
		log "  Your settings, library cache (library.db), hourly archives and"
		log "  model cache are being written into the container's writable"
		log "  layer, and will be LOST the next time this image is updated."
		log "  Map a host path to /var/sub-wave (on Unraid: the Appdata path,"
		log "  e.g. /mnt/user/appdata/subwave) and recreate the container."
		log "  https://github.com/perminder-klair/subwave/issues/902"
		log "################################################################"
	fi
}

# ---------------------------------------------------------------------------
# ANALYZER_HEAVY selects an IMAGE TAG by compose variable interpolation
# (`subwave-analyzer${ANALYZER_HEAVY:+-heavy}`). The AIO has no analyzer
# service to select — CLAP and Demucs are baked into the venv at build time or
# they are not — so the variable is inert here by construction. Operators set
# it, see no stem-transitions card, and conclude the feature is broken (#1300
# bug 9); the caveat was documented (docs/unraid.md, the doctor) but nothing
# said it at the boot right after they set it.
#
# Probed rather than read from a baked marker: torch in the venv IS what makes
# the heavy tier work, so a probe cannot disagree with what it describes.
# ---------------------------------------------------------------------------
ANALYZER_VENV="${SUBWAVE_ANALYZER_VENV:-/opt/analyzer/venv}"

analyzer_venv_is_heavy() {
	compgen -G "$ANALYZER_VENV/lib/python*/site-packages/torch/__init__.py" >/dev/null 2>&1
}

warn_if_analyzer_heavy_ignored() {
	[ -n "${ANALYZER_HEAVY:-}" ] || return 0
	if analyzer_venv_is_heavy; then
		log "note: ANALYZER_HEAVY is a docker-compose setting and has no effect on"
		log "  the all-in-one image — but this IS a heavy build, so CLAP and Demucs"
		log "  are available anyway. Nothing to do."
		return 0
	fi
	log "################################################################"
	log "WARNING: ANALYZER_HEAVY is set, and it does NOTHING on this image."
	log "  It is a docker-compose variable that picks the analyzer service's"
	log "  image tag. The all-in-one image has no analyzer service — CLAP and"
	log "  Demucs are baked in at build time, and this build does not have them."
	log "  Sounds-like search, vocal-aware timing and stem transitions will stay"
	log "  unavailable no matter what this variable is set to."
	log "  To get them, change this container's IMAGE to:"
	log "    ghcr.io/perminder-klair/subwave-aio-heavy"
	log "  (or -aio-cuda on an NVIDIA host). NOT subwave-analyzer-heavy — that is"
	log "  the bare analyzer micro-service, not a station image."
	log "  https://github.com/perminder-klair/subwave/issues/1300"
	log "################################################################"
}

# ---------------------------------------------------------------------------
# Resolve the ICECAST_*_PASSWORD values. Precedence: env override > persisted
# secrets file > freshly generated. Written back for operator visibility + the
# documented rotate path; exported for liquidsoap.
# ---------------------------------------------------------------------------
init_secrets() {
	local ENV_SRC="${ICECAST_SOURCE_PASSWORD:-}"
	local ENV_ADM="${ICECAST_ADMIN_PASSWORD:-}"
	local ENV_REL="${ICECAST_RELAY_PASSWORD:-}"

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

	cat > "$SECRETS" <<-EOF
		ICECAST_SOURCE_PASSWORD=$ICECAST_SOURCE_PASSWORD
		ICECAST_ADMIN_PASSWORD=$ICECAST_ADMIN_PASSWORD
		ICECAST_RELAY_PASSWORD=$ICECAST_RELAY_PASSWORD
	EOF
	# 0600 — passwords, read only by root (all in-container readers are root).
	chmod 600 "$SECRETS"

	export ICECAST_SOURCE_PASSWORD ICECAST_ADMIN_PASSWORD ICECAST_RELAY_PASSWORD
	# Liquidsoap connects over loopback; radio.liq reads ICECAST_HOST.
	export ICECAST_HOST=localhost
}

# ---------------------------------------------------------------------------
# Render icecast.xml. Called on EVERY broadcast pair (re)launch — not just boot
# — so a restart-mixer picks up a flipped listener-auth flag or a changed
# buffer/bitrate setting, the same way the split stack's container restart
# re-runs its entrypoint.
# ---------------------------------------------------------------------------
read_state_num() {
	# $1 = filename under $STATE_DIR, $2 = fallback. Non-numeric/missing → fallback.
	local _v
	_v=$(cat "$STATE_DIR/$1" 2>/dev/null || true)
	case "$_v" in
		''|*[!0-9]*) echo "$2" ;;
		*) echo "$_v" ;;
	esac
}

# Keep the listener-time offset under controller ownership. Accepting an env
# override here would make the Icecast burst disagree with /now-playing and
# voice-event timing even though all four processes share this container.
stream_buffer_seconds() {
	read_state_num liquidsoap_stream_buffer_seconds.txt 22
}

# Concurrent-listener ceiling — the same function, for the same reasons, as
# docker/broadcast-entrypoint.sh's. This image is the REASON the setting exists:
# the Unraid template exposes no ICECAST_MAX_CLIENTS and there is no .env here,
# so before stream.maxListeners the ceiling was unreachable on AIO. Env still
# wins where it IS set. Both copies are driven from one table by
# scripts/max-listeners.test.ts.
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

render_icecast() {
	# Concurrent-listener ceiling — see resolve_max_clients above.
	local MAX_CLIENTS_LINE
	MAX_CLIENTS_LINE="$(resolve_max_clients)"
	ICECAST_MAX_CLIENTS="${MAX_CLIENTS_LINE%% *}"
	log "max listeners $ICECAST_MAX_CLIENTS (from ${MAX_CLIENTS_LINE#* })"

	# Listener buffer depth — same contract as docker/broadcast-entrypoint.sh
	# (#1114): burst-size is a byte count, derived from
	# settings.stream.bufferSeconds x each mount's bitrate.
	local STREAM_BITRATE BUFFER_SECONDS OPUS_BITRATE AAC_BITRATE FLAC_BITRATE_EST
	STREAM_BITRATE="${ICECAST_STREAM_BITRATE:-$(read_state_num liquidsoap_stream_bitrate.txt 192)}"
	BUFFER_SECONDS="$(stream_buffer_seconds)"
	case "$STREAM_BITRATE" in *[!0-9]*|'') STREAM_BITRATE=192 ;; esac
	case "$BUFFER_SECONDS" in *[!0-9]*|'') BUFFER_SECONDS=22 ;; esac
	[ "$BUFFER_SECONDS" -gt 60 ] && BUFFER_SECONDS=60
	OPUS_BITRATE="${ICECAST_OPUS_BITRATE:-$(read_state_num liquidsoap_opus_bitrate.txt 96)}"
	AAC_BITRATE="${ICECAST_AAC_BITRATE:-$(read_state_num liquidsoap_aac_bitrate.txt 192)}"
	case "$OPUS_BITRATE" in *[!0-9]*|'') OPUS_BITRATE=96 ;; esac
	case "$AAC_BITRATE" in *[!0-9]*|'') AAC_BITRATE=192 ;; esac
	# FLAC is VBR — ~900 kbps is a typical average for 44.1/16 stereo.
	FLAC_BITRATE_EST=900

	# Global <limits> fallback, sized for the MP3 mount (kbps x 125 = bytes/s).
	local ICECAST_BURST_SIZE ICECAST_QUEUE_SIZE
	ICECAST_BURST_SIZE=$(( BUFFER_SECONDS * STREAM_BITRATE * 125 ))
	ICECAST_QUEUE_SIZE=$(( ICECAST_BURST_SIZE * 4 ))
	[ "$ICECAST_QUEUE_SIZE" -lt 2097152 ] && ICECAST_QUEUE_SIZE=2097152
	log "listener buffer ${BUFFER_SECONDS}s @ mp3 ${STREAM_BITRATE}kbps / opus ${OPUS_BITRATE}kbps / aac ${AAC_BITRATE}kbps / flac ~${FLAC_BITRATE_EST}kbps"

	# Listener auth (#478) — same contract as docker/broadcast-entrypoint.sh:
	# only a literal 'true' in the controller-written flag enables. The
	# controller runs in-process here, so the callback goes over loopback.
	local FLAG=$STATE_DIR/icecast_listener_auth.txt
	local AUTH_URL="${LISTENER_AUTH_URL:-http://localhost:7701/listener-auth}"
	local LISTENER_AUTH=false
	if [ "$(cat "$FLAG" 2>/dev/null | tr -d '[:space:]')" = "true" ]; then
		LISTENER_AUTH=true
		log "listener auth ON — mounts require credentials via $AUTH_URL"
	fi

	# One <mount> block per stream mount, ALWAYS rendered: each carries its
	# own burst/queue sized for its own bitrate (the global <limits> value
	# only fits MP3), plus the auth block when the toggle is on.
	local MOUNTS_XML=/etc/icecast2/stream-mounts.xml
	: > "$MOUNTS_XML"
	emit_mount() {
		# $1 = mount path, $2 = kbps used to size this mount's burst
		local _burst _queue
		_burst=$(( BUFFER_SECONDS * $2 * 125 ))
		_queue=$(( _burst * 4 ))
		[ "$_queue" -lt 2097152 ] && _queue=2097152
		{
			echo '    <mount type="normal">'
			echo "        <mount-name>$1</mount-name>"
			echo "        <burst-size>$_burst</burst-size>"
			echo "        <queue-size>$_queue</queue-size>"
			if [ "$LISTENER_AUTH" = true ]; then
				echo '        <authentication type="url">'
				echo "            <option name=\"listener_add\" value=\"$AUTH_URL\"/>"
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

	# Trusted reverse proxies — same contract as docker/broadcast-entrypoint.sh.
	# Caddy is in THIS container, so the peer is always loopback; both forms
	# are emitted because which one icecast sees depends on how Caddy resolved
	# its upstream (icecast-KH wants an exact IP). ICECAST_TRUSTED_PROXY_IPS
	# still overrides, for an AIO behind a further proxy.
	local TRUSTED_XML=/etc/icecast2/trusted-proxies.xml
	local TRUSTED_LIST _ip
	: > "$TRUSTED_XML"
	TRUSTED_LIST=$(echo "${ICECAST_TRUSTED_PROXY_IPS:-127.0.0.1 ::1}" | tr ',' ' ')
	for _ip in $TRUSTED_LIST; do
		case "$_ip" in
			''|*[!0-9a-fA-F.:]*)
				log "WARNING ignoring malformed trusted proxy '$_ip'"
				continue
				;;
		esac
		echo "        <x-forwarded-for>$_ip</x-forwarded-for>" >> "$TRUSTED_XML"
	done

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
}

# ---------------------------------------------------------------------------
# Service launchers. Each blocks until its process exits, so the supervise()
# loop can restart it. Do NOT `exec` — that would replace the loop.
# ---------------------------------------------------------------------------

# icecast2 + liquidsoap as a unit; returns when either dies.
run_broadcast() {
	# Re-resolve the active station on every pair launch — this is how a
	# station switch takes effect in the AIO without a container bounce.
	resolve_state_dir

	# Bootstrap the resolved station dir's subdirs (the root case is covered
	# by init_state at boot; a non-root station dir needs its own here).
	bootstrap_state_dirs "$STATE_DIR" "$STATE_DIR"

	render_icecast
	log "starting icecast2"
	sudo -E -u icecast2 icecast2 -n -c "$RENDERED" &
	local ic=$!

	# Give icecast a moment to accept HTTP so liquidsoap's first source
	# connect doesn't bail with "Cannot connect to remote host".
	local i
	for i in 1 2 3 4 5 6 7 8 9 10; do
		if curl -fsS http://localhost:7702/ >/dev/null 2>&1; then
			log "icecast accepting connections after ${i}s"
			break
		fi
		sleep 1
	done

	log "starting liquidsoap"
	# TEMPORARY (re-harden later): run liquidsoap as root — same reason as
	# docker/broadcast-entrypoint.sh (the savonet base bump changed the
	# liquidsoap uid, making persisted state files unwritable).
	liquidsoap /etc/liquidsoap/radio.liq &
	local lq=$!

	wait -n "$ic" "$lq"
	local code=$?
	log "broadcast pair: a child exited ($code) — taking the other down"
	kill -TERM "$ic" "$lq" 2>/dev/null || true
	wait "$ic" "$lq" 2>/dev/null || true
	return "$code"
}

# Controller. The *_HOST/*_URL overrides repoint the compose service names at
# loopback. DOCKER_HOST and TTS_HEAVY_URL are intentionally unset — the Stats
# panel hides and TTS falls back to Piper. Everything else is inherited from
# the container env + settings.json.
run_controller() {
	cd /app || return 1
	export NODE_ENV=production \
	       STATE_DIR=/var/sub-wave \
	       SOUNDS_DIR=/sounds \
	       LIQUIDSOAP_HOST=127.0.0.1 \
	       ICECAST_STATUS_URL=http://127.0.0.1:7702/status-json.xsl \
	       ICECAST_ADMIN_URL=http://127.0.0.1:7702/admin/listclients
	node_modules/.bin/tsx src/server.ts
}

# Web — Next.js listener UI (standalone build).
run_web() {
	cd /web || return 1
	export NODE_ENV=production \
	       PORT=7700 \
	       HOSTNAME=0.0.0.0 \
	       CONTROLLER_INTERNAL_URL=http://127.0.0.1:7701 \
	       SUBWAVE_HOMEPAGE="${SUBWAVE_HOMEPAGE:-player}"
	node server.js
}

# Caddy — the single-origin edge that fronts all three on :80.
run_caddy() {
	caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
}

# ---------------------------------------------------------------------------
# supervise <name> <launcher-fn> — restart loop with backoff.
# ---------------------------------------------------------------------------
supervise() {
	local name="$1"; shift
	while true; do
		log "starting $name"
		"$@"
		local code=$?
		log "$name exited ($code) — restarting in 3s"
		sleep 3
	done
}

# ---------------------------------------------------------------------------
# Boot. Sourcing with SUBWAVE_SUPERVISOR_LIB=1 defines the functions WITHOUT
# booting — the seam scripts/aio-log-link.test.ts uses. The image never sets
# it, so PID 1 always falls through to the real boot.
# ---------------------------------------------------------------------------
if [ "${SUBWAVE_SUPERVISOR_LIB:-}" = "1" ]; then
	return 0 2>/dev/null || exit 0
fi

warn_if_state_unmounted
warn_if_analyzer_heavy_ignored
init_state
init_secrets

# On stop, signal the whole process group once, then give the children time to
# shut down (reset the trap first so the kill doesn't re-enter). The grace
# period matters: this is PID 1, and the instant it exits everything left gets
# SIGKILLed — which robbed the controller of its SIGTERM handler and left
# library.db's WAL un-checkpointed on every stop (#786). `wait` covers the
# supervise loops; the sleep covers their reparented children, which bash's
# wait can't see. Docker's stop timeout still hard-caps the whole thing.
trap 'trap "" TERM INT; log "shutting down"; kill -TERM 0 2>/dev/null; wait; sleep 2; exit 0' TERM INT

supervise broadcast  run_broadcast  &
supervise controller run_controller &
supervise web        run_web        &
supervise caddy      run_caddy      &

wait
