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
RADIO_LIQ=/etc/liquidsoap/radio.liq

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
state_log() { log "$*"; }

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
	local mode=${2:-777}
	mkdir -p "$p" 2>/dev/null || true
	if [ ! -d "$p" ]; then
		state_warn "state dir $p could not be created — a read-only or unwritable mount; the station boots, but anything writing there will fail"
		return 0
	fi
	chmod "$mode" "$p" 2>/dev/null || true
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
	# The root is 1777, not 777 — see the entrypoint: the sticky bit keeps
	# every uid able to create files there, but only a file's owner can
	# rename or delete it, so no other uid can replace icecast-secrets.env.
	state_prepare_dir "$root" 1777
	# A single-station install serves from the root itself; a second plain
	# 777 would strip the sticky bit again.
	[ "$dir" = "$root" ] || state_prepare_dir "$dir"
	# stems + transitions are the analyzer's, and the only two dirs worth
	# relocating to a bigger disk — a bind mount there lands root-owned 755,
	# which the analyzer cannot write without this chmod.
	for sub in voice voices archive jingles logs sessions sfx stems transitions; do
		state_prepare_dir "$dir/$sub"
	done
	# A RELOCATED stem cache (SUBWAVE_STEMS_DIR — the container path of the
	# mount; compose sets it from STEMS_DIR, AIO operators pass -e) sits
	# outside $dir, so the loop above never reaches it and the mount would
	# keep its root-owned 755. Marker initialization shares any per-station
	# directories it creates too.
	if [ -n "${SUBWAVE_STEMS_DIR:-}" ]; then
		state_prepare_dir "$SUBWAVE_STEMS_DIR"
	fi
	# Liquidsoap's file watches on these need the files to exist.
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
# ANALYZER_REPLICAS=0 removes the compose `analyzer` SERVICE (#1570). The AIO
# has no services — the analyzer is an in-process venv the controller drives
# over stdio — so the variable is inert here, exactly like ANALYZER_HEAVY above.
#
# It fails worse than ANALYZER_HEAVY did, which is why it gets its own warning
# rather than a docs line. ANALYZER_HEAVY set on a lean AIO withholds a feature
# the operator wanted; ANALYZER_REPLICAS=0 set on an AIO withholds NOTHING and
# silently keeps charging for it — the whole point of setting 0 is usually to
# stop paying for analysis, and here analysis carries on with its RAM and its
# CPU while the operator believes it is off. Nothing in the UI contradicts them
# either: the acoustic engine keeps reading "on", which looks like the switch
# is broken rather than absent.
#
# So the warning names the knob that DOES work here: an empty ANALYZE_PYTHON.
# config.ts reads `envStr('ANALYZE_PYTHON', '')` and analyzer.ts's
# localConfigured() requires a non-empty existing path, so blanking the
# variable this image bakes in resolves no local backend at all.
#
# Only 0 warns. Any other value asks for the analyzer to RUN, which is what an
# AIO does anyway, so it earns the same quiet note ANALYZER_HEAVY gets on a
# heavy build: still inert, but the outcome already matches the request, and a
# scary box would send an operator whose setup is fine chasing a non-problem.
# ---------------------------------------------------------------------------
warn_if_analyzer_replicas_ignored() {
	[ -n "${ANALYZER_REPLICAS:-}" ] || return 0
	if [ "${ANALYZER_REPLICAS}" != "0" ]; then
		log "note: ANALYZER_REPLICAS is a docker-compose setting and has no effect"
		log "  on the all-in-one image — but it is not 0, so you are asking for the"
		log "  analyzer to run, which this image does in-process anyway. Nothing to do."
		return 0
	fi
	log "################################################################"
	log "WARNING: ANALYZER_REPLICAS=0 is set, and it does NOTHING on this image."
	log "  It is a docker-compose variable that sets the analyzer SERVICE's"
	log "  replica count. The all-in-one image has no analyzer service — it runs"
	log "  the analyzer IN-PROCESS (a librosa venv the controller drives), so"
	log "  analysis is still running and still using RAM and CPU right now."
	log "  The admin Library panel will keep reporting the acoustic engine as ON."
	log "  To actually stop analysis on this image, blank ANALYZE_PYTHON instead:"
	log "    ANALYZE_PYTHON=          (empty value — no local analysis backend)"
	log "  To send analysis to another machine, set ANALYZE_URL at it; a"
	log "  reachable sidecar wins over the in-process venv."
	log "  https://github.com/perminder-klair/subwave/issues/1570"
	log "################################################################"
}

