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

	sed \
		-e "s|\${ICECAST_SOURCE_PASSWORD}|$ICECAST_SOURCE_PASSWORD|g" \
		-e "s|\${ICECAST_ADMIN_PASSWORD}|$ICECAST_ADMIN_PASSWORD|g" \
		-e "s|\${ICECAST_RELAY_PASSWORD}|$ICECAST_RELAY_PASSWORD|g" \
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
	sudo -E -u liquidsoap liquidsoap /etc/liquidsoap/radio.liq &
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
init_state
init_secrets

# On stop, signal the whole process group once and bail (reset the trap first
# so the kill doesn't re-enter this handler).
trap 'trap "" TERM INT; log "shutting down"; kill -TERM 0 2>/dev/null; exit 0' TERM INT

supervise broadcast  run_broadcast  &
supervise controller run_controller &
supervise web        run_web        &
supervise caddy      run_caddy      &

wait
