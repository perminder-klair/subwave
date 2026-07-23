#!/usr/bin/env bash
# SUB/WAVE all-in-one supervisor.
#
# Runs the whole stack — icecast2 + liquidsoap (the broadcast pair), the
# controller, the Next.js web UI, and Caddy — inside ONE container for the
# Unraid Community Applications one-click image (docker/Dockerfile.aio).
#
# The split-stack deployment runs these as five compose services wired over an
# internal network; here they all share localhost and the /var/sub-wave volume,
# so the file-based IPC (next.txt / say.txt / now-playing.json …) works exactly
# as before with no code changes — only a handful of *_HOST/*_URL env overrides
# repoint the controller at loopback.
#
# Each service runs in its own restart loop, so a web or controller crash does
# NOT take the station off the air. The icecast+liquidsoap pair is launched as a
# unit (mirroring docker/broadcast-entrypoint.sh): if either dies the pair is
# bounced together, because liquidsoap is useless without its icecast sink.
#
# Bash (not /bin/sh) for `wait -n`; the savonet/liquidsoap base ships bash.
set -u

SECRETS=/var/sub-wave/icecast-secrets.env
TEMPLATE=/etc/icecast2/icecast.xml.template
RENDERED=/etc/icecast2/icecast.xml

log() { echo "[subwave-aio] $*" >&2; }

# ---------------------------------------------------------------------------
# One-time state bootstrap — shared dirs, watch-mode m3u stubs, archive ignore.
# Same responsibilities as docker/broadcast-entrypoint.sh, minus launching the
# audio processes (the supervisor does that in a restart loop below). Mode 777
# because the services run under different uids (icecast2 / liquidsoap / root).
# ---------------------------------------------------------------------------
init_state() {
	mkdir -p /var/sub-wave \
	         /var/sub-wave/voice \
	         /var/sub-wave/voices \
	         /var/sub-wave/archive \
	         /var/sub-wave/jingles \
	         /var/sub-wave/logs \
	         /var/sub-wave/sessions \
	         /var/sub-wave/sfx
	chmod 777 /var/sub-wave \
	          /var/sub-wave/voice \
	          /var/sub-wave/voices \
	          /var/sub-wave/archive \
	          /var/sub-wave/jingles \
	          /var/sub-wave/logs \
	          /var/sub-wave/sessions \
	          /var/sub-wave/sfx

	# Liquidsoap's reload_mode="watch" playlists need the files to exist.
	touch /var/sub-wave/auto.m3u /var/sub-wave/jingles.m3u
	chmod 666 /var/sub-wave/auto.m3u /var/sub-wave/jingles.m3u

	# Keep a co-located Navidrome from scanning the station's own hourly
	# archive mixdowns as junk "HH-00" tracks (issue #273).
	touch /var/sub-wave/archive/.ndignore

	# Liquidsoap writes radio.log here as the liquidsoap user.
	mkdir -p /var/log/liquidsoap
	chown -R liquidsoap:liquidsoap /var/log/liquidsoap 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Warn loudly if the state dir isn't a mounted volume. With no host path (or
# volume) mapped to /var/sub-wave, everything the station writes — settings,
# library.db with the acoustic analysis, hourly archives, the model cache —
# lives in the container's throwaway writable layer, and the next image update
# (which recreates the container) silently wipes it. The Unraid CA template maps
# this as a required Appdata path; a bare `docker run` that forgets `-v` is the
# footgun this catches (issue #902). A real bind/volume mount gets its own entry
# in /proc/mounts at the target path; an un-mapped dir on the overlay fs doesn't.
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
# Resolve the three ICECAST_*_PASSWORD values and render icecast.xml.
# Precedence (unchanged from broadcast-entrypoint): env override > persisted
# state/icecast-secrets.env > freshly generated. Resolved values are exported
# (liquidsoap reads ICECAST_SOURCE_PASSWORD from the environment) and written
# back to the secrets file for operator visibility + the documented rotate path.
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
	# 0600: holds the Icecast passwords, read only by root (this supervisor
	# sources it, and the in-process controller reads it off the state dir —
	# all root in the AIO's single container). Keep it owner-only.
	chmod 600 "$SECRETS"

	export ICECAST_SOURCE_PASSWORD ICECAST_ADMIN_PASSWORD ICECAST_RELAY_PASSWORD
	# Liquidsoap connects to icecast over loopback inside this container;
	# radio.liq reads ICECAST_HOST (default "icecast").
	export ICECAST_HOST=localhost
}

# ---------------------------------------------------------------------------
# Render icecast.xml from the template + resolved secrets. Called on EVERY
# broadcast pair (re)launch — not just boot — so a restart-mixer picks up a
# flipped listener-auth flag (or a changed buffer/bitrate setting) the same
# way the split stack's container restart re-runs its entrypoint.
# ---------------------------------------------------------------------------
read_state_num() {
	# $1 = filename under /var/sub-wave, $2 = fallback. Non-numeric/missing → fallback.
	local _v
	_v=$(cat "/var/sub-wave/$1" 2>/dev/null || true)
	case "$_v" in
		''|*[!0-9]*) echo "$2" ;;
		*) echo "$_v" ;;
	esac
}