# ---------------------------------------------------------------------------
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
# docker/broadcast-entrypoint.sh carries the same functions and the same
# messages; scripts/icecast-secrets.test.ts drives both from one table.
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

init_secrets() {
	resolve_icecast_secrets "$SECRETS"
	write_icecast_secrets "$SECRETS"
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
# override here would silently outrank the saved setting, and a controller
# older than stream-mounts.json would keep advertising that setting to
# /now-playing and voice-event timing.
stream_buffer_seconds() {
	read_state_uint liquidsoap_stream_buffer_seconds.txt 22
}

# A handoff number as a plain decimal. What the controller writes reads here as
# it does in radio.liq, and so does a CRLF or padded hand-edit: surrounding
# whitespace is trimmed (its string.trim), so liquidsoap is handed the bitrate it
# would have read itself, not the fallback. At most six digits (anything longer
# is the fallback), and leading zeros as decimal, never as bash arithmetic's
# octal. The trim below is quadratic, and a padded or corrupt file must not hold
# icecast and the dead-air guard back at boot, so whitespace runs are squeezed
# first and at most 64 bytes of that reach it. Squeezed, padding can neither push
# a value out of those bytes nor cut one in half, which a plain `head -c` of the
# file would: 62 spaces and 128 would read as 12. Other hand-edits part from
# radio.liq, whose int_of_string also takes 0x80, +128, 1_000 and 7+ digits: each
# of those is the fallback here.
read_state_uint() {
	local v
	v=$(tr -s '[:space:]' ' ' 2>/dev/null < "$STATE_DIR/$1" | head -c 64 || true)
	v=${v#"${v%%[![:space:]]*}"}
	v=${v%"${v##*[![:space:]]}"}
	case "$v" in ''|*[!0-9]*) v=$2 ;; esac
	[ "${#v}" -le 6 ] || v=$2
	echo "$(( 10#$v ))"
}

# A bitrate a burst can be sized for. Zero is junk here because radio.liq
# refuses it too (`v > 0`): a burst sized for 0 kbps holds nothing, while the
# encoder runs at its default.
read_state_kbps() {
	local v
	v=$(read_state_uint "$1" "$2")
	[ "$v" -gt 0 ] || v=$2
	echo "$v"
}

# A burst's bitrate, from ICECAST_*_BITRATE or the setting it overrides, as a
# plain number, so stream-mounts.json always holds valid JSON. $1 = the value,
# $2 = the default for junk. Bash arithmetic reads it, because the burst sizing
# always has: a leading zero is octal here (0100 is 64), and reading that as
# decimal would re-size the burst of a station that sets one. 0128 is not octal,
# and was an arithmetic error that aborted the render, so it reads as decimal,
# like a handoff file.
burst_kbps() {
	local v=$1
	case "$v" in
		''|*[!0-9]*) v=$2 ;;
		0*[89]*) v=$(( 10#$v )) ;;
	esac
	echo "$(( v ))"
}

# Liquidsoap source $1 on one line, with its comments out. Whichever form starts
# first wins, as in the lexer, so a `#<` inside a `#` comment opens nothing. Not
# a lexer: a `#` in a string cuts too. A `#<` that never closes leaves a bare
# %opus behind, which reads as doubt: Liquidsoap refuses such a file unless the
# `#<` sat in a string, and then what it cut is real code. scripts/opus-cbr.test.ts
# cuts the same way, and both answer to one table
# (scripts/test-utils/opus-cbr-table.ts).
liq_code() {
	awk '{
line = $0
while ((i = index(line, block ? ">#" : "#"))) {
    if (block) {
        block = 0
        line = substr(line, i + 2)
    } else if (substr(line, i, 2) == "#<") {
        block = 1
        code = code substr(line, 1, i - 1) " "
        line = substr(line, i + 2)
    } else {
        line = substr(line, 1, i - 1)
        break
    }
}
print code (block ? "" : line)
code = ""
}
END { if (block) print "%opus" }' "$1" 2>/dev/null | tr '\n' ' '
}

