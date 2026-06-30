# Anchor shows to Navidrome playlists

**Status:** Design — pending review
**Date:** 2026-06-30

## Summary

Let an operator bind a scheduled **show** to one or more **Navidrome playlists**. While
that show is on air, the AI DJ draws its tracks from the *union* of those playlists,
sequencing and talking over them exactly as it does today. A per-show `playlistStrict`
flag chooses between two behaviours:

- **Strict** — the playlist union is the show's entire song universe.
- **Soft** — the playlist union dominates the candidate pool, but the existing
  genre/era/mood/similarity sources still contribute a minority for variety.

This gives the operator deliberate, hand-curated control over a show's song universe
without giving up the AI-DJ feel (smart sequencing, links, persona, session continuity).

It replaces today's only playlist hook, which is accidental: the pool picker and
seed-selector currently pull in any playlist whose *name happens to contain the current
mood string* (`chill` → a playlist called "chill"). That stays as generic fallback
behaviour for shows with no explicit `playlistIds`.

## Goals

- Deliberate operator control over a show's song universe via Navidrome playlists.
- Keep the AI DJ in charge of sequencing and narration.
- Multiple playlists per show, unioned with equal weight.
- Works across **both** pickers (dj-agent and pool picker) **and** the LLM-free
  `auto.m3u` fallback, so the anchor holds even when the LLM is unavailable.
- Fully backward compatible: a show without `playlistIds` behaves byte-for-byte as today.

## Non-goals (this iteration)

- **Fixed rundown / play-in-order mode** (the "traditional radio show" option). Anchoring
  always lets the AI sequence; a deterministic in-order playthrough is a separate feature.
- **Per-playlist weighting** (e.g. "70 % from A, 30 % from B"). Union, equal weight only.
- **Listener-facing playlist browsing / requesting.**
- **A "now playing from playlist X" badge** in the listener/booth UI. Possible future nicety.

## Decisions baked in (flagged for review)

