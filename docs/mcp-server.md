# The SUB/WAVE MCP Server

How an AI agent talks to the radio station — requesting songs and driving the
DJ on-air over the [Model Context Protocol](https://modelcontextprotocol.io).

The server lives at [`mcp-subwave/`](../mcp-subwave/). For the always-on
broadcast pipeline see [`streaming-flow.md`](./streaming-flow.md); for the
human listener request path see [`request-flow.md`](./request-flow.md).

---

## The short version

```
MCP client            subwave-mcp              Controller
(Claude Code,   ──stdio/JSON-RPC──▶  ──HTTP──▶  (Express :7701
 Desktop, …)         5 tools                     /api behind Caddy)
```

`subwave-mcp` is a thin stdio MCP server. It owns no state and no logic of its
own — each tool is a typed wrapper over one controller HTTP endpoint. The model
gets five tools; the controller does the real work (LLM matching, track
selection, TTS, queueing).

It is the agent-facing twin of the listener request drawer: where a human types
into the browser and hits `POST /request`, an agent calls `subwave_request_song`
and the same endpoint runs.

---

## Why an MCP server (and not a skill)

A Claude Code *skill* is instructions — it would tell a model to `curl` the
controller itself. An *MCP server* is a typed capability surface: the tools,
their schemas, their auth, and their error handling are defined once, in code,
and every MCP client gets them identically. For an action surface that mutates
station state and carries rate limits and admin auth, that contract belongs in
code, not prose. The agent never sees a URL or an auth header — only five
intent-shaped tools.

---

## The five tools

| Tool | Endpoint | Auth | Mutates air? |
|---|---|---|---|
| `subwave_now_playing` | `GET /now-playing` | none | no |
| `subwave_station_state` | `GET /state` | none | no |
| `subwave_request_song` | `POST /request` | none | queues a track |
| `subwave_dj_announce` | `POST /dj/say` | admin | speaks now |
| `subwave_dj_segment` | `POST /dj/segment` | admin | speaks now |

### Read tools — `subwave_now_playing`, `subwave_station_state`

Both are read-only passthroughs. `now-playing` returns the current track,
station context (time, weather, dominant mood), and live listener counts;
`state` returns the upcoming queue, recent history, and the DJ booth log.

These exist so the agent can ground a request in what's actually on-air. A
request like *"something slower than this"* is only meaningful if the model
first knows what *this* is — the controller's `matchRequest` interprets vibe
queries against the current track, so a good agent reads before it writes.

### `subwave_request_song`

The headline tool. Takes a natural-language `request` (a track, an artist, a
vibe, or `"more like this"`) and an optional `requester` name. It calls
`POST /request`, where the controller runs the LLM matcher, resolves a track
through its pick cascade, generates a spoken DJ intro, and pushes it to the
queue.

Two things the tool description makes explicit to the model, because they are
easy to get wrong:

- **It queues, it does not interrupt.** There is no skip on SUB/WAVE —
  track-end is the only transition. A request lands *after* the current song.
- **It is rate-limited.** The public `/request` endpoint allows 1 call per 20s
  and 8 per hour per source. On an HTTP 429 the tool surfaces the controller's
  `Retry-After` in its error text, so the agent can back off instead of
  hammering.

### `subwave_dj_announce`

Puts a spoken update on-air via `POST /dj/say`. Two axes, both exposed as enums
with sensible defaults:

- **`mode`** — `styled` (default) hands the text to the LLM as an *instruction*
  and the DJ rewrites it in persona before speaking; `raw` speaks the text
  verbatim. Give a topic → `styled`. Give finished words → `raw`.
- **`placement`** — `solo` (default) is a heavy-ducked solo DJ moment (maps to
  the controller's `dj-speak` kind → `say.txt`); `over-track` is lightly ducked
  so the DJ talks over the playing song (maps to `link` → `intro.txt`).

### `subwave_dj_segment`

Fires a scripted voice segment — `station-id`, `hourly`, or `link` — on demand.
This is an operator override: it bypasses the DJ's `shouldFire` frequency gate.
For a custom message, `subwave_dj_announce` is the right tool.

---

## Authentication

The controller splits its surface in two (see
[`CLAUDE.md`](../CLAUDE.md) → middleware):

- **Public, rate-limited** — `/now-playing`, `/state`, `/request`. No auth.
- **Admin, Basic-auth gated** — `/dj/*`. Gated by the controller's
  `ADMIN_USER` / `ADMIN_PASS`.

`subwave-mcp` reads admin credentials from its own environment
(`SUBWAVE_ADMIN_USER` / `SUBWAVE_ADMIN_PASS`) and sends them as a Basic auth
header only on the admin tools. If they are unset, the read and request tools
still work; the two DJ-control tools return an error that names exactly which
env vars to set. The credentials live in the MCP client's config, never in a
prompt.

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SUBWAVE_API_URL` | `http://localhost:7701` | Controller base URL. Prod behind Caddy: `http://localhost:7700/api`. |
| `SUBWAVE_ADMIN_USER` | — | Matches the controller's `ADMIN_USER`. |
| `SUBWAVE_ADMIN_PASS` | — | Matches the controller's `ADMIN_PASS`. |

In dev the controller is exposed directly on `:7701`. In prod only Caddy binds
a host port, so the server must target `:7700/api` — the `handle_path` rule
strips the `/api` prefix before the controller sees the route.

---

## Error handling

Every failure becomes a `SubwaveError` whose message is written for the *agent*
to act on, not for a log:

- **Controller unreachable** → names the URL it tried and the dev/prod
  defaults to check.
- **HTTP 429** → the cooldown in seconds, plus the rate-limit policy.
- **HTTP 401/403** → whether credentials are missing entirely or simply don't
  match the controller's.
- **HTTP 503** → song requests are closed (`REQUESTS_DISABLED` on the
  controller).

The tool wrapper catches these and returns them as MCP error results
(`isError: true`) rather than throwing, so the model sees the message and can
recover within the same turn.

---

## Running it

```bash
cd mcp-subwave
npm install
npm run build      # → dist/index.js
npm run inspect    # build + MCP Inspector for manual testing
```

Wire it into a client by pointing at `dist/index.js` with `node` and passing
the three env vars — see [`mcp-subwave/README.md`](../mcp-subwave/README.md)
for ready-to-paste Claude Code and Claude Desktop snippets.

The controller must be running first — start the stack with the `subwave-control`
skill or `docker compose up -d` (see [`CLAUDE.md`](../CLAUDE.md)).

---

## Source map

| File | Role |
|---|---|
| `mcp-subwave/src/index.ts` | MCP server: registers the five tools, stdio transport, error-to-result wrapper. |
| `mcp-subwave/src/client.ts` | `SubwaveClient` — typed HTTP client, Basic auth, `SubwaveError` with actionable messages. |
| `mcp-subwave/package.json` | `subwave-mcp` bin, build scripts, MCP SDK + Zod deps. |
