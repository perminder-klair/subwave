# Never-Play Blocklist — Design

Date: 2026-07-12
Status: Draft, pending review
Origin: Discord thread `1522577014547288075` (Pezzles' "global never play list" ask, 2026-07-03 → 07-11) + the Lidarr "remove from library" suggestion. Related: per-show `excludedPlaylistIds` (shipped by EveningPill), issue #704 (Navidrome per-user libraries, answers the seasonal case).

## Problem

Operators with large libraries (25k+ tracks) have material that never suits a radio setting — long ambient pieces, soundtracks, audiobook fragments, novelty tracks. Today the only exclusion tools are per-show (`excludedPlaylistIds`) or Navidrome-side (per-user library access). Neither covers **general broadcast hours when no show is on air**, and both require organising playlists or Navidrome users. The ask: a station-level "never let this play on air" list, managed inside the SUB/WAVE admin UI, at track/album/artist granularity.

Real deletion at the source (Lidarr unmonitor/delete) is **out of scope** — Navidrome's Subsonic API has no delete endpoint, and a Lidarr integration is a separate, destructive, Lidarr-only surface. The blocklist removes the on-air pain for every user; a Lidarr hook can layer on later.

## Decisions (settled with operator)

1. **Scope**: radio-side global never-play blocklist only. No Lidarr, no file deletion.
2. **Granularity**: track + album + artist entries in one list.
3. **UI**: per-row "Never play" action in the admin library browser + a "Blocked" management tab.
4. **Reach**: absolute. Blocked entries are rejected everywhere — DJ picks, auto-playlist, listener requests, AND manual operator queueing (final gate in `queue.push()`). To re-audition a track, unblock it first.
5. **Architecture**: sibling state file `state/blocklist.json` + a shared `isBlocked(song)` predicate module, enforced at the existing chokepoints.

## Data model

`<STATE_DIR>/blocklist.json` (sibling to `schedule.json`; survives Library → Reset/Reconcile, which only touch `library.db`):

```json
{
  "entries": [
    { "type": "track",  "id": "ab12", "name": "Song X",   "artist": "Artist Y", "album": "Album Z", "addedAt": "2026-07-12T10:00:00Z" },
    { "type": "album",  "id": "cd34", "name": "OST Vol 2", "artist": "Composer Z", "addedAt": "…" },
    { "type": "artist", "id": "ef56", "name": "Ambient Guy", "addedAt": "…" }
  ]
}
```

- `id` is the Navidrome/Subsonic id for the entry's type (`song.id`, `song.albumId`, `song.artistId`).
- `name`/`artist`/`album` are display-only snapshots for the Blocked tab (no re-lookup needed to render the list).
- Written atomically (`writeFileAtomic`, same pattern as settings/schedule).

## Module: `controller/src/music/blocklist.ts`

Single owner of the file and the in-memory index.

- `load()` — read file at boot (called from `server.ts` startup, before scheduler/queue start); tolerate missing/corrupt file (start empty, log a warning).
- In-memory index: three `Set<string>`s (`trackIds`, `albumIds`, `artistIds`) rebuilt on every mutation.
- `list()` → entries array (for the API).
- `add(entry)` — validate `type` ∈ track|album|artist, non-empty `id`; dedupe by `(type, id)`; persist; rebuild sets. Returns the stored entry.
- `remove(type, id)` — delete + persist; returns boolean.
- `isBlocked(song)` — pure, synchronous:
  `trackIds.has(song.id) || (song.albumId && albumIds.has(song.albumId)) || (song.artistId && artistIds.has(song.artistId))`.
- `isEmpty()` — fast-path so hot filters skip work when nothing is blocked (the common case).

Matching is **id-based only**. No name/fuzzy matching: precise, cheap, and immune to metadata typos. Consequence (documented in UI copy): blocking an artist blocks songs whose primary `artistId` matches — collaborations filed under a different artist id still play.

## Enforcement points

Belt-and-suspenders, from outermost source to final gate:

1. **`music/subsonic.ts` reject chokepoint** — extend the existing `rejectArchive` filter (subsonic.ts:182, applied to every song-returning function) to also drop `blocklist.isBlocked(s)`. Rename the combined filter (e.g. `rejectUnairable`). This alone covers: search, random, genre, similar-songs, starred, top-songs, album, playlist — i.e. all seven pool-picker sources, all dj-agent picker tools, and most of listener-request resolution.
2. **Library-native sources** — `music/library.ts` (`songsByMood`, vector/`tracksByVector` reads used by `searchBySound` and audio-moods): filter rows through `isBlocked`. Library rows carry track id (and artist name but not always ids), so at minimum the track-id check applies here; album/artist blocks on these paths are still caught downstream at (3) and (5).
3. **Candidate-pool sites** — apply `isBlocked` unconditionally alongside the existing per-show `excludedIds` filters: `music/picker.ts` (~:595), `broadcast/dj-agent.ts` (~:603), `broadcast/scheduler.ts` auto-playlist build (~:331). This is the same shape as `resolveExcludedPlaylistIds`, minus the show gate.
4. **Listener requests** — `routes/request.ts`: resolution already flows through the subsonic chokepoint, but add an explicit check where a resolved track is about to be enqueued so the listener gets an honest decline instead of a silent drop — reuse the existing "couldn't find that" refusal path verbatim (no new copy, and no leak that the track exists but is blocked).
5. **Final gate: `broadcast/queue.ts` `push()`** — reject when `isBlocked(track)`, before the dedup guard. Log to `djLog` (`blocked track rejected: <title> — <artist>`) so the operator can see the gate firing in the admin dash. This makes the block absolute: dj-agent, requests, MCP `queue_track`, and the admin "Queue" button all pass through here.

Not touched: jingles, emergency fallback, `say/intro` speech — none are library tracks.

### Mutation side-effects

On `add()`:
- **Purge upcoming**: remove now-blocked entries from the in-memory `upcoming` queue (they're not yet in `next.txt`; anything already drained to Liquidsoap plays out — we never interrupt the current track).
- **Refresh auto-playlist**: kick `refreshAutoPlaylist()` (fire-and-forget) so `auto.m3u` on disk stops carrying blocked ids; otherwise a blocked track could still air from the fallback playlist for up to `autoQueueRefreshMinutes`.

On `remove()`: no side-effects needed (track becomes eligible again on the next pool build).

## API (in `controller/src/routes/library.ts`, admin-gated like its siblings)

- `GET /library/blocklist` → `{ entries: [...] }`
- `POST /library/blocklist` — body `{ type, id, name?, artist?, album? }` → `201 { entry }`; `409` on duplicate `(type, id)`; `400` on bad type/missing id.
- `DELETE /library/blocklist/:type/:id` → `204`; `404` if absent.

## Web UI (`web/components/admin/LibraryPanel.tsx`)

**Row action** — a "Block" item in the existing per-row action cluster (alongside Queue / Retag). Opens a small scope menu:
- *Never play this track*
- *Never play this album* (needs `albumId` — present on subsonic-hydrated rows; if a row lacks it, resolve via the existing single-song lookup used by manual album tagging, `routes/library.ts` ~:709)
- *Never play this artist* (same via `artistId`)

Confirm with a toast (`sonner`, existing pattern): "Blocked — will never air. Manage in the Blocked tab." No modal confirmation for blocking (it's reversible); unblock is one click.

**Blocked tab** — new tab in the `recent | browse | search | untagged | playlists` strip: lists entries newest-first with a type badge (track/album/artist), name + artist snapshot, added date, and an Unblock button. Empty state explains what the list does and the artist-id caveat. A small count in the tab label when non-empty.

Blocked rows elsewhere in the library browser: no special treatment in v1 (they still appear in browse/search — the library browser shows the library; the blocklist governs *airing*). If operators find that confusing we can add a badge later.

## Out of scope (explicitly)

- **Lidarr unmonitor/delete** — future optional integration; the blocklist entry snapshot (`name`/`artist`/`album`) is deliberately enough to drive a later Lidarr lookup.
- **Seasonal/date-ranged blocks** (Christmas case) — covered by Navidrome per-user libraries (issue #704 answer); a date-range dimension on blocklist entries would double the model complexity for a solved case.
- **Blocking from the public player / listener side** — admin-only.
- **Genre- or rule-based blocking** — entries are concrete ids only.

## Error handling

- Corrupt/missing `blocklist.json` → start empty + log; never crash boot.
- `isBlocked` is sync + in-memory, so no failure mode in hot paths; if the module failed to load the sets are empty (fail-open: station keeps playing — consistent with "music never stops").
- POST with an id Navidrome no longer knows: allowed (blocking is id-set membership; a stale entry is inert and can be unblocked from the tab).

## Testing / verification

- No repo test runner: `npm run lint` in `controller/` and `web/` is the merge gate.
- `blocklist.ts` matching + add/remove/dedupe are pure enough for a small pinned test alongside the existing `scripts/llm-pure.test.ts` pattern if desired (optional).
- Manual verification via the `verify` skill: isolated controller + worktree web dev server + Playwright against `/admin/library` — block a track, confirm 1) Blocked tab lists it, 2) `POST /request` for it declines, 3) admin Queue button refuses, 4) regenerated `auto.m3u` omits it, 5) unblock restores.
