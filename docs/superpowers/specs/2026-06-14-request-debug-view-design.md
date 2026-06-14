# Request debug view — design

**Date:** 2026-06-14
**Goal:** Let the operator see, in the admin dashboard, every listener request and exactly how the AI DJ responded to it — for debugging "why did it pick that / why did it fail".

## Problem

Listener requests (`POST /request`) currently resolve in the background and the
outcome lives only in an **ephemeral in-memory `Map`** in
`controller/src/routes/request.ts` (10-minute TTL, wiped on every controller
restart). There is no operator-facing record of what was asked and what the DJ
did with it. The DJ session chat-history captures request turns, but they're
interleaved with auto-DJ turns and don't expose the matching trace (intent,
pick source, timing). Debugging a bad/failed request means staring at live logs
and hoping to catch it.

## Decisions (settled)

- **Persistence:** durable append-only log on disk (`state/logs/requests.log`),
  survives restarts, browsable over days.
- **Detail level:** full debug trace per request (intent breakdown, which path
  resolved it, the track, the AI ack + full intro script, timing).
- **Placement:** a new "Requests" section on the **admin Dashboard**
  (`/admin/dash`), not the Debug page.

## Architecture

Three pieces, each mirroring an existing pattern in the codebase:

1. **`controller/src/broadcast/request-log.ts`** — new module, modelled on
   `music/subsonic-log.ts`. An in-memory ring buffer (~150 entries) feeding the
   API, plus a durable append-only **JSONL** file at
   `${STATE_DIR}/logs/requests.log`. JSONL (one JSON object per line) rather
   than the TSV subsonic-log uses, because a request record contains the
   multi-line `introScript`. Rotates at 10 MB to one `.old` backup (same policy
   as subsonic-log). On module load it **hydrates the ring from the tail of the
   file** (last ~150 lines) so a restart still shows recent history in the UI —
   this is what makes "survives restart" visible, not just archived.
   - `record(entry)` — `unshift` onto the ring (cap 150) + append one JSONL line
     (best-effort; a write failure must never break request handling).
   - `snapshot(limit = 50)` — returns the most recent N ring entries for the API.

2. **Capture in `routes/request.ts`** — `resolveRequest()` already funnels every
   outcome through two local closures, `resolved(...)` and `failed(...)`. Both
   get a single `requestLog.record(...)` call that assembles the record from the
   `entry` plus trace fields stashed on `entry` as resolution proceeds:
   - timing: stamp `entry.startedAt` at the top of `resolveRequest`, compute
     `ms` at record time.
   - `entry.path` — `'agent' | 'more-like-this' | 'cascade'`, set at the point
     each path takes over.
   - `entry.pickSource` — the existing `pickSource` local (`artist-sort`,
     `genre:…`, `search`, `starred`, …); `'agent'` for the agent path,
     `'more-like-this'` for that shortcut.
   - matcher trace — `intent, mood, scope, sort, artist, genre, language,
     searchTerms` copied from `matched` after `dj.matchRequest` (cascade path
     only; `null` on the agent / more-like-this paths, which don't run the
     stateless matcher).
   - `track { title, artist, id }`, `ack`, `introScript`, and (on failure)
     `message` come straight from what the closures already receive.

   No behavioural change to request resolution — recording is a side-effect at
   the existing terminal points.

3. **`GET /requests` (admin-gated)** — added to `routes/debug.ts` (the existing
   admin-only debug surface, already `requireAdmin`), returning
   `{ requests: requestLog.snapshot(50) }`. Plural `/requests` does not collide
   with the public `POST /request`.

4. **Dashboard UI — `web/components/admin/DashPanel.tsx`** — a new "Requests"
   `Card`, polled every 10 s via `adminFetch('/requests')` (same cadence as the
   listeners table; the dashboard already runs a second slower poll loop for
   that). Each request renders as a collapsible `<details>` row, reusing the
   exact idiom already used for LLM/Subsonic calls in `DebugPanel.tsx`:
   - **summary:** ✓/✗ status, requester, the request text (truncated), time.
   - **expanded:** intent · mood · scope · sort, `path` + `pickSource`, the
     picked `track`, the AI `ack`, the full `introScript`, `ms`, and the
     failure `message` when failed.

## Data shape (one record)

```jsonc
{
  "t": "2026-06-14T19:42:00.000Z",
  "id": "a1b2c3d4",
  "requester": "anon",
  "text": "play latest Diljit",
  "status": "resolved",          // "resolved" | "failed"
  "ms": 1240,
  "path": "cascade",             // "agent" | "more-like-this" | "cascade"
  "pickSource": "artist-sort",   // null when not applicable
  "intent": "artist",            // matcher trace — null on agent/more-like-this
  "mood": null,
  "scope": "album",
  "sort": "latest",
  "artist": "Diljit Dosanjh",
  "genre": null,
  "language": null,
  "searchTerms": ["diljit dosanjh"],
  "track": { "title": "G.O.A.T.", "artist": "Diljit Dosanjh", "id": "abc123" },
  "ack": "Latest Diljit, coming up.",
  "introScript": "…full DJ intro script…",
  "message": null                // failure reason when status === "failed"
}
```

## Error handling

- All `request-log` writes are best-effort and wrapped — a disk/serialise
  failure logs via `queue.log('error', …)` and is swallowed, never propagated
  into request resolution.
- Boot hydration tolerates a missing file, a missing `logs/` dir, and partially
  written / malformed trailing lines (skip lines that don't `JSON.parse`).
- `GET /requests` returns `{ requests: [] }` if the ring is empty; the UI shows
  an empty-state ("no requests yet"), matching the existing empty-state idiom.

## Testing

No test runner in this repo (per CLAUDE.md). Verification is the merge gate:
`npm run lint` (`eslint . && tsc --noEmit`) in both `controller/` and `web/`,
plus a manual dev smoke test — submit a request via the player, confirm it
appears in the dashboard Requests section (resolved and failed cases), and
confirm a controller restart still shows prior requests (hydration from disk).

## Scope / YAGNI

- **In:** capture + durable log + ring, admin `GET /requests`, dashboard
  section, restart-survival via tail hydration, both resolved and failed
  outcomes, all three resolution paths.
- **Out:** filtering/search UI, pagination, per-listener grouping, CSV export,
  replay/re-run of a request, retention beyond the single 10 MB rotation. Can
  follow later if wanted — none are needed for "see what was asked and what the
  AI did".
