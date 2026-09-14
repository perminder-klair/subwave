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
  the station's [20 MCP tools](./mcp-server.md). The controller serves MCP over
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

**Persona souls are opt-in.** A persona's `soul` is its system prompt rather
than a written bio, so the roster-wide reads above publish it only when the
operator turns on **Settings → Station → Public API → publish persona souls**.
Off (the default), the field is *absent* rather than empty — both `/schedule`
and `/personas` report which mode you're in via `soulsPublished`, so a client
can hide the bio column instead of rendering blank cards. `tagline` is the field intended for
public display and is always present. `GET /dj` publishes the on-air persona's
soul regardless, as it always has.

## Three auth classes

Every documented endpoint falls into one of three, and the Connect page badges
each one:

- **public** — no credential. `/health`, `/now-playing`, `/state`, `/schedule`,
  `/personas`, `/dj`, `/request`.
- **station** — the station's *listener* password (**Settings → Privacy**), a
  different secret from the admin one and a different gate: **open on a public
  station, closed on a private one**. `GET /similar-tracks` is the first of
  these. It is what lets an operator point a call-in agent at their library
  without handing it the admin console.
- **admin** — HTTP Basic with `ADMIN_USER` / `ADMIN_PASS`. `/dj/*`, `/library/*`,
  `/settings`, `/sfx`, `/jingles`, and everything else operational.

A station-gated read takes the password in any of three carriers, tried in that
order:

```bash
curl -H "x-station-auth: $STATION_PASSWORD" '…/api/similar-tracks?id=a1b2c3'
curl -H "Authorization: Bearer $STATION_PASSWORD" '…/api/similar-tracks?id=a1b2c3'
curl '…/api/similar-tracks?id=a1b2c3&auth=<password>'
```

**Prefer the header.** `?auth=` exists because it is the same token the Icecast
stream mount already takes (`web/lib/stationAuth.ts`), so a client that has
already built a stream URL needs nothing new — but a query string lands in
reverse-proxy access logs, browser history and `Referer`. Use it only where a
header is genuinely not available. An `Authorization: Basic` header is never
read as a station token: admin credentials are a separate secret and accepting
them here would quietly widen the gate.

Failed attempts on a station-gated read are rate-limited per IP (20 per 15
minutes) in their **own** counter — spending them cannot lock a listener out of
the player's password box, which has a separate one.

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
