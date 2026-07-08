# subwave-mcp

[MCP](https://modelcontextprotocol.io) tools that let an agent drive the
**SUB/WAVE** personal radio station — request songs, queue exact tracks, and
put the AI DJ (voice, segments, skills, sound effects) on-air.

**Two ways to connect, same tools:**

- **HTTP (recommended)** — the controller serves MCP directly at `/api/mcp`. No
  clone, no local process. Jump to [Wiring it into a client](#wiring-it-into-a-client).
- **This stdio server** — a local-only launcher you run from a clone. Use it
  when you'd rather not expose the HTTP endpoint.

The tool set itself lives once in the controller (`controller/src/mcp/`); this
package is just the stdio launcher. See [`docs/mcp-server.md`](../docs/mcp-server.md)
for the full architecture write-up.

## Tools

| Tool | Auth | What it does |
|---|---|---|
| `subwave_health` | none | Liveness — controller reachable, stream on-air. |
| `subwave_now_playing` | none | Current track, station context, listener counts. |
| `subwave_station_state` | none | Upcoming queue, recent history, DJ booth log. |
| `subwave_schedule` | none | Personas, shows, weekly schedule grid. |
| `subwave_session` | none | The DJ's live session + recent transcript. |
| `subwave_request_song` | none | Natural-language song request — submits, then polls the outcome (~45s budget). |
| `subwave_request_status` | none | Poll an earlier request by its `requestId`. |
| `subwave_search_library` | admin | Deterministic library search (no LLM, no rate limit). |
| `subwave_queue_track` | admin | Queue an exact search result — no DJ intro. |
| `subwave_skip_track` | admin | Force-end the current track (operator override). |
| `subwave_dj_announce` | admin | Speak an update on-air (`styled`/`raw`), optionally over an `sfx` stinger. |
| `subwave_dj_segment` | admin | Fire a scripted segment: `station-id`, `hourly`, `link`, `banter`, `programme-*`. |
| `subwave_list_skills` | admin | The skill catalogue (built-in + operator skills). |
| `subwave_run_skill` | admin | Run a named skill segment now (weather, news, …). |
| `subwave_list_sfx` | admin | The sound-effects library. |
| `subwave_play_sfx` | admin | Fire a sound effect on-air immediately. |
| `subwave_refresh_playlist` | admin | Rebuild the fallback auto-playlist for the current mood. |

Listeners have no skip — track-end is the only transition, and a requested
song is **queued**, not played immediately. `subwave_skip_track` exists as a
deliberate admin-only operator override.

## Setup

No build step — the stdio launcher runs from source via `tsx`. It reaches into
the sibling `controller/` for the shared tool code, so run it from a full clone
with the controller's dependencies installed.

## Configuration

The server is configured entirely through environment variables:

| Variable | Default | Notes |
|---|---|---|
| `SUBWAVE_API_URL` | `http://localhost:7701` | Controller base URL. Prod (behind Caddy) is `http://localhost:7700/api`. |
| `SUBWAVE_ADMIN_USER` | — | Controller `ADMIN_USER`. Required for the DJ control tools. |
| `SUBWAVE_ADMIN_PASS` | — | Controller `ADMIN_PASS`. Required for the DJ control tools. |

The tools marked `none` above work without admin credentials. The admin tools
need them — if unset, those tools return an error explaining what to set.

## Wiring it into a client

### HTTP endpoint (recommended)

No install — the controller serves it whenever the stack is up. Point any MCP
client at `<station>/api/mcp` and pass admin creds as an `Authorization` header:

```bash
claude mcp add --transport http subwave https://your-station/api/mcp \
  --header "Authorization: Basic $(printf '%s' "$ADMIN_USER:$ADMIN_PASS" | base64)"
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "subwave": {
      "type": "http",
      "url": "https://your-station/api/mcp",
      "headers": { "Authorization": "Basic <base64 of user:pass>" }
    }
  }
}
```

The admin **Connect → MCP** tab pre-fills these with your station's real URL.

### Local stdio server

Runs from a clone via `tsx` (no build step). Inside this repo the root
`.mcp.json` already wires it up for Claude Code. For other checkouts or global
use:

```bash
claude mcp add subwave \
  --env SUBWAVE_API_URL=http://localhost:7701 \
  --env SUBWAVE_ADMIN_USER=admin \
  --env SUBWAVE_ADMIN_PASS=changeme \
  -- npx tsx /absolute/path/to/subwave/mcp-subwave/src/index.ts
```

Claude Desktop:

```json
{
  "mcpServers": {
    "subwave": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/subwave/mcp-subwave/src/index.ts"],
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
npm run lint      # tsc --noEmit (runs in CI)
npm run inspect   # MCP Inspector for manual testing (tsx, no build)
```

The stdio transport keeps `stdout` clean; the server logs only to `stderr`.

## Notes

- **Async requests.** `POST /request` returns a 202 receipt and the booth
  resolves in the background. `subwave_request_song` polls `GET /request/:id`
  every 2s for up to ~45s and reports the outcome; if the booth is still
  working it hands back the `requestId` for `subwave_request_status`.
- **Rate limits.** `subwave_request_song` hits the controller's public
  `/request` endpoint: 1 request per 20s, 8 per hour per source. On a 429 the
  tool returns the wait time so the agent can back off. The admin
  search/queue-track pair has no rate limit — prefer it when the exact track
  is known.
- **Zero-listener pause.** With nobody tuned in, the DJ idles and `/request`
  returns 503; the controller's explanation is passed through.
- **Admin endpoints.** The `subwave_dj_*`, skill, sfx, and skip tools bypass
  the DJ's frequency gate, cooldowns, and budget gates — they are an operator
  override. Use them deliberately.
- **Sound effects.** Effects are short stingers (≤10s) mixed over the
  programme. For an attention cue tied to spoken words (e.g. an airhorn ahead
  of an emergency weather warning), use `subwave_dj_announce`'s `sfx`
  parameter; `subwave_play_sfx` fires one standalone. For wording that must
  not be paraphrased, use `mode='raw'`.
- The controller must be running. If it isn't reachable, every tool returns an
  error naming the URL it tried and what to check.
