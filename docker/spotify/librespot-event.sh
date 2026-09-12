#!/usr/bin/env bash
# librespot --onevent target: turn the player's event (env vars, see
# https://github.com/librespot-org/librespot/wiki/Events) into a line the
# controller reads. librespot runs event scripts in order and waits for each,
# so this must stay quick and must never block.
#
# TWO outputs. spotify-player.json holds the LATEST event (a status surface,
# same shape of contract as now-playing.json). spotify-events.jsonl is the
# append-only feed the controller actually consumes: track_changed and playing
# arrive ~20 ms apart, and a single marker overwritten in between lost the
# track_changed — with it the duration — on the first real run. Each line
# carries a sequence number from a counter file so the reader can resume
# exactly where it stopped even when two events share a millisecond.
#
# Only ids, positions and the event name are written: the controller already
# holds the catalog data for the track it commanded, and a title with an odd
# character has no business being escaped in bash. Written atomically (rename on
# the same filesystem) so the 500 ms reader never sees a torn file.
set -u
STATE_DIR="${SUBWAVE_STATE_DIR:-/var/sub-wave}"
OUT="$STATE_DIR/spotify-player.json"
TMP="$OUT.tmp.$$"

ev="${PLAYER_EVENT:-}"
[ -z "$ev" ] && exit 0

num() { case "$1" in ''|*[!0-9]*) printf 'null' ;; *) printf '%s' "$1" ;; esac; }
# ids are base62 / plain tokens — anything else is dropped rather than escaped.
tok() { case "$1" in *[!A-Za-z0-9:_-]*|'') printf '' ;; *) printf '%s' "$1" ;; esac; }
now_ms="$(date +%s%3N 2>/dev/null || echo "$(date +%s)000")"

SEQ_FILE="$STATE_DIR/spotify/.event-seq"
seq=$(( $(cat "$SEQ_FILE" 2>/dev/null || echo 0) + 1 ))
printf '%s' "$seq" > "$SEQ_FILE" 2>/dev/null || true

line=$(printf '{"seq":%s,"event":"%s","trackId":"%s","uri":"%s","positionMs":%s,"durationMs":%s,"at":%s}' \
    "$seq" "$(tok "$ev")" "$(tok "${TRACK_ID:-}")" "$(tok "${URI:-}")" \
    "$(num "${POSITION_MS:-}")" "$(num "${DURATION_MS:-}")" "$now_ms")
printf '%s\n' "$line" > "$TMP" && mv -f "$TMP" "$OUT"

FEED="$STATE_DIR/spotify-events.jsonl"
printf '%s\n' "$line" >> "$FEED" 2>/dev/null || true
# Keep the feed short; the reader tracks `seq`, not byte offsets, so a trim
# never loses its place.
if [ "$(wc -l < "$FEED" 2>/dev/null || echo 0)" -gt 600 ]; then
    tail -n 300 "$FEED" > "$FEED.tmp" 2>/dev/null && mv -f "$FEED.tmp" "$FEED"
fi

# A short rolling log for operators debugging the seam (last ~200 events).
LOG="$STATE_DIR/logs/spotify-events.log"
if [ -d "$STATE_DIR/logs" ]; then
    printf '%s %s track=%s pos=%s dur=%s\n' "$now_ms" "$ev" "${TRACK_ID:-}" "${POSITION_MS:-}" "${DURATION_MS:-}" >> "$LOG" 2>/dev/null || true
    if [ "$(wc -l < "$LOG" 2>/dev/null || echo 0)" -gt 400 ]; then
        tail -n 200 "$LOG" > "$LOG.tmp" 2>/dev/null && mv -f "$LOG.tmp" "$LOG"
    fi
fi
exit 0