render_icecast() {
	# Concurrent-listener ceiling (<limits><clients>). Empty/unset → the stock 100.
	# A non-numeric value would render invalid XML and fail icecast at boot,
	# so fall back to the default with a warning instead.
	ICECAST_MAX_CLIENTS="${ICECAST_MAX_CLIENTS:-100}"
	case "$ICECAST_MAX_CLIENTS" in
		*[!0-9]*|'')
			log "ICECAST_MAX_CLIENTS='$ICECAST_MAX_CLIENTS' is not a number — using 100"
			ICECAST_MAX_CLIENTS=100
			;;
	esac

	# Listener buffer depth — same contract as docker/broadcast-entrypoint.sh
	# (#1114): burst-size is a byte count, so it's derived from
	# settings.stream.bufferSeconds x each mount's bitrate. Re-read on every
	# pair launch so a settings change lands after a restart-mixer.
	local STREAM_BITRATE BUFFER_SECONDS OPUS_BITRATE AAC_BITRATE FLAC_BITRATE_EST
	STREAM_BITRATE="${ICECAST_STREAM_BITRATE:-$(read_state_num liquidsoap_stream_bitrate.txt 192)}"
	BUFFER_SECONDS="${ICECAST_BUFFER_SECONDS:-$(read_state_num liquidsoap_stream_buffer_seconds.txt 22)}"
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
	# only a literal 'true' in the controller-written flag file enables, and
	# each stream mount then gets an <authentication type="url"> block. The
	# controller runs in-process here, so the callback goes over loopback.
	local FLAG=/var/sub-wave/icecast_listener_auth.txt
	local AUTH_URL="${LISTENER_AUTH_URL:-http://localhost:7701/listener-auth}"
	local LISTENER_AUTH=false
	if [ "$(cat "$FLAG" 2>/dev/null | tr -d '[:space:]')" = "true" ]; then
		LISTENER_AUTH=true
		log "listener auth ON — mounts require credentials via $AUTH_URL"
	fi

	# One <mount> block per stream mount, ALWAYS rendered: each carries its
	# own burst/queue sized for its own bitrate (the global <limits> value
	# only fits the MP3 mount), plus the auth block when the toggle is on.
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

	sed \
		-e "s|\${ICECAST_SOURCE_PASSWORD}|$ICECAST_SOURCE_PASSWORD|g" \
		-e "s|\${ICECAST_ADMIN_PASSWORD}|$ICECAST_ADMIN_PASSWORD|g" \
		-e "s|\${ICECAST_RELAY_PASSWORD}|$ICECAST_RELAY_PASSWORD|g" \
		-e "s|\${ICECAST_MAX_CLIENTS}|$ICECAST_MAX_CLIENTS|g" \
		-e "s|\${ICECAST_BURST_SIZE}|$ICECAST_BURST_SIZE|g" \
		-e "s|\${ICECAST_QUEUE_SIZE}|$ICECAST_QUEUE_SIZE|g" \
		-e "/<!--@STREAM_MOUNTS@-->/r $MOUNTS_XML" \
		-e "/<!--@STREAM_MOUNTS@-->/d" \
		"$TEMPLATE" > "$RENDERED"
	chown icecast2 "$RENDERED" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Service launchers. Each blocks until its process exits, so the supervise()
# loop can restart it. Do NOT `exec` — that would replace the loop.
# ---------------------------------------------------------------------------

# icecast2 + liquidsoap as a unit. Returns when either dies (the loop bounces
# the pair). icecast runs as the icecast2 user; liquidsoap as the liquidsoap
# user (uid 10000). `sudo -E` preserves the resolved ICECAST_* env.
run_broadcast() {
	# Re-render on every pair launch so a flipped listener-auth flag lands
	# after a restart-mixer (which bounces this pair, not the container).
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
	# TEMPORARY (re-harden later): run liquidsoap as root instead of dropping to
	# the `liquidsoap` user — same reason as docker/broadcast-entrypoint.sh. The
	# savonet base bump 2.2.5 -> 2.4.4 changed that user's uid (10000 -> 100), so
	# state files persisted under /var/sub-wave by the old image became unwritable
	# to uid 100 and every on_meta write EACCES'd. Root ignores those perms.
	# Restore the privilege drop once the state files are chowned to the new uid
	# (radio.liq's settings.init.allow_root is set for the same reason).
	liquidsoap /etc/liquidsoap/radio.liq &
	local lq=$!

	wait -n "$ic" "$lq"
	local code=$?
	log "broadcast pair: a child exited ($code) — taking the other down"
	kill -TERM "$ic" "$lq" 2>/dev/null || true
	wait "$ic" "$lq" 2>/dev/null || true
	return "$code"
}

# Controller — the AI DJ brain. The *_HOST/*_URL overrides repoint it from the
# compose service names (broadcast:7702 / 1234) at loopback. DOCKER_HOST and
# TTS_HEAVY_URL are intentionally unset: the Stats system panel degrades
# gracefully and TTS falls back to the bundled Piper voice. All other config
# (Navidrome, LLM, ADMIN_*, SITE_URL, TZ) is inherited from the container env
# and the first-run wizard's settings.json.
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
# Boot.
# ---------------------------------------------------------------------------
warn_if_state_unmounted
init_state
init_secrets

# On stop, signal the whole process group once, then give the children time to
# shut down before exiting (reset the trap first so the kill doesn't re-enter
# this handler). The grace period matters: this script is PID 1, and the
# instant it exits the container namespace is torn down and everything left
# gets SIGKILLed — which robbed the controller of its SIGTERM handler and left
# library.db's WAL sidecar un-checkpointed on every stop (#786). `wait` covers
# the supervise loops; the sleep covers their children (node etc.), which get
# reparented to us when the loops die and which bash's wait can't see. Docker's
# stop timeout (default 10s) still hard-caps the whole thing.
trap 'trap "" TERM INT; log "shutting down"; kill -TERM 0 2>/dev/null; wait; sleep 2; exit 0' TERM INT

supervise broadcast  run_broadcast  &
supervise controller run_controller &
supervise web        run_web        &
supervise caddy      run_caddy      &

wait
