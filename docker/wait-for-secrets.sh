#!/bin/sh
# Source /var/sub-wave/icecast-secrets.env then exec the given command.
#
# In compose deployments, depends_on: { condition: service_healthy } on the
# icecast service guarantees the file is present before we start. The short
# wait loop below is defense in depth for non-compose or hand-spun deployments.
# Bails loudly after ~10s — better to crash visibly than to start up with
# blank passwords and silently fail to publish to icecast.

set -eu

SECRETS=/var/sub-wave/icecast-secrets.env

for i in 1 2 3 4 5 6 7 8 9 10; do
    [ -f "$SECRETS" ] && break
    echo "wait-for-secrets: $SECRETS not present yet (attempt $i/10), sleeping 1s" >&2
    sleep 1
done

if [ ! -f "$SECRETS" ]; then
    echo "wait-for-secrets: $SECRETS still missing after 10s — refusing to start" >&2
    echo "wait-for-secrets: is the icecast container running and writing to the shared state mount?" >&2
    exit 1
fi

set -a
# shellcheck disable=SC1090
. "$SECRETS"
set +a

exec "$@"