1. **Listener requests are exempt from the playlist lock.** A `/request` can pull any
   track in the library, even during a strict playlist show. This mirrors the existing
   `genreLock` convention in `picker-tools.ts` ("Deliberately NOT set on the request
   path: an explicit listener ask wins").
2. **Strict shows honor the playlist in the LLM-free fallback.** `refreshAutoPlaylist`
   seeds `auto.m3u` from the playlist union for a strict show, so when Liquidsoap coasts
   (LLM down, budget-hard, or zero listeners) it still plays the show's playlist.

## Data model

Extend the show schema in `controller/src/settings.ts` (`validateShowsStrict`, the object
returned at the end of the per-show map; shows live in `schedule.json`):

| Field            | Type       | Default | Notes |
|------------------|------------|---------|-------|
| `playlistIds`    | `string[]` | `[]`    | Navidrome playlist ids. Validate shape only — array of non-empty strings, deduped, capped (≤ 10). **Not** checked against the live Navidrome (offline validation, same as `genre` free-text). |
| `playlistStrict` | `boolean`  | `false` | Only meaningful when `playlistIds` is non-empty. |

Migration: absent → `[]` / `false`. No `schedule.json` rewrite required; defaults are
applied on load, so existing shows are unchanged.

## Resolving the playlist universe

New helper in the music layer (e.g. `music/show-playlist.ts`):

```
resolveShowPlaylistPool(show) -> { ids: Set<string>, tracks: Song[], names: string[] }
```

- For each id in `show.playlistIds`, call `subsonic.getPlaylist(id)` (memoised ~30 min,
  reusing the picker's `memo` cache key space, e.g. `playlist:<id>`).
- Union the entries, dedupe by song id, filter out `subsonic.isStationArchive(song)`.
- Return the id set (for the lock), the track list (for the pool), and playlist names
  (for logging / debug / future UI).
- Empty or deleted playlist ids contribute nothing; callers degrade via never-starve.

Keep the **merge/dedupe/never-starve selection** logic in a **pure function** so it can be
unit-tested without Navidrome (see Testing).

## Picker wiring

Both pickers already enforce hard constraints via the `genreLock` / `eraLock` pattern.
Playlist anchoring follows the same shape.

### Pool picker (`music/picker.ts`)

`buildCandidates(...)` gains a `playlistPool` argument (`{ ids, tracks }`).

- **Strict:** candidate pool = playlist tracks only. Recency/dedup/`rankTarget`
  (bpm/key sequencing) still apply. If the show also sets genre/era/energy, those
  *narrow within* the playlist (`preferGenre` / `preferEra`, never-starve). If the
  playlist union can't supply a non-recent track, never-starve to the normal show pool.
- **Soft:** add the playlist tracks as a **dominant source** (large cap) alongside the
  existing seven sources, which become the minority. Reuse the existing
  `sampleWithRecentFallback` / cap machinery.

### DJ agent (`llm/internal/tools/picker-tools.ts` + `broadcast/dj-agent.ts`)

`buildPickerTools(...)` gains `playlistLock?: Set<string>` (the union id set), used **only
in strict mode**:

- In `collect()`, intersect each tool's candidate list with `playlistLock` **before**
  recency + cap, never-starve to the full list — byte-for-byte the same treatment
  `genreLock`/`eraLock` already get a few lines above. The agent keeps every discovery
  tool (`similarSongs`, `searchLibrary`, `tracksByMood`, …) but can only ever *surface*
  playlist tracks, so it cannot pick outside the set.

For **soft** mode (no lock): register a new `showPlaylistTracks` tool that returns a
sample of the union, and add a prompt line instructing the agent to strongly prefer it
while allowing the occasional step outside for flow.

`broadcast/dj-agent.ts` resolves the active show's playlist pool right where it already
derives `genreLock` / `eraLock` (`runTrackEvent`, ~lines 291–295) and passes
`playlistLock` (strict) or wires the soft tool.

**Request path** (`djAgentRequest` / `/request`): `playlistLock` is **not** set — decision
#1 above. An explicit listener ask escapes the anchor.

## LLM-free fallback (`auto.m3u`)

`broadcast/scheduler.ts` (`refreshAutoPlaylist`) and `music/seed-selector.ts`:

- When the active show has `playlistIds`, seed `auto.m3u` from the playlist union:
  - **Strict:** pool = playlist union (decision #2 — coasting honors the playlist).
  - **Soft:** playlist union as the dominant seed; the rest of the show-narrowed fill is
    the minority.
- This **overrides** the generic mood-name-matching in `seed-selector.ts` *for that show*.
  The name-match path stays intact for shows with no explicit `playlistIds`.

## Admin API + UI

- **New route** `GET /dj/playlists` (behind `requireAdmin`, in `routes/dj.ts`):
  `subsonic.getPlaylists()` mapped to `[{ id, name, songCount }]`. Populates the show
  editor multi-select. (`getPlaylists` exists but is currently exposed nowhere.)
- **`web/components/admin/ShowsPanel.tsx`:** add a playlist multi-select and a
  "Playlist only (strict)" checkbox (shown only when ≥ 1 playlist is selected), beside
  the existing genre/era/energy controls. Update show types in `web/lib/types.ts` and
  `web/components/admin/personas/types.ts`.
- The existing show-save PUT path carries `playlistIds` / `playlistStrict` through with
  no new endpoint.

## Edge cases

- **Deleted / empty playlist ids** → empty union → never-starve to the show's other
  filters / full library; log a warning. Never hard-fail the show.
- **Playlist edited in Navidrome mid-show** → reflected after the ~30 min cache TTL or the
  next auto-playlist refresh. Acceptable.
- **Very large playlist** → sampled/capped like every other source.
- **`playlistStrict` + `genreStrict` both set** → intersection, never-starve in priority
  order playlist → genre → era. Documented precedence; degrades to off-target rather than
  dead air.

## Testing / verification

- No test runner; the merge gate is lint (`eslint . && tsc --noEmit`) for both
  `controller/` and `web/`.
- **Pure-logic unit seam:** put the union / dedupe / never-starve pool-merge in a pure
  helper and pin it with a unit test alongside the existing pure tests
  (`scripts/llm-pure.test.ts`, `npm run test:llm`) or an equivalent small harness.
- **Manual smoke (dev stack):** create a show, anchor it to a playlist, schedule it to
  "now"; confirm via `/admin/debug` pick log that strict picks stay inside the playlist
  and soft picks wander minimally; confirm a `/request` still escapes; force budget-hard
  (or stop the LLM) and confirm `auto.m3u` plays the playlist.

## Rollout

- Backward compatible — shows without `playlistIds` are unchanged; no data migration.
- No compose / `.env` changes, so **no CLI asset re-embed** is needed.
