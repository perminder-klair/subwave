#!/usr/bin/env bash
# Which installed builds can an OTA on <channel> reach?
#
# A build receives an EAS Update only if BOTH match the published update:
#   1. channel  — baked into the build at build time
#   2. runtime version (fingerprint) — must equal the update's runtime
#
# This lists recent FINISHED builds with their channel + runtime so you can
# eyeball which ones are on the target channel, then compare their runtime to
# the runtime `eas update` printed when you published. Equal runtime + matching
# channel => that build gets the update. channel=None / runtime=None builds are
# pre-OTA and never receive updates.
#
# Usage: ota-delivery-check.sh [channel]   (default: production)
set -euo pipefail

CHANNEL="${1:-production}"
APP="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)/app"
cd "$APP"

echo "Builds (FINISHED). A build gets an OTA on '$CHANNEL' only if channel='$CHANNEL' AND its"
echo "runtime equals the runtime 'eas update' printed for that platform."
echo

eas build:list --limit 12 --non-interactive --json 2>/dev/null | python3 -c "
import json, sys
target = '$CHANNEL'
builds = json.load(sys.stdin)
for b in builds:
    if b.get('status') != 'FINISHED':
        continue
    ch = b.get('channel')
    rt = b.get('runtimeVersion')
    plat = b.get('platform', '?')
    ver = f\"v{b.get('appVersion')} ({b.get('appBuildVersion')})\"
    if ch is None or rt is None:
        mark = '   pre-OTA — never updates'
    elif ch == target:
        mark = f'   <- on {target}: gets OTA if runtime matches'
    else:
        mark = ''
    print(f\"  {plat:8} channel={str(ch):12} runtime={str(rt):42} {ver}{mark}\")
"

echo
echo "Compare the runtime above to what 'eas update --channel $CHANNEL' printed."
echo "Builds marked 'pre-OTA' need a fresh install from TestFlight / the Android link."
