# SUB/WAVE launchd plists (macOS native install)

Templates with `${VAR}` placeholders — `scripts/install-native.sh` substitutes
them via `envsubst` and writes the rendered plists into
`~/Library/LaunchAgents/com.subwave.<service>.plist`.

`launchctl bootstrap gui/$UID …` (or the older `launchctl load …`) registers
them; `RunAtLoad=true` + `KeepAlive=true` give the same boot + auto-restart
behaviour the systemd units have on Linux.

## Substituted variables

Same set as `systemd/` — see `systemd/README.md`.

## Day-to-day

```sh
# Load (run at next login + start now):
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.subwave.icecast.plist
# …repeat for liquidsoap / controller / web / caddy.

# Or, with the helper the installer drops in ${STATE_DIR}/bin/subwavectl:
subwavectl start
subwavectl status
subwavectl stop

# Logs:
tail -f ${STATE_DIR}/logs/controller.err
```

## Kokoro on macOS

`kokoro-onnx` historically has fiddly wheel issues on Apple Silicon —
`install-native.sh` skips the Kokoro venv on macOS, so the controller falls
back to Piper / cloud TTS. The plist still exports `KOKORO_*` env vars so
flipping the bundled fallback back on is a config edit + service reload, not
a re-install.
