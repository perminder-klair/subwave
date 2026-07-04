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
         /var/sub-wave/music \
         /var/sub-wave/sfx
chmod 777 /var/sub-wave \
          /var/sub-wave/voice \
          /var/sub-wave/voices \
          /var/sub-wave/archive \
          /var/sub-wave/jingles \
          /var/sub-wave/logs \
          /var/sub-wave/sessions \
          /var/sub-wave/music \
          /var/sub-wave/sfx
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
# Plain sed is enough for three placeholders; the secrets are hex so there's
# no escaping risk. Using `|` as the sed delimiter keeps slashes safe.

sed \
    -e "s|\${ICECAST_SOURCE_PASSWORD}|$ICECAST_SOURCE_PASSWORD|g" \
    -e "s|\${ICECAST_ADMIN_PASSWORD}|$ICECAST_ADMIN_PASSWORD|g" \
    -e "s|\${ICECAST_RELAY_PASSWORD}|$ICECAST_RELAY_PASSWORD|g" \
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

# ---- Wait for either to die, then exit -------------------------------------
# `wait -n` is a bash builtin (and not yet in dash, which is /bin/sh on the
# savonet image — hence the bash shebang at the top). If either child exits,
# kill the other and propagate the exit code so docker restarts the container.

trap 'kill -TERM "$ICECAST_PID" "$LIQ_PID" 2>/dev/null || true' INT TERM

wait -n "$ICECAST_PID" "$LIQ_PID"
EXIT=$?

echo "broadcast: child exited ($EXIT) — taking the other down" >&2
kill -TERM "$ICECAST_PID" "$LIQ_PID" 2>/dev/null || true
wait 2>/dev/null || true

exit "$EXIT"