# The Opus mount's encoding, read from the radio.liq liquidsoap is about to load:
# `cbr` only when EVERY %opus encoder in it says vbr="none" (hard CBR, whose
# byte-sized burst holds the seconds it was sized for), `vbr` when any does not,
# and nothing when there is none to read. Taken from the encoder line itself,
# not declared beside it, so the answer changes in the same edit as the encoder
# (#2138) and cannot outlive it. A client may treat the Opus burst as seconds
# only on `cbr` (#2142); every doubt reads as not-CBR:
# - no vbr at all, or a bare %opus: the 2.4.6 default is constrained VBR;
# - any dtx but a literal false: true can stop sending silent frames whatever the
#   vbr mode, and dtx=(true) or dtx=d is as real;
# - vbr given twice: the last one wins, so one saying "none" proves nothing;
# - a `(` inside the call: the first `)` then need not close it, so a dtx or a
#   second vbr can sit past it, and `bitrate=(96), dtx=true` is DTX on 2.4.6;
# - libopus, an %ffmpeg encoder this cannot read.
# Read in the C locale, or a UTF-8 grep would take an em space for [[:space:]] and
# the operator's LC_ALL would change the answer.
opus_encoding() {
	local -x LC_ALL=C
	local calls key='[^[:alnum:]_]' eq='[[:space:]]*=[[:space:]]*'
	calls=$(liq_code "$1" | grep -oE 'libopus|%opus([[:space:]]*\([^)]*\)|[^[:alnum:]_])' || true)
	[ -n "$calls" ] || return 0
	if printf '%s\n' "$calls" | grep -qvE "${key}vbr$eq[\"']none[\"']" \
		|| printf '%s\n' "$calls" | grep -qE "libopus|\(.*\(|${key}vbr$eq.*${key}vbr$eq" \
		|| printf '%s\n' "$calls" | grep -oE "${key}dtx$eq[^,)[:space:]]*" | grep -qvE "^${key}dtx${eq}false$"; then
		echo vbr
	else
		echo cbr
	fi
	return 0
}

# Appends one stream mount to the icecast.xml fragment $1, and its entry to the
# caller's STREAM_MOUNTS_JSON. $2 = mount path, $3 = kbps this mount's burst is
# sized for, $4 = listener-auth URL already XML-escaped ('' = auth off), $5 =
# extra marker fields (',"key":"value"' or '').
emit_stream_mount() {
	local xml=$1 mount=$2 kbps=$3 auth_url=$4 extra=${5:-} burst queue
	burst=$(( BUFFER_SECONDS * kbps * 125 ))
	queue=$(( burst * 4 ))
	[ "$queue" -ge 2097152 ] || queue=2097152
	state_log "  $mount @ ${kbps}kbps → burst-size ${burst}B, queue-size ${queue}B"
	{
		echo '    <mount type="normal">'
		echo "        <mount-name>$mount</mount-name>"
		echo "        <burst-size>$burst</burst-size>"
		echo "        <queue-size>$queue</queue-size>"
		if [ -n "$auth_url" ]; then
			echo '        <authentication type="url">'
			echo "            <option name=\"listener_add\" value=\"$auth_url\"/>"
			echo '            <option name="auth_header" value="icecast-auth-user: 1"/>'
			# The station has ONE shared password and the username is ignored, so many
			# listeners present the same name (docs suggest `listener`). icecast-kh admits
			# one connection per username unless told otherwise: the second gets a 403,
			# or hangs unanswered when it arrives while the first is still closing, which
			# is what an iOS player's range probe followed by its real request does.
			echo '            <option name="allow_duplicate_users" value="1"/>'
			echo '        </authentication>'
		fi
		echo '    </mount>'
	} >> "$xml"
	STREAM_MOUNTS_JSON="$STREAM_MOUNTS_JSON,\"$mount\":{\"kbps\":$kbps,\"burstSeconds\":$BUFFER_SECONDS,\"burstBytes\":$burst$extra}"
	return 0
}

# Replaces the state marker $1 with the line $2, non-zero if it could not.
# Through a fresh mktemp file and a rename, like write_icecast_secrets, so a
# symlink planted ahead of the write is not written through, and one planted at
# $1 is replaced, not followed. The fixed-name temp this used to write is dropped
# first. 644 before the rename, so the marker never shows at mktemp's 600; a
# refused chmod is no failure, because a mount that refuses chmod is a working
# config (see state_writable_by_others).
write_state_marker() {
	local marker=$1 line=$2 tmp
	rm -f "$marker.tmp" 2>/dev/null || true
	tmp=$(mktemp "$marker.XXXXXX" 2>/dev/null) || return 1
	chmod 644 "$tmp" 2>/dev/null || true
	if printf '%s\n' "$line" > "$tmp" 2>/dev/null \
		&& mv -fT "$tmp" "$marker" 2>/dev/null; then
		return 0
	fi
	rm -f "$tmp" 2>/dev/null || true
	return 1
}

