# The SUB/WAVE API

SUB/WAVE exposes a large HTTP API, an [MCP server](./mcp-server.md), Icecast
stream mounts, and outbound [webhooks](../controller/src/routes/webhooks.ts).
The easiest way to discover and try all of it is the built-in **Connect** page.

## Connect (admin → Connect)

Sign into the admin panel and open **Connect** (`/admin/connect`). It has three
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
