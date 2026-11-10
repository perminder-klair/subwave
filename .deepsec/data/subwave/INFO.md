# subwave

## What this codebase does

SUB/WAVE is a self-hosted personal internet radio station: one Icecast stream,
an LLM "DJ" picking tracks from a Subsonic/Navidrome library and reading scripts
between them. Processes share a **file-based IPC directory** (`state/`, mounted
`/var/sub-wave`): an Express ESM controller (`controller/src`), a Liquidsoap
mixer (`liquidsoap/radio.liq`), a Next.js player + admin UI (`web/`), an Expo
app (`app/`). Single-host Docker Compose behind Caddy, usually with Cloudflare
terminating TLS. Users: one operator (admin) plus anonymous public listeners.

## Auth shape

- **`requireAdmin`** (`middleware/auth.ts`, plus its no-challenge twin
  `requireAdminUi`) is the only admin gate — HTTP Basic against
  `ADMIN_USER`/`ADMIN_PASS`, `timingSafeEqual`, 10-strike per-IP lockout.
  `assertAdminConfigured()` exits at boot in production without creds; in dev
  the gate deliberately no-ops.
- **Station password** — a separate secret for a *private* station. Three
  checks with deliberately opposite failure modes, all in
  `util/listener-auth.ts`: `POST /listener-auth` (Icecast URL auth) fails
  **open**; `POST /station-auth` and the `requireStationAuth` middleware (for
  listener reads such as `GET /similar-tracks`) fail **closed**. Do not report
  them as inconsistent or suggest merging them.
- **`POST /mcp`** is public by design: a stateless MCP server that calls this
  controller's own REST API over loopback, forwarding the caller's
  `Authorization`, `x-station-auth` and client IP. Admin tools are only as gated
  as the REST route they reach — a tool that skips that hop, or a loopback route
  that trusts the loopback peer, is a finding.
- **`clientIp`** (`middleware/ratelimit.ts`) is header-derived behind a proxy.
  "Attacker can choose their own rate-limit key" is known and accepted.
- **`util/request-guard.ts`** is the single chokepoint for listener request
  text. A guard inlined into a route or agent instead of it *is* a finding.

## Threat model

Ranked by impact:
1. **Admin console takeover** — `/settings`, `/debug` and `/backup/export` hold
   LLM/TTS keys, the Navidrome password and webhook auth headers. Any route that
   reads or mutates those without `requireAdmin` is critical, as is a secret
   leaving `settings.getRedacted()` unredacted (stored secrets round-trip as the
   `'set'` sentinel).
2. **Prompt injection reaching the on-air voice** — untrusted text enters LLM
   prompts from listener requests (`POST /request`; caused a real raid on
   2026-07-28), from skill `feed:` URLs (any skill, including ones installed from
   the community catalog), from web search results, and from track/artist
   metadata on the music server. Output is spoken on air and persisted.
3. **LLM token theft** — public `POST /request` and `POST /mcp` drive paid model
   calls, bounded only by `settings.requests` caps and `llm.dailyTokenCap`.
4. **SSRF via operator-set URLs** — `llm.baseUrl`, SearXNG, skill feeds,
   webhooks, `scrobble.listenbrainz.baseUrl` and `COMMUNITY_CATALOG_URL` are fetched
   server-side. The prod compose network includes `docker-socket-proxy:2375`
   (GET-only, containers section), whose `/containers/<id>/json` returns every
   container's environment — admin password and API keys included. Any
   reachable SSRF is therefore a secret leak.
5. **Archive / bundle import** (admin-only) — `POST /backup/import-file` and
   `POST /personas/import` unpack zips into `state/`. Look for traversal in entry
   names, and for filenames that become a line of `jingles.m3u` (a newline is a
   new rotation entry Liquidsoap plays).

## Project-specific patterns to flag

- **IPC file writers.** `queue.drainToLiquidsoap()` is the only writer of
  `next.txt`; `queue.announce()` of `say.txt`/`intro.txt`; `queue.playJingle()`
  of `jingle-now.txt`. Another writer, or unescaped track text interpolated into
  an `annotate:` URI (parsed by Liquidsoap), is a real issue.
- **Telnet commands** in `broadcast/liquidsoap-control.ts`: a CR/LF in a value
  forges extra Liquidsoap commands.
- **Icecast XML rendering.** `docker/broadcast-entrypoint.sh` and the AIO
  `docker/aio/supervisor.sh` splice settings-derived values (Icecast passwords,
  which an env var can override; trusted-proxy IPs; listener-auth URL) into
  `icecast.xml` with `sed` and `echo`. The two copies are deliberate duplicates —
  a bug in one is almost always in the other.
- **Paths under `state/`** — skill slugs, jingle/voice/backup filenames,
  station ids and persona ids become filesystem paths. `util/slug.ts`,
  `voice-library.resolve()` and `isSafeBackupName` are the intended guards.
- **Public-shape leaks.** `util/public-persona.ts` alone decides what a persona
  publishes (`soul` only behind `publishPersonaSouls`); a route widening that
  shape inline is a finding.

## Known false-positives

- **MD5 in `music/subsonic.ts`** — mandated by the Subsonic salt+token auth
  protocol. Same for MD5 used as a cache or content key elsewhere.
- **`Math.random`** — persona/angle selection, shuffling, jitter. Not security.
- **Missing auth on `routes/public.ts`** — `/health`, `/now-playing`, `/state`,
  `/dj`, `/cover/:id`, `/schedule`, `/personas`, `/listen.pls`, `/session`,
  the `/…/community` catalog listings, `POST /beacon` and `POST /request` are
  intentionally public. Flag them only if they expose secrets or mutate admin state.
- **`cors.ts` allowing `*`** — intentional; no cookies or browser-credentialed
  sessions exist, so there is no CSRF surface.
- **`process.env` in `config.ts` / `util/env.ts`** — the single env config surface.
- **Generated secrets** in `docker/broadcast-entrypoint.sh` and
  `setup/secrets.ts` (Icecast passwords, `state/secrets.env` at 0600) are
  generated and persisted on purpose, not hardcoded.