# $STATE_DIR/stream-mounts.json: what this render gave each mount (#2142).
# /now-playing advertises the MP3 mount's burstSeconds to listeners, so the
# marker is rewritten on EVERY render. A failed write removes the old one rather
# than leave it describing an earlier render (the controller then advertises the
# setting), and is never fatal, same rule as the state bootstrap above. Only
# when that removal fails too, as on a read-only state mount, does a marker
# outlive its render.
write_stream_mounts_marker() {
	# $1 = the mounts JSON object
	local dir=${STATE_DIR:-}
	[ -n "$dir" ] || return 0
	local marker=$dir/stream-mounts.json
	if ! write_state_marker "$marker" "{\"mounts\":$1,\"at\":$(date +%s)}"; then
		rm -f "$marker" 2>/dev/null || true
		state_warn "could not write $marker — the station is unaffected, but listeners may be told a buffer these mounts were not rendered with"
	fi
	return 0
}

# Listener buffer depth (<burst-size>, #993/#1114) for every stream mount, ALWAYS
# rendered (not just under auth). burst-size is a BYTE count, so it is sized in
# SECONDS and converted per mount's bitrate: one global figure sized for MP3 is
# a different depth everywhere else (22s of mp3-192k is ~43s of opus-96k, ~6s of
# FLAC). Each <queue-size> is 4x its burst, floored at 2 MB, or a client is
# evicted the moment it falls behind its own primed buffer (#993).
#
# Every setting is read ONCE, here (#2143). The same bitrates are handed to
# liquidsoap as SUBWAVE_{STREAM,OPUS,AAC}_BITRATE, which radio.liq takes before
# its own file read, so a save landing between this render and liquidsoap's
# start cannot size a burst for one encoder and build another. What was
# rendered goes to stream-mounts.json, because listeners must be told the burst
# these mounts hold, not a setting saved since (#2142). A change applies on the
# next pair launch.
#
#   render_stream_mounts $1=XML fragment path, $2=listener-auth URL already
#   XML-escaped ('' = auth off), $3=the radio.liq liquidsoap will load.
#
# Sets BUFFER_SECONDS, STREAM_BITRATE, OPUS_BITRATE, AAC_BITRATE,
# FLAC_BITRATE_EST, and the global <limits> ICECAST_BURST_SIZE /
# ICECAST_QUEUE_SIZE (sized for MP3).
#
# docker/broadcast-entrypoint.sh carries the same functions and the same
# messages; scripts/stream-mounts.test.ts drives both from one table.
render_stream_mounts() {
	local xml=$1 auth_url=$2 radio_liq=$3 opus_enc STREAM_MOUNTS_JSON=''
	BUFFER_SECONDS=$(stream_buffer_seconds)
	[ "$BUFFER_SECONDS" -le 60 ] || BUFFER_SECONDS=60
	SUBWAVE_STREAM_BITRATE=$(read_state_kbps liquidsoap_stream_bitrate.txt 192)
	SUBWAVE_OPUS_BITRATE=$(read_state_kbps liquidsoap_opus_bitrate.txt 96)
	SUBWAVE_AAC_BITRATE=$(read_state_kbps liquidsoap_aac_bitrate.txt 192)
	export SUBWAVE_STREAM_BITRATE SUBWAVE_OPUS_BITRATE SUBWAVE_AAC_BITRATE
	# ICECAST_*_BITRATE re-size a mount's burst and nothing else; the encoder
	# keeps the setting, as it always has.
	STREAM_BITRATE=$(burst_kbps "${ICECAST_STREAM_BITRATE:-$SUBWAVE_STREAM_BITRATE}" 192)
	OPUS_BITRATE=$(burst_kbps "${ICECAST_OPUS_BITRATE:-$SUBWAVE_OPUS_BITRATE}" 96)
	AAC_BITRATE=$(burst_kbps "${ICECAST_AAC_BITRATE:-$SUBWAVE_AAC_BITRATE}" 192)
	# FLAC is VBR with no bitrate setting — ~900 kbps is a typical average for
	# 44.1/16 stereo, close enough for a buffer depth.
	FLAC_BITRATE_EST=900

	# kbps → bytes/sec is bitrate * 1000 / 8 = bitrate * 125.
	ICECAST_BURST_SIZE=$(( BUFFER_SECONDS * STREAM_BITRATE * 125 ))
	ICECAST_QUEUE_SIZE=$(( ICECAST_BURST_SIZE * 4 ))
	[ "$ICECAST_QUEUE_SIZE" -ge 2097152 ] || ICECAST_QUEUE_SIZE=2097152

	opus_enc=$(opus_encoding "$radio_liq")
	state_log "listener buffer ${BUFFER_SECONDS}s @ mp3 ${STREAM_BITRATE}kbps / opus ${OPUS_BITRATE}kbps (${opus_enc:-unknown encoding}) / aac ${AAC_BITRATE}kbps / flac ~${FLAC_BITRATE_EST}kbps"
	: > "$xml"
	emit_stream_mount "$xml" /stream.mp3  "$STREAM_BITRATE"   "$auth_url"
	emit_stream_mount "$xml" /stream.opus "$OPUS_BITRATE"     "$auth_url" "${opus_enc:+,\"encoding\":\"$opus_enc\"}"
	emit_stream_mount "$xml" /stream.flac "$FLAC_BITRATE_EST" "$auth_url"
	emit_stream_mount "$xml" /stream.aac  "$AAC_BITRATE"      "$auth_url"
	write_stream_mounts_marker "{${STREAM_MOUNTS_JSON#,}}"
	return 0
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

# ---------------------------------------------------------------------------
# Trusted reverse proxies
# ---------------------------------------------------------------------------
# Real listener IPs in admin -> Listeners instead of the edge's container
# address. icecast-KH matches an EXACT IP: a CIDR is accepted and then silently
# never matches, so a malformed entry is DROPPED and named rather than
# interpolated — invalid XML here would turn a cosmetic setting into a station
# that won't boot.
#
#   $1 = XML fragment path, $2 = the source label the candidates came from,
#   $3.. = the candidate addresses (may be empty — a DNS lookup that resolved
#          nothing is the documented first-cold-boot case).
#
# Besides the fragment this writes $STATE_DIR/trusted-proxies.json — the count,
# the addresses, the source that produced them and anything dropped. Until
# #1613 the operator's only signal was one stderr line in this container,
# three layers away from the admin table showing one repeated private address,
# so the setting that fixes it was undiscoverable from where the symptom shows.
# The marker is rewritten on EVERY render, so it describes the config icecast is
# running unless that write failed, which leaves the last render's marker in
# place and is never fatal — same rule as the state bootstrap above.
#
# docker/broadcast-entrypoint.sh carries the same function and the same messages;
# scripts/trusted-proxies.test.ts drives both from one table.

# A dropped entry is operator input on its way into JSON, so it is reduced to a
# safe token first: address / CIDR / hostname characters only, length capped. A
# quote or backslash here would produce a marker the controller cannot parse,
# which is the one failure that would take the hint down along with the config
# it exists to explain.
trusted_proxy_token() {
	printf '%s' "$1" | tr -cd '0-9A-Za-z.:/_-' | cut -c1-48
}

# True when $1 has the SHAPE of an address icecast can match. A character class
# is not enough and that is measured: `''|*[!0-9a-fA-F.:]*` — the test both
# copies carried — accepts every hex-only word, so `cafe`, `beef`, `ace`, `ff`
# and a bare `a` were written into icecast.xml while `caddy` and `localhost`
# were dropped. Each one is an <x-forwarded-for> entry that no peer can ever
# equal, so it changed nothing on air; what makes it worth fixing is the count
# now in front of the operator, which would report three proxies trusted when
# one of them cannot match. A hint that lies is worse than the silence it
# replaced.
#
# Shape only, deliberately: whether the address is the RIGHT one is the
# operator's to know, and this must keep dropping rather than repairing.
trusted_proxy_valid() {
	local addr=$1 rest octet n=0
	# Anything with a colon is IPv6 (dots allowed for the ::ffff:1.2.3.4 form).
	# Not a full parser — a hex-digit requirement plus the charset is enough to
	# reject the words this exists to catch, and icecast's own exact match is
	# the real arbiter.
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
		# error, not a false, and would print before the drop.
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
	local marker=$dir/trusted-proxies.json line
	printf -v line '{"count":%s,"source":"%s","proxies":%s,"dropped":%s,"at":%s}' \
		"$1" "$2" "$3" "$4" "$(date +%s)"
	if ! write_state_marker "$marker" "$line"; then
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
	# Candidates arrive already word-split, so an operator who wrote prose
	# ("not a host") sees each WORD dropped separately rather than the phrase.
	# Left alone on purpose: the list has always been space-separated — it is
	# how the DNS path returns several addresses for one name, and how
	# ICECAST_TRUSTED_PROXY_IPS="1.2.3.4 5.6.7.8" has always been accepted —
	# and every one of those words is genuinely something that was not used.
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

render_icecast() {
	# Concurrent-listener ceiling — see resolve_max_clients above.
	local MAX_CLIENTS_LINE
	MAX_CLIENTS_LINE="$(resolve_max_clients)"
	ICECAST_MAX_CLIENTS="${MAX_CLIENTS_LINE%% *}"
	log "max listeners $ICECAST_MAX_CLIENTS (from ${MAX_CLIENTS_LINE#* })"

	# Listener auth (#478) — same contract as docker/broadcast-entrypoint.sh:
	# only a literal 'true' in the controller-written flag enables. The
	# controller runs in-process here, so the callback goes over loopback.
	local FLAG=$STATE_DIR/icecast_listener_auth.txt
	local AUTH_URL="${LISTENER_AUTH_URL:-http://localhost:7701/listener-auth}"
	# Escaped once: it lands inside an XML attribute, and a query string's `&`
	# is legitimate in a URL but not in icecast.xml. Empty renders no auth blocks.
	local MOUNT_AUTH_URL_XML=''
	if [ "$(cat "$FLAG" 2>/dev/null | tr -d '[:space:]')" = "true" ]; then
		MOUNT_AUTH_URL_XML=$(xml_escape "$AUTH_URL")
		log "listener auth ON — mounts require credentials via $AUTH_URL"
	fi

	# One <mount> block per stream mount, each burst sized for its own bitrate
	# (the global <limits> value only fits MP3), and the bitrates handed to
	# liquidsoap — see render_stream_mounts above. Its globals land in these
	# locals.
	local STREAM_BITRATE BUFFER_SECONDS OPUS_BITRATE AAC_BITRATE FLAC_BITRATE_EST
	local ICECAST_BURST_SIZE ICECAST_QUEUE_SIZE
	local MOUNTS_XML=/etc/icecast2/stream-mounts.xml
	render_stream_mounts "$MOUNTS_XML" "$MOUNT_AUTH_URL_XML" "$RADIO_LIQ"

	# Trusted reverse proxies — see render_trusted_proxies above. Caddy is in
	# THIS container, so the peer is always loopback; both forms are emitted
	# because which one icecast sees depends on how Caddy resolved its upstream
	# (icecast-KH wants an exact IP). ICECAST_TRUSTED_PROXY_IPS still overrides,
	# for an AIO behind a further proxy — and the source label records which of
	# the two the marker's addresses came from.
	local TRUSTED_XML=/etc/icecast2/trusted-proxies.xml
	local TRUSTED_LIST TRUSTED_SOURCE=aio-loopback
	if [ -n "${ICECAST_TRUSTED_PROXY_IPS:-}" ]; then
		TRUSTED_SOURCE=ICECAST_TRUSTED_PROXY_IPS
		TRUSTED_LIST=$(echo "$ICECAST_TRUSTED_PROXY_IPS" | tr ',' ' ')
	else
		TRUSTED_LIST="127.0.0.1 ::1"
	fi
	# Unquoted on purpose — the list is space-separated candidates.
	# shellcheck disable=SC2086
	render_trusted_proxies "$TRUSTED_XML" "$TRUSTED_SOURCE" $TRUSTED_LIST

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
	# by init_state at boot; a non-root station dir needs its own here). The
	# root is passed as the root so a station dir gets 777, not the root's
	# 1777, exactly as the entrypoint does.
	bootstrap_state_dirs "$STATE_ROOT" "$STATE_DIR"

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
	liquidsoap "$RADIO_LIQ" &
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
warn_if_analyzer_replicas_ignored
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
