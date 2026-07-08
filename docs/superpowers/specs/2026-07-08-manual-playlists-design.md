# Manual playlist creation in admin/library + issue #704 resolution

**Date:** 2026-07-08
**Status:** Draft for review

## Problem

Two related asks about controlling what the DJ can pick from:

1. **Issue #704** asks for Navidrome multi-library selection (exclude audiobooks,
   hide seasonal libraries). Since Navidrome v0.58, multi-library ships with
   **per-user library access**, and Subsonic `musicFolderId` *is* the Navidrome
   library id. A dedicated Navidrome user granted only the wanted libraries
   solves this today with zero code — and better than in-app filtering, because
   Navidrome scopes *every* endpoint server-side (several picker endpoints,
   e.g. `getSimilarSongs2`/`getTopSongs`, don't accept `musicFolderId`, so
   client-side filtering would leak). We resolve #704 with documentation.
2. The admin library panel can filter and tag tracks but can't **capture a
   filtered result as a playlist**. Playlists are already first-class picker
   inputs (show anchors strict/soft, exclusion blocklists, mood-name matching),
   so creating them from SUB/WAVE's own metadata (moods, energy, genre) closes
   the loop: browse → curate → playlist → show pool.

## Scope

**In (v1):** manual playlist creation/management in admin/library, backed by
Navidrome via the Subsonic playlist API; docs + onboarding hint resolving #704.

**Out (deferred follow-ups):** rule-based smart pools (saved filters that
auto-update), a station-wide global pool, CLAP "sounds-like" rules, in-app
`musicFolderId` plumbing.

## Part A — Manual playlists

### Subsonic client (`controller/src/music/subsonic.ts`)

- Extend `buildUrl()` param loop: when a value is an array, `append` one query
  param per element (Subsonic repeats `songId`/`songIdToAdd`/`songIndexToRemove`).
  Scalar behaviour unchanged.
- New functions, all through the existing `call()` (logging/error handling for free):
  - `createPlaylist(name, songIds)` → `createPlaylist` with `name` + repeated
    `songId`; returns the created playlist object.
  - `updatePlaylist(playlistId, { name?, comment?, public?, songIdsToAdd?, songIndexesToRemove? })`
    → `updatePlaylist`.
  - `deletePlaylist(id)` → `deletePlaylist`.
- Chunk `songId`/`songIdToAdd` lists at **100 ids per request** (they ride the
  query string; keeps URLs well under length limits). Create = `createPlaylist`
  with the first chunk, then `updatePlaylist` appends for the rest.

### Routes — new `controller/src/routes/playlists.ts`, all `requireAdmin`

| Route | Behaviour |
|---|---|
| `GET /playlists` | List `{id, name, songCount, public, owner}` (live `getPlaylists`, no memo) |
| `GET /playlists/:id` | Playlist detail + entries (live `getPlaylist`) |
| `POST /playlists` | `{name, songIds[]}` → create (chunked); returns playlist + added count |
| `POST /playlists/:id/tracks` | `{songIds[]}` → append (chunked); returns added count |
| `DELETE /playlists/:id/tracks` | `{indexes[]}` → `songIndexToRemove` (Subsonic removes **by index**, not id — the UI resolves indexes from the fetched entry list it is displaying) |
| `DELETE /playlists/:id` | Delete playlist |

Mounted in `server.ts` alongside the other admin routers. The existing
`GET /dj/playlists` (show editor) stays as-is.

Partial-failure semantics: chunked appends report `{added, failed}`; a failed
chunk aborts remaining chunks and surfaces the Subsonic error message.

### Web UI (`web/components/admin/LibraryPanel.tsx`)

- **Selection model:** checkboxes on track rows in the existing `recent`,
  `browse`, `search`, and `untagged` tabs, plus a select-all-on-page toggle.
  A floating action bar appears when ≥1 selected: “Add N to playlist”.
- **Add-to-playlist popover:** lists existing playlists (name + track count)
  and a “New playlist…” name input. Adding shows a toast with the added count.
- **New `playlists` tab** (fifth tab): list playlists; expand to view entries;
  remove a track; delete a playlist behind a confirm. Rename/reorder stay in
  Navidrome's own UI for v1.
- Styling/patterns follow the existing LibraryPanel tab conventions (same
  fetch helper, same admin auth header, same toast/error affordances).

### Behaviour notes

- **Ownership/visibility:** playlists are created by the Navidrome account
  configured in SUB/WAVE and are set `public=true` on create, so the
  operator's personal Navidrome login sees them too.
- **Picker freshness:** the picker and show-pool resolvers memoise
  `getPlaylists`/`getPlaylist` for 30 min, so a new playlist reaches the DJ
  within ≤30 min. Admin routes read live, so the UI is immediate. No
  cache-busting in v1.
- **Immediate utility:** created playlists appear in the show editor's
  playlist picker (`/dj/playlists`) and are eligible for mood-name matching
  (a playlist named “chill evenings” joins the `chill` pool) with no extra
  wiring.

## Part B — #704 resolution (docs)

- **`docs/navidrome-libraries.md`:** short guide — Navidrome ≥0.58
  multi-library; create a dedicated `subwave` Navidrome user granted only the
  libraries that should be on air; seasonal toggling = flipping that user's
  library access in Navidrome admin; run Library → Reconcile afterwards so
  `library.db` prunes tracks the account can no longer see.
- **Onboarding hint:** one line in the Navidrome step of `/onboarding`, and
  the same copy in the CLI wizard's Navidrome step (`cli/src/commands/setup.ts`):
  “Tip: use a dedicated Navidrome user that can only access the libraries you
  want on air.”
- **Issue comment:** after this ships, comment on #704 explaining the
  dedicated-user pattern with a link to the doc, noting in-app library
  selection remains open as a possible future enhancement. Closing the issue
  is the maintainer's call.

## Testing

No test runner in this repo; `npm run lint` in `controller/` and `web/` is the
gate. Manual verification on the dev stack: filter browse by mood/energy →
select tracks → create playlist → confirm it appears in Navidrome's UI, in
`GET /dj/playlists` (show editor), and that entry removal/deletion behave.

## Risks

- Subsonic `updatePlaylist` removal-by-index races concurrent edits (e.g. the
  operator edits the same playlist in Navidrome while the admin tab is open).
  Mitigation: the UI refetches entries after every mutation; acceptable for a
  single-operator tool.
- Long selections produce several chunked requests; partial failure is
  reported, not rolled back (Subsonic has no transaction).
