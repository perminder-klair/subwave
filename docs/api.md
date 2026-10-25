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
- `GET /lyrics/current` — lyrics for the track a listener is hearing, when the
  operator has the Lyrics panel on (see **Lyrics** below).

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

## Lyrics

`GET /lyrics/current` serves lyrics to listener-facing players and custom
skins. It is on by default, and the operator can turn it off under **Settings →
Listeners → Lyrics** (`settings.lyrics.enabled`); while off it answers `403` and
`GET /state` carries `lyrics: { enabled: false }`, which is how a skin knows to
hide its panel. It is
a **station** read, gated like `/similar-tracks`: open on a public station, and
on a private one it needs the station password (`x-station-auth` header).

A listener hears the stream `stream.bufferSeconds` behind the live edge, so a
player passes the track it is showing as `?songId=` (now-playing's
`subsonic_id`). The station answers for the on-air track or one of the three
before it, and refuses anything older with `409`. Without `songId` it answers
for the on-air track.

```json
{
  "songId": "abc123",
  "synced": true,
  "offsetMs": 0,
  "lines": [
    { "startMs": 12500, "text": "First lyric line" },
    { "startMs": 15300, "text": "Second lyric line" }
  ],
  "source": "music-server",
  "pending": false
}
```

- `startMs` is on the **played** timeline: when the dead-air trim cut a silent
  head off the track, the lines are already moved back by the same amount, so a
  player compares them with elapsed time since the track started. Untimed
  lines carry `null` and `synced` is `false`.
- `offsetMs` is the station's correction for this track's lyric file, set by
  the operator. It is not folded into the lines; a player adds it at render
  time: `effectiveElapsedMs = elapsedSinceTrackStartMs + offsetMs`. Positive
  advances the highlighting, negative delays it.
- Empty `lines` means the track has no lyrics, or the item is not a library
  track (`songId: null`). Instrumental placeholders (`[au: instrumental]`) count
  as no lyrics, and so does a music server without the OpenSubsonic lyrics
  endpoint (it answers that call with HTTP 404 or 501).
- `503` means the music server did not answer. It is never "no lyrics": retry
  after the `Retry-After` seconds.
- `source` is where the lines came from: `music-server`, or `lrclib` (below).
  It is `null` when there are no lines. A player can credit LRCLIB with it.
- `pending: true` means the station is still looking the track up on LRCLIB and
  the answer may improve, so ask again after a few seconds. Both fields are
  optional: a station from before the fallback omits them.

**The LRCLIB fallback.** With **Settings → Listeners → Lyrics panel → LRCLIB
fallback** on (`settings.lyrics.lrclib`, on by default, and only while the
panel itself is on), a track whose music-server lyrics are untimed or missing is
looked up on [LRCLIB](https://lrclib.net) when it joins the queue, and again
when it goes on air if that first try failed. That sends the
track's artist, title, album and length to lrclib.net, or to `LRCLIB_URL` for a
self-hosted instance. Only a file within 2 seconds of the track's length is
used, so a different cut is not timed against this one. The music server's
timed lyrics always win, and LRCLIB lyrics reach this panel only, never the
DJ's vocal timing. The station remembers each answer, so a track is asked about
once (a miss again after 30 days). The station offset and the trim shift apply
to LRCLIB lines exactly as to the music server's.

The operator sets the correction with `PUT /lyrics/offsets/:trackId` (admin),
body `{ "offsetMs": 2900 }`, a whole number from `-30000` to `30000`; `0`
clears it. It applies to every listener. The Classic and Drift players show
synced lyrics on the stage (Classic beside the track info, Drift as the centre of
the page), and their timing controls (beside **♪ Lyrics**) offer this control to
a browser signed in to the admin console. A listener hides or shows lyrics with
the lyrics button beside the track, or `L`. The native app shows them on its Live
page under a one-row track header, applies this offset, and offers only the
device's own timing nudge, since it has no admin sign-in.

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
