# Music sources through the SUB/WAVE router

Design and implementation plan for [issue #692](https://github.com/perminder-klair/subwave/issues/692) (pluggable music sources). It replaces the approach in PR #843 and brings the prototype router (`subwave-internal/subwave-router`) into this repo as a first-class service with a plugin system.

**Status: implemented** on `feat/music-source-router`. The reference for how it works now is [`docs/internals/music-sources.md`](../internals/music-sources.md); the plugin contract is [`docs/music-source-plugins.md`](../music-source-plugins.md). This file records the plan and what was verified; see [Delivered](#delivered) at the end.

## Problem

SUB/WAVE plays only from Navidrome. Operators on Jellyfin or Plex must run a second server, and nobody outside the core team can add a backend.

PR #843 put a `MusicSource` facade inside the controller. That rewrote every call site, handed backend-specific URLs straight to Liquidsoap, and has sat unmerged since 2026-07. Separately, a prototype "Subsonic router" was built that speaks the exact Subsonic dialect `controller/src/music/subsonic.ts` uses and answers from pluggable sources. This plan integrates that router.

## Decisions

| # | Decision | Why |
| --- | --- | --- |
| 1 | The router is a **sidecar service**. The controller keeps `music/subsonic.ts` as its only client and points it at the router. | The Subsonic wire is already the contract. Liquidsoap's `subhttp` + #1405 probe path, the analyzer, `subsonic_id`, and every fake-Subsonic test stay untouched. Byte proxying and third-party code stay out of the controller process. |
| 2 | **Navidrome stays direct by default.** The router is used only when an operator picks another source. | Upgrades must stay byte-identical (CLAUDE.md: absent settings coerce to pre-existing behaviour). |
| 3 | **YT Music is removed.** New backends arrive as **plugins** that anyone can write and install. Built-in sources use the same plugin contract. | Public rebroadcast of YouTube audio is a licensing and ToS problem; plugins open the door for Emby, Subsonic forks, local folders and anything else. Building the built-ins on the plugin API proves it is sufficient. |
| 4 | **Single source first.** Merged multi-source sets ship behind an explicit `merge` flag. | Merging brings duplicates and paging costs; it should be a deliberate choice. |
| 5 | PR #843 is superseded. Its ideas that carry over: a source step in onboarding, a source selector in admin, carrying track data across a source switch, a local-folder source (here: the example plugin). | |

## Architecture

```
                 ┌──────── navidrome mode (default, unchanged) ────────┐
controller ──Subsonic──► Navidrome
                 └──────── router mode ────────────────────────────────┐
controller ──Subsonic──► router ──► plugin: jellyfin | plex | navidrome | mock | <third-party>
                           ▲  ▲
         Liquidsoap subhttp┘  └ analyzer URL fallback
```

In router mode the controller's `config.navidrome` connection simply points at the router (`MUSIC_ROUTER_URL`, default `http://router:4534`) with router-generated credentials. Nothing downstream of `subsonic.ts` learns which mode is active.

## The router (`router/`)

A new top-level package beside `controller/`, `web/` and `cli/`. Node 22, ESM, TypeScript run by `tsx` with no build step (same as the controller). Its only runtime dependencies are `express` and `zod`.

```
router/
  src/
    server.ts            HTTP entry: /rest/* (Subsonic), /health, /internal/* (controller API)
    config.ts            reads state/router/config.json + env, polls for changes
    auth.ts              Subsonic salt+token auth against the configured credentials
    handlers.ts          canonical objects → Subsonic response shapes
    respond.ts           JSON/XML envelope
    host/
      loader.ts          discovers built-in + installed plugins, validates manifests, imports entries
      wrap.ts            the enforcement layer around every plugin (ids, validation, timeouts, streams)
      ids.ts             id namespacing (encode/decode)
      composite.ts       merged sets (merge flag only)
      registry.ts        builds and hot-swaps the active source
    sdk/                 the plugin contract (types, defineSource, helpers) — publishable as @subwave/source-sdk
    sources/             built-in plugins: mock, navidrome, jellyfin, plex (each a manifest + index.ts)
  scripts/               node:test suites + conformance kit
```

The prototype's `/ui` console is **not** shipped: it was unauthenticated and minted valid tokens. Its useful parts (health, capability matrix, plugin list) move into the admin UI through the controller.

### Request flow

`/rest/:endpoint` → auth → handler → `getSource()` (resolved once per request) → wrapped plugin (or composite) → envelope. Binary endpoints (`stream`, `getCoverArt`) never answer an error with HTTP 200, because the controller's and Liquidsoap's downloaders would write that body to disk as audio (#1405).

Endpoints served: everything `subsonic.ts` calls — `ping`, `getOpenSubsonicExtensions`, `getSong`, `getAlbum`, `getArtist`, `getArtists`, `getArtistInfo2`, `getGenres`, `getAlbumList2`, `getSongsByGenre`, `getRandomSongs`, `search3`, `getSimilarSongs2`, `getTopSongs`, `getSonicSimilarTracks`, `getStarred2`, `star`, `unstar`, `scrobble`, `getScanStatus`, `getPlaylists`, `getPlaylist`, `createPlaylist`, `updatePlaylist`, `deletePlaylist`, `stream`, `getCoverArt`, `getLyricsBySongId`. `getArtists` and `getScanStatus` are new relative to the prototype; a contract test in the controller pins the whole list.

## Plugin contract

### Package shape

```
state/router/plugins/<name>/
  subwave-source.json    manifest
  index.mjs              entry: export default defineSource((ctx) => ({ ...ops }))
```

Built-ins live in `router/src/sources/<name>/` with the same manifest and an `index.ts` entry, and load through the same loader. Third-party plugins are a single bundled ES module (no `npm install` inside the container). A backend that needs another language runs as its own service and the plugin talks to it over HTTP.

### Manifest (`subwave-source.json`)

```json
{
  "name": "emby",
  "label": "Emby",
  "description": "Stream an Emby music library.",
  "version": "1.0.0",
  "apiVersion": 1,
  "idPrefix": "emby",
  "entry": "index.mjs",
  "config": [
    { "key": "url", "label": "Server URL", "type": "url", "required": true, "env": "EMBY_URL" },
    { "key": "apiKey", "label": "API key", "type": "secret", "required": true, "env": "EMBY_API_KEY" }
  ]
}
```

- `name`: `^[a-z][a-z0-9-]{1,31}$`, unique; a third-party plugin cannot shadow a built-in.
- `apiVersion`: the router refuses a plugin whose major version it does not implement, and says so in the admin UI.
- `idPrefix`: `^[a-z][a-z0-9]{1,5}$`, unique across installed plugins.
- `config[]`: drives the admin form, so a new plugin needs no web changes. Types: `url`, `string`, `secret`, `number`, `boolean`, `select`. `secret` values are never returned to the browser. `env` names an environment variable that overrides the field (env always wins, per house rule) and locks it in the UI.

### Context and ops

```ts
defineSource((ctx: SourceContext) => SourcePlugin | Promise<SourcePlugin>)

interface SourceContext {
  config: Record<string, string | number | boolean | undefined>; // resolved, env applied
  fetch: typeof fetch;   // fetch with a default timeout
  log: { info, warn, error };
  dataDir: string;       // writable per-plugin directory (state/router/data/<name>)
}
```

Plugins work in **native ids**. Required ops: `song`, `album`, `artist`, `genres`, `albumList`, `songsByGenre`, `randomSongs`, `search`, `stream`, `coverArt`. Optional ops (capabilities, introspected): `artists`, `artistInfo`, `similarSongs`, `topSongs`, `lyrics`, `starred`/`starredSongs`/`star`/`unstar`, `playlists`/`playlist`/`createPlaylist`/`overwritePlaylist`/`updatePlaylist`/`deletePlaylist`, `scrobble`, `scanStatus`, `stats`, and a `capabilities.sonicSimilarity` flag. A missing optional op degrades to an empty answer, never an error the station can trip over; a missing write op answers a Subsonic error the controller already handles.

`stream(id, { range })` returns one of:
- `{ url, headers? }` — the router proxies it with Range passthrough;
- `{ status?, headers, body }` — bytes the plugin produced (a web `ReadableStream`, async iterable, or `Buffer`);
- `undefined` — unknown id (HTTP 404).

It no longer receives an Express `Response`, so the contract does not tie plugins to an Express version.

### What the router enforces

The router wraps every plugin (`host/wrap.ts`), so a plugin cannot break the station:

1. **Ids.** Every id a plugin emits is namespaced as `<prefix>-<native>`; a native id outside `[A-Za-z0-9_-]` is carried as `<prefix>_<base64url>`. Incoming ids are decoded and routed. Every published id matches `^[\w-]{1,64}$` with no `/` (the `/cover/:id` guard and the stem cache depend on it); an item that cannot be namespaced within 64 characters is dropped with a warning. A namespaced id can never take the shapes `music/id-canonical.ts` rewrites, so Navidrome id adoption leaves them alone. One source in a set may run with `rawIds: true` (see merging).
2. **Shapes.** Plugin objects are validated and normalised at the boundary (`host/normalize.ts`; manifests and config with zod); missing optional fields get neutral defaults, malformed items are dropped and logged rather than crashing a response.
3. **Time.** Every op has a timeout; a throw in a merged op shrinks the answer instead of failing it.
4. **Streams.** The router refuses a stream whose content type is JSON, XML or text, so a backend's error page can never reach Liquidsoap as a track.
5. **Capabilities** are introspected from the plugin object and reported to the admin UI.

### Loading and trust

The router loads built-ins from `src/sources/` and third-party plugins from `state/router/plugins/` with a cache-busting dynamic import (the same technique as `controller/src/skills/loader.ts`), so **Rescan** picks up new or changed plugins without a restart.

A plugin is code, with the same trust model as a skill's `tool.mjs`. Two things limit the blast radius: the router container mounts **only `state/router/`**, so a plugin cannot read `secrets.env`, `setup-config.json`, sessions or LLM keys; and the router has no Docker socket. Plugins are not part of any community catalog.

### Conformance kit

`npm --prefix router run conformance -- <plugin-dir> [--config k=v ...]` runs the contract suite against a plugin: manifest validity, every required op returning valid shapes, ids stable across two independent constructions, ids namespaced and cover-safe, `stream` returning audio of at least 4 KiB, `coverArt` returning an image, optional ops consistent with the capabilities they claim. `npm test` in `router/` runs it on every plugin that works offline (mock, the example folder plugin, and the navidrome plugin against a second router acting as its Subsonic server), and on live Jellyfin, Plex and Navidrome servers when their `CONFORMANCE_*` environment is set.

## Configuration and IPC

File-based, in the house style. One writer per file.

`state/router/config.json` — written **only by the controller** (mode 0600), read by the router, which polls it every 2s and also accepts a `POST /internal/reload` nudge:

```json
{
  "version": 1,
  "auth": { "user": "subwave", "pass": "<generated hex>" },
  "merge": false,
  "sources": [ { "plugin": "jellyfin", "config": { "url": "http://jellyfin:8096", "apiKey": "…" } } ]
}
```

- `auth` is generated by the controller on first boot (like the Icecast secrets) and reused. It is the only credential that crosses the network, and it is not the operator's backend password.
- A config that fails validation is refused whole and the running source is kept (the prototype's construct-before-swap).
- Multi-station: `state/router/` is install-level. The controller writes the **active** station's selection at boot, and switching stations already restarts the controller.
- Dev convenience: with no sources configured, `ROUTER_SOURCE=<plugin>` plus `ROUTER_USER`/`ROUTER_PASS` env serves that plugin (used by the dev compose profile and tests).

The station's selection lives in the per-station `setup-config.json` (already 0600 and already holding the Navidrome password):

```json
{ "navidrome": { … }, "music": { "mode": "router", "merge": false, "sources": [ … ] } }
```

Absent `music` → `mode: "navidrome"` → exactly today's behaviour.

### Controller → router API

All under `/internal/`, authenticated with the router credentials:

| Route | Purpose |
| --- | --- |
| `GET /internal/status` | plugins installed (manifest, built-in or not, api compatibility, load error, capabilities), the active set, per-source health (`healthy` with counts / `unreachable` with the real error / `not-configured`) and which fields are env-locked |
| `POST /internal/reload` | re-read config and rescan plugins now |
| `POST /internal/test` | construct a throwaway instance from `{ plugin, config }` and report health — the admin "Test connection" button |

## Controller integration

- `controller/src/schemas/music-source.ts` (zod only) — the `music` block, the router config shape, the manifest shape the admin form reads.
- `setup/music-source.ts` — loads the selection, resolves the effective connection (router URL + generated credentials in router mode), writes `state/router/config.json`. `loadNavidromeConfig()` (boot and both maintenance children) applies it, so every Subsonic call follows the mode.
- `setup/firstRun.ts` — router mode needs at least one source with its required fields set; Navidrome credentials are not required.
- Routes:
  - `GET /settings/music-source` — mode, sources (secrets masked as `set`), router status.
  - `POST /settings/music-source` — validate against the plugin manifests, save, write the router config, nudge reload, apply live, clear the picker/genre/extension/doctor caches, refresh `auto.m3u`.
  - `POST /settings/music-source/test`, `POST /settings/music-source/rescan`.
  - `/onboarding/save` accepts a `music` block; `/onboarding/music-source` lists plugins for the wizard.
- Doctor: in router mode the music check names the router and the source, and reports router health.
- Stations: a station counts as configured with either connection.
- `subsonic_id` stays the frozen wire name for "track id".

## Switching safety

Changing source changes every track id, and ids live in about 15 stores (library.db, likes, blocklist, playlist recipes, show pins, show preparations, stems, queue, history…). Adding a source to a merged set is additive; removing or replacing one strands ids.

When a save changes the source identity (mode, plugin set, or raw-id choice), the controller writes `state/music-source-switch.json`. The next complete library walk then adopts orphaned rows by **metadata** as well as by `canonicalId`: an orphan is matched one-to-one to a live track with the same normalised artist, title and album and a duration within 2 seconds, first claim wins. Adoption already moves tags, analysis and vectors (`library-db/id-adoption.ts`) and journals the pairs, and `id-rotation.applyRotation` already replays that journal over likes, blocklist, recipes, show pins and stem dirs. The marker is removed once a complete walk has applied. The existing mass-prune guard still holds anything unmatched until the operator confirms.

Show playlist pins and playlist recipes that point at the old server's playlists cannot be carried; the admin UI says so before a switch.

## Merging (behind `merge: true`)

- The composite routes by id, merges lists by interleaving, and writes stars to the owner and playlists to the first song's owner (prototype semantics).
- Deterministic album lists (`alphabeticalByName`, `newest`, `frequent`) are served from a per-type merged snapshot cached for 10 minutes, so a library walk paging with `offset` costs one pass per child instead of `offset + size` per page.
- `rawIds: true` on at most one source keeps that source's native ids unprefixed; it owns every id the other sources do not claim. The controller sets it on a Navidrome source so moving a Navidrome station into a merged set strands nothing.
- Nothing is deduplicated across sources; the UI says so.

## Deployment

- `docker/Dockerfile.router` (node:22-bookworm-slim, `npm ci --omit=dev`, `tsx src/server.ts`), published as `ghcr.io/perminder-klair/subwave-router` (multi-arch) and scanned with the others.
- A `router` service in `docker-compose.yml`, `docker-compose.byo.yml` and `docker-compose.dev.yml`: internal only (no host port), mounting `${STATE_DIR:-./state}/router:/var/sub-wave-router`. It idles in navidrome mode.
- The controller gets `MUSIC_ROUTER_URL`; the CLI's embedded compose assets are regenerated.
- AIO: the router runs under the supervisor on `127.0.0.1:4534`.
- Unraid template and docs no longer say Navidrome is required.

## Web

- Admin → Settings → **Music source**: choose *Navidrome (direct)* or *Through the SUB/WAVE router*; in router mode pick a plugin and fill its manifest-driven form; Test connection; health and capability table; installed plugins with load errors; Rescan plugins. Merging appears only behind an explicit experimental checkbox.
- Onboarding: the music step offers the same choice.
- User-facing copy says "music server" where it is not specifically about Navidrome.

## Testing

| Layer | What |
| --- | --- |
| Router unit | id codec, manifest validation, loader (fixture plugins incl. broken ones), wrap enforcement, config reload, composite snapshot paging, handlers over HTTP |
| Conformance | mock + example folder plugin, and the HTTP built-ins against fake backends |
| Controller | music-source schema and policy, needsSetup, settings routes, metadata adoption, and a **contract test** that runs every `subsonic.ts` export against a live router |
| End to end | router image built, dev stack (controller + Liquidsoap + router with the mock source) on air with router-served tracks and cover art |

## Phases

0. Bring the router into `router/` without YT Music or the console; lint and tests.
1. Plugin SDK, loader, enforcement; port mock, navidrome, jellyfin, plex onto it; conformance kit.
2. Close the controller-facing gaps: `getArtists`, `getScanStatus`, `artists[]`/`albumArtists[]`/`musicBrainzId`/`releaseDate`, scrobble forwarding, starred cache, cover-art album fallback.
3. Controller wiring: schema, policy, routes, onboarding, doctor, stations.
4. Switching safety: switch marker + metadata adoption.
5. Merging behind the flag: snapshot paging, `rawIds`.
6. Deployment: image, compose ×3, AIO, CLI assets, workflows, Unraid.
7. Web: admin section, onboarding step, copy.
8. Docs: `docs/internals/music-sources.md`, `docs/music-source-plugins.md`, example plugin, README and CLAUDE.md pointers.
9. End-to-end verification.

## Out of scope

- YT Music, in core or as a maintained plugin.
- Publishing `@subwave/source-sdk` to npm (the package is publish-ready; publishing is a release decision).
- A community plugin catalog.
- Deduplicating the same album exposed by two sources.

## Delivered

| Phase | Delivered | Verified by |
| --- | --- | --- |
| 0 | `router/` workspace (Express 5, zod, tsx); prototype `/ui` console and YT Music removed; router in the lint matrix | `npm --prefix router run lint`; CI matrix entry |
| 1 | SDK (`router/src/sdk`), loader, manifest + config resolution, id codec, normalisation, media guard, wrap, registry; mock/navidrome/jellyfin/plex ported as plugins; conformance kit | 51 router tests; conformance passes on mock, a minimal third-party fixture, the example folder plugin, the navidrome plugin against a second router, and **live Jellyfin and Plex** servers (read-only) |
| 2 | `getArtists`, `getScanStatus`, `artists[]`/`albumArtists[]`/`musicBrainzId`/`releaseDate`, scrobble forwarding (jellyfin, plex, navidrome, mock), 30s starred cache, cover-art fallback from a song to its album, star writes routed only to sources that can hold them | `controller/scripts/router-contract.test.ts`: every `subsonic.ts` export against a live router |
| 3 | Image + three compose services + AIO supervisor + CLI assets + publish/scan workflows + Unraid template; `.env.example` | image built and smoke-tested; compose files validated; CLI typecheck. The AIO image was **not** built locally (its router block mirrors the router image) |
| 4 | `schemas/music-source.ts`, `setup/music-source{,-save}.ts`, settings routes, onboarding `music` block, source-aware first-run/doctor/stations, router-mode guard on the direct Navidrome section | `music-source.test.ts`, `music-source-route.test.ts` (against a live router) |
| 5 | Switch marker + metadata adoption through the existing adoption journal; automatic reconcile after a switch | `source-switch.test.ts`; end-to-end below |
| 6 | Merging behind `merge` (snapshot paging, raw-id fallback owner) | `composite.test.ts`, HTTP merge test |
| 7 | Admin → Settings → Music source (manifest-driven forms, test, health, capabilities, plugins, rescan, merge, id-change warning); onboarding step; banner and Doctor wording | `sourceDraft.test.ts`; Playwright against the e2e stack |
| 8 | `docs/internals/music-sources.md`, `docs/music-source-plugins.md`, example plugin, router README/CLAUDE.md, root CLAUDE.md, README, manual page | — |

### End to end

An isolated stack (its own compose project: the published broadcast image with this branch's `radio.liq`, the router image built from this branch, the controller from this branch) verified:

1. A fresh station boots in Navidrome mode exactly as before; the router idles with generated credentials.
2. Switching to the demo library through `POST /settings/music-source` puts router-served tracks on air: `auto.m3u` carries `subhttp:http://router:4534/rest/stream…` URIs, Liquidsoap plays them (`now-playing.json` shows `mock-…` ids), Icecast streams, `/cover/<id>` serves art, and the automatic reconcile walks all 261 tracks into `library.db`.
3. Switching to the Navidrome plugin over a second router (every id changes, `mock-…` → `nd-mock-…`) re-links 259 of 261 rows by metadata, and the hand-tagged tracks keep their moods under the new ids; the two ambiguous rows are left alone, as designed.
4. Switching to a live Jellyfin library plays real m4a tracks through Liquidsoap, with album art via the song-id fallback.
5. The admin section and the wizard step work in a browser: test, save, source change, mode switch, no console errors.

### Follow-ups

- `subwave source add <dir|tgz>` in the CLI (today: copy the folder into `state/router/plugins/` and Rescan).
- Publishing `@subwave/source-sdk` to npm.
- An Emby plugin (requested on #692; its API is close to Jellyfin's) — a good first community plugin.
- Close PR #843 and update #692.

