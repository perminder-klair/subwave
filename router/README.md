# SUB/WAVE music router

Serves the Subsonic API the SUB/WAVE controller already speaks, and answers it from **music-source plugins**: Jellyfin, Plex, Navidrome, a generated demo library, and anything installed in `state/router/plugins/`. It is what lets a station play from something other than Navidrome without the controller, Liquidsoap or the analyzer knowing.

It ships as the `router` service in every compose file and idles until **Admin → Settings → Music source** selects it. See [`docs/internals/music-sources.md`](../docs/internals/music-sources.md) for how it fits, and [`docs/music-source-plugins.md`](../docs/music-source-plugins.md) to write a plugin.

## Run it

```bash
npm install
npm test                          # unit, HTTP, merge and conformance tests
npm run lint                      # tsc --noEmit

# Standalone, serving the demo library (no controller needed):
ROUTER_DIR=/tmp/router ROUTER_SOURCE=mock ROUTER_USER=me ROUTER_PASS=a-long-password \
  npm start                       # http://localhost:4534
```

Probe it like any Subsonic server:

```bash
SALT=abc123; TOKEN=$(printf 'a-long-password%s' "$SALT" | md5sum | cut -d' ' -f1)
curl "http://localhost:4534/rest/search3?u=me&t=$TOKEN&s=$SALT&v=1.16.1&c=probe&f=json&query=neon"
```

## Configuration

The controller writes `state/router/config.json` (credentials and the active station's selection); the router polls it and also reloads on `POST /internal/reload`. Environment:

| Var | Default | |
| --- | --- | --- |
| `PORT` | `4534` | |
| `ROUTER_HOST` | `0.0.0.0` | |
| `ROUTER_DIR` | `/var/sub-wave-router` | holds `config.json`, `plugins/`, `data/` |
| `ROUTER_PLUGINS_DIR` | `$ROUTER_DIR/plugins` | |
| `ROUTER_POLL_MS` | `2000` | config poll |
| `ROUTER_OP_TIMEOUT_MS` | `25000` | per plugin op; under the controller's 30s |
| `ROUTER_MEDIA_TIMEOUT_MS` | `30000` | time for a stream to start answering |
| `ROUTER_LOG_REQUESTS` | — | `1` logs every Subsonic request |
| `ROUTER_SOURCE`, `ROUTER_USER`, `ROUTER_PASS` | — | dev/test only: used when `config.json` has no sources / no credentials |
| `JELLYFIN_*`, `PLEX_*`, `SONG_MIN_SEC`, … | — | per-field overrides declared in each plugin's manifest (`env`) |

## Conformance kit

```bash
npm run conformance -- <plugin-dir> [--config key=value …] [--allow-writes] [--json]
npm run conformance -- src/sources/jellyfin --builtin --config url=http://jellyfin:8096 --config apiKey=…
```

`npm test` runs it against every plugin that works offline. The live Jellyfin/Plex/Navidrome checks run when `CONFORMANCE_JELLYFIN_URL` / `_API_KEY`, `CONFORMANCE_PLEX_URL` / `_TOKEN` or `CONFORMANCE_NAVIDROME_URL` / `_USER` / `_PASS` are set.
