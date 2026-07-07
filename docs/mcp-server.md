# The SUB/WAVE MCP Server

How an AI agent talks to the radio station — requesting songs, queueing exact
tracks, and driving the DJ (voice, segments, skills, sound effects) on-air over
the [Model Context Protocol](https://modelcontextprotocol.io).

The server lives at [`mcp-subwave/`](../mcp-subwave/). For the always-on
broadcast pipeline see [`streaming-flow.md`](./streaming-flow.md); for the
human listener request path see [`request-flow.md`](./request-flow.md).

---

## The short version

```
MCP client            subwave-mcp              Controller
(Claude Code,   ──stdio/JSON-RPC──▶  ──HTTP──▶  (Express :7701
 Desktop, …)         17 tools                    /api behind Caddy)
```

`subwave-mcp` is a thin stdio MCP server. It owns no state and almost no logic
of its own — each tool is a typed wrapper over one controller HTTP endpoint
(the one exception: `subwave_request_song` polls the request receipt so the
agent gets an outcome, not a ticket). The model gets seventeen tools; the
controller does the real work (LLM matching, track selection, TTS, queueing).

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
code, not prose. The agent never sees a URL or an auth header — only
intent-shaped tools.

---

## The tools

| Tool | Endpoint | Auth | Mutates air? |
|---|---|---|---|
| `subwave_health` | `GET /health` | none | no |
| `subwave_now_playing` | `GET /now-playing` | none | no |
| `subwave_station_state` | `GET /state` | none | no |
| `subwave_schedule` | `GET /schedule` | none | no |
| `subwave_session` | `GET /session` | none | no |
| `subwave_request_song` | `POST /request` + `GET /request/:id` | none | queues a track |
| `subwave_request_status` | `GET /request/:id` | none | no |
| `subwave_search_library` | `GET /dj/search` | admin | no |
| `subwave_queue_track` | `POST /dj/queue-track` | admin | queues a track |
| `subwave_skip_track` | `POST /dj/skip` | admin | ends the current track |
| `subwave_dj_announce` | `POST /dj/say` | admin | speaks now |
| `subwave_dj_segment` | `POST /dj/segment` | admin | speaks now |
| `subwave_list_skills` | `GET /dj/skills` | admin | no |
| `subwave_run_skill` | `POST /dj/skill` | admin | speaks now |
| `subwave_list_sfx` | `GET /sfx` | admin | no |
| `subwave_play_sfx` | `POST /sfx/:name/play` | admin | plays a stinger now |
| `subwave_refresh_playlist` | `POST /dj/refresh-playlist` | admin | no (fallback playlist only) |

### Read tools — `subwave_health`, `subwave_now_playing`, `subwave_station_state`, `subwave_schedule`, `subwave_session`

All read-only passthroughs. `now-playing` returns the current track, station
context (time, weather, dominant mood), and live listener counts; `state`
returns the upcoming queue, recent history, and the DJ booth log; `schedule`
the personas, shows, and weekly grid (in the station's timezone); `session`
the DJ's live session identity and recent transcript turns.

These exist so the agent can ground a request in what's actually on-air. A
request like *"something slower than this"* is only meaningful if the model
first knows what *this* is — the controller's `matchRequest` interprets vibe
queries against the current track, so a good agent reads before it writes.
`schedule` matters for the show-bound segments: `banter` needs a guest show on
air, `programme-*` a programme show.

### `subwave_request_song` and `subwave_request_status`

The headline tool. Takes a natural-language `request` (a track, an artist, a
vibe, or `"more like this"`) and an optional `requester` name. `POST /request`
hands back a **202 receipt** and the booth resolves the request in the
background (LLM matcher, pick cascade, spoken intro, queue push) — so the tool
polls `GET /request/:id` (2s interval, ~45s budget) and reports the outcome:
matched track + queue position + the DJ's ack, or the miss message. If the
booth is still working past the budget, the tool returns the `requestId` and
points the agent at `subwave_request_status`.

Three things the tool description makes explicit to the model, because they
are easy to get wrong:

- **It queues, it does not interrupt.** A request lands *after* the current
  song. (Listeners have no skip; the admin-gated `subwave_skip_track` is the
  deliberate operator override.)
- **It is rate-limited.** The public `/request` endpoint allows 1 call per 20s
  and 8 per hour per source. On an HTTP 429 the tool surfaces the controller's
  `Retry-After` in its error text, so the agent can back off instead of
  hammering.
- **It pauses with the station.** With zero listeners tuned in the DJ idles
  and `/request` returns 503 — the controller's explanation is passed through.

### `subwave_search_library` and `subwave_queue_track`

The deterministic path: search Navidrome by terms (12 queue-ready results with
mood tags), then queue an exact result by id. Admin-gated, no LLM, no rate
limit, no DJ intro. This is the right pair when the agent already knows the
exact track; `subwave_request_song` is for vibes and natural language.

### `subwave_dj_announce`

Puts a spoken update on-air via `POST /dj/say`. Three axes:

- **`mode`** — `styled` (default) hands the text to the LLM as an *instruction*
  and the DJ rewrites it in persona before speaking; `raw` speaks the text
  verbatim. Give a topic → `styled`. Give finished words → `raw` (also the
  right choice for emergency wording that must not be paraphrased).
- **`placement`** — `solo` (default) is a heavy-ducked solo DJ moment (maps to
  the controller's `dj-speak` kind → `say.txt`); `over-track` is lightly ducked
  so the DJ talks over the playing song (maps to `link` → `intro.txt`).
- **`sfx`** — optional name of a library sound effect aired under the opening
  words as an attention stinger (e.g. `airhorn` ahead of a weather warning).
  Names come from `subwave_list_sfx`; an unknown name is a 400 listing the
  catalogue.

### `subwave_dj_segment`

Fires a scripted voice segment on demand: `station-id`, `hourly`, `link`,
`banter` (multi-voice guest exchange — needs a guest show on air), or
`programme-intro` / `programme-feature` / `programme-outro` (episode beats —
need a programme show on air). This is an operator override: it bypasses the
DJ's `shouldFire` frequency gate. For a custom message, `subwave_dj_announce`
is the right tool.

### `subwave_list_skills` and `subwave_run_skill`

`list` returns the skill catalogue — the seven built-ins (weather, news,
traffic, curiosity, album-anniversary, library-deep-cut, web-search) plus any
operator-authored skills from `state/skills/`. `run` fires one by name through
the segment director, which fetches real data (forecast, headlines, …) before
voicing it. Manual runs ignore cooldowns and work even on disabled skills.

### `subwave_list_sfx` and `subwave_play_sfx`

`list` returns the sound-effects library (short stingers, ≤10s). `play` fires
one on-air immediately, mixed over the programme with a light duck — the
automation-facing trigger for external alerting agents. To pair a stinger with
spoken words, prefer `subwave_dj_announce`'s `sfx` parameter, which aligns the
effect with the voice's first words.

---

## Authentication

The controller splits its surface in two (see
[`CLAUDE.md`](../CLAUDE.md) → middleware):

- **Public** — `/health`, `/now-playing`, `/state`, `/schedule`, `/session`,
  `/request` (rate-limited), `/request/:id`. No auth.
- **Admin, Basic-auth gated** — `/dj/*` and `/sfx`. Gated by the controller's
  `ADMIN_USER` / `ADMIN_PASS`.

`subwave-mcp` reads admin credentials from its own environment
(`SUBWAVE_ADMIN_USER` / `SUBWAVE_ADMIN_PASS`) and sends them as a Basic auth
header only on the admin tools. If they are unset, the read and request tools
still work; the DJ-control tools return an error that names exactly which
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
- **HTTP 503** → the controller's own explanation is passed through — song
  requests closed by the operator (`REQUESTS_DISABLED`) or the zero-listener
  autopilot pause.

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
for ready-to-paste Claude Code and Claude Desktop snippets. Inside this repo,
the root [`.mcp.json`](../.mcp.json) already wires it up for Claude Code —
build once and the tools are available in any session opened here.

The controller must be running first — start the stack with the `subwave-control`
skill or `docker compose up -d` (see [`CLAUDE.md`](../CLAUDE.md)).

---

## Source map

| File | Role |
|---|---|
| `mcp-subwave/src/index.ts` | MCP server: registers the tools, stdio transport, request polling, error-to-result wrapper. |
| `mcp-subwave/src/client.ts` | `SubwaveClient` — typed HTTP client, Basic auth, `SubwaveError` with actionable messages. |
| `mcp-subwave/package.json` | `subwave-mcp` bin, build scripts, MCP SDK + Zod deps. |
