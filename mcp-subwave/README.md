# subwave-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an agent drive the
**SUB/WAVE** personal radio station — request songs and put the AI DJ on-air.

It wraps the SUB/WAVE controller's HTTP API as MCP tools, so any MCP client
(Claude Code, Claude Desktop, etc.) can ask the station to play a track or
announce an update.

## Tools

| Tool | Auth | What it does |
|---|---|---|
| `subwave_now_playing` | none | Current track, station context, listener counts. |
| `subwave_station_state` | none | Upcoming queue, recent history, DJ booth log. |
| `subwave_request_song` | none | Natural-language song request — the AI DJ matches, intros, and queues it. |
| `subwave_dj_announce` | admin | Make the DJ speak an update on-air (`styled` rewrite or `raw` verbatim). |
| `subwave_dj_segment` | admin | Fire a scripted segment: `station-id`, `hourly`, or `link`. |

There is no "skip" — track-end is the only transition. A requested song is
**queued**, not played immediately.

## Setup

```bash
npm install
npm run build
```

## Configuration

The server is configured entirely through environment variables:

| Variable | Default | Notes |
|---|---|---|
| `SUBWAVE_API_URL` | `http://localhost:7701` | Controller base URL. Prod (behind Caddy) is `http://localhost:7700/api`. |
| `SUBWAVE_ADMIN_USER` | — | Controller `ADMIN_USER`. Required for the DJ control tools. |
| `SUBWAVE_ADMIN_PASS` | — | Controller `ADMIN_PASS`. Required for the DJ control tools. |

`subwave_now_playing`, `subwave_station_state`, and `subwave_request_song` work
without admin credentials. `subwave_dj_announce` and `subwave_dj_segment` need
them — if unset, those tools return an error explaining what to set.

## Wiring it into a client

### Claude Code

```bash
claude mcp add subwave \
  --env SUBWAVE_API_URL=http://localhost:7701 \
  --env SUBWAVE_ADMIN_USER=admin \
  --env SUBWAVE_ADMIN_PASS=changeme \
  -- node /absolute/path/to/subwave/mcp-subwave/dist/index.js
```

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "subwave": {
      "command": "node",
      "args": ["/absolute/path/to/subwave/mcp-subwave/dist/index.js"],
      "env": {
        "SUBWAVE_API_URL": "http://localhost:7701",
        "SUBWAVE_ADMIN_USER": "admin",
        "SUBWAVE_ADMIN_PASS": "changeme"
      }
    }
  }
}
```

## Development

```bash
npm run watch     # recompile on change
npm run inspect   # build + open the MCP Inspector
```

The transport is stdio — keep `stdout` clean; the server logs only to `stderr`.

## Notes

- **Rate limits.** `subwave_request_song` hits the controller's public
  `/request` endpoint: 1 request per 20s, 8 per hour per source. On a 429 the
  tool returns the wait time so the agent can back off.
- **Admin endpoints.** `subwave_dj_announce` / `subwave_dj_segment` bypass the
  DJ's frequency gate — they are an operator override. Use them deliberately.
- The controller must be running. If it isn't reachable, every tool returns an
  error naming the URL it tried and what to check.
