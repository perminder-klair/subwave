# The SUB/WAVE API

SUB/WAVE exposes a large HTTP API, an [MCP server](./mcp-server.md), Icecast
stream mounts, and outbound [webhooks](../controller/src/routes/webhooks.ts).
The easiest way to discover and try all of it is the built-in **Connect** page.

## Connect (admin → Connect)

Sign into the admin panel and open **Connect** (`/admin/connect`). It has four
tabs:

- **Endpoints** — the curated integration subset of the HTTP API, grouped and
  searchable. Each endpoint expands to its description, parameters, a sample
  response, a *Copy as curl* button, and an inline **playground** that fires the
  real request against this station (admin auth is handled for you). Endpoints
  that change the live broadcast are flagged `on-air` and ask for confirmation
  before sending.
- **MCP** — connect an agent (Claude Code, Claude Desktop, any MCP client) to
  the station's [17 MCP tools](./mcp-server.md). The controller serves MCP over
  HTTP at `/api/mcp`, so the tab gives a copy-ready `claude mcp add --transport
  http …` command with this station's URL — no clone, no local process. A stdio
  setup is offered as the local-only alternative.
- **Integrations** — the stream URLs (with live on/off state per mount),
  now-playing feeds, and paste-ready recipes for **Music Assistant** and **Home
  Assistant**.
- **Webhooks** — the push direction: register outbound HTTP POSTs that fire on
  station events (track changes, requests, on-air segments), with every payload
  shape documented.

## Building a public station page

The unauthenticated reads are enough to render a full programming guide without
an admin credential:

- `GET /schedule` — show definitions, the 7×24 grid, and a persona index
  (`id`, `name`, `tagline`, `avatar`). Each show carries `personaId` for its
  host and `guestPersonaIds` for its co-hosts; both are ids you join against
  that index, and both are resolved against the live roster, so a persona
  deleted after the show was saved simply drops out.
- `GET /personas` — the same persona index on its own, for a "meet the DJs"
  page that doesn't need the week grid.
- `GET /dj` — who is on air *right now* (a scheduled show can put someone other
  than `activePersonaId` behind the mic).
- `GET /now-playing` — the current track, plus `context.activeShow` with the
  live show's host and guests already hydrated.
- `GET /lyrics/current` — lyrics for the currently airing library track, when
  the connected Subsonic server exposes them for that song.

**Persona souls are opt-in.** A persona's `soul` is its system prompt rather
than a written bio, so the roster-wide reads above publish it only when the
operator turns on **Settings → Station → Public API → publish persona souls**.
Off (the default), the field is *absent* rather than empty — both `/schedule`
and `/personas` report which mode you're in via `soulsPublished`, so a client
can hide the bio column instead of rendering blank cards. `tagline` is the field intended for
public display and is always present. `GET /dj` publishes the on-air persona's
soul regardless, as it always has.

## Current-track lyrics

`GET /lyrics/current` is an unauthenticated public read for listener-facing
players and custom skins. It resolves the current on-air item to its
`subsonic_id`, asks the connected Subsonic server for structured lyrics, and
returns a small normalized payload:

```json
{
  "songId": "abc123",
  "synced": true,
  "lines": [
    { "startMs": 12500, "text": "First lyric line" },
    { "startMs": 15300, "text": "Second lyric line" }
  ]
}
```

`songId` is `null` when the on-air item is not a library track. `lines` is empty
when no lyrics are indexed for the current track, when the current item is not a
library track, or when the upstream lyrics lookup fails. Synced lyrics preserve
line timing in `startMs`; unsynced/plain lyrics use `null` for `startMs` and set
`synced` to `false`.

## OpenAPI

The Connect page's **Download OpenAPI** button (and `GET /api/connect/openapi.json`,
admin-gated) returns an OpenAPI 3.1 document generated from the same catalog.
Import it into Postman/Insomnia or use it for client codegen.

## Where the catalog lives

The documented surface is a single hand-curated manifest in the controller:
[`controller/src/connect/catalog.ts`](../controller/src/connect/catalog.ts).
A drift guard (`npm run test:connect` in `controller/`) asserts every documented
endpoint still resolves to a real Express route, so the explorer can't rot. To
document a new endpoint, add an entry there — the admin page, the OpenAPI export,
and the test all pick it up.
