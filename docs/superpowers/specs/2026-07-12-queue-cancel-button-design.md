# Admin dash: cancel button for queued tracks

**Date:** 2026-07-12
**Status:** Draft — awaiting review

## Problem

The operator sometimes sees an impending track they dislike (a bad DJ pick, or
a track they queued by mistake) in the admin dash Queue card. Today the only
tools are `/dj/skip` (only works once the track is already on air, and burns a
crossfade) or waiting it out. There is no way to remove a track from the queue
before it airs.

## Goal

An `[X]` cancel button on each row of the Queue card in `/admin/dash` that
removes that track from the upcoming queue before it plays. Operator-only.

## The load-bearing constraint

`queue.drainToLiquidsoap()` feeds every queued item into Liquidsoap's
`dj_queue` (a `request.queue`) as soon as it lands in `upcoming`, marking it
`sent: true`. So by the time the operator sees a track in the dash, it is
almost always already inside Liquidsoap. Cancelling therefore means removing
the request from Liquidsoap's queue over telnet, then splicing the Node-side
`upcoming` entry — not just the array splice.

## Approaches considered

1. **Liquidsoap-side removal via a new telnet command (chosen).** Register a
   `dj_queue_remove <rid>` server command in `radio.liq` that filters the
   request out of `dj_queue.queue()` and writes the remainder back with
   `dj_queue.set_queue(...)` (Liquidsoap 2.4.x supports both methods). The
   controller resolves the RID from the track's `subsonic_id` using the same
   two-hop telnet pattern `getDjQueueIds()` already uses. Cost: a `radio.liq`
   change means a broadcast image rebuild in prod. Risk: a small race if the
   track goes on air mid-click — handled by refusing with a clear error.
2. **Stop pre-sending: keep all but the head item Node-side.** Cancel becomes
   a pure array splice. Rejected: the send pipeline, crossfade prefetch,
   request-intro timing, and `reconcileWithDjQueue()` all assume items are
   sent eagerly; restructuring that is far more risk than this feature
   warrants.
3. **Tombstone + auto-skip when the cancelled track starts.** Rejected: a
   second of the unwanted track airs and a crossfade is wasted — bad listener
   experience for no implementation saving.

## Design

### Liquidsoap (`liquidsoap/radio.liq`)

New server command alongside the existing `skip`/`stream_*` registrations:

```
dj_queue_remove <rid>   → "OK" | "NOT_FOUND"
```

Implementation: parse the RID, `list.filter` it out of `dj_queue.queue()` by
`request.id`, `dj_queue.set_queue(...)`. If no request matched, return
`NOT_FOUND` and leave the queue untouched. Only requests still *pending* in
the queue are listed by `.queue()` — a track already being played (or being
prefetched as the current source) is naturally not removable, which is the
behaviour we want.

### Controller

- **`broadcast/liquidsoap-control.ts`** — extend the existing dj_queue query
  to also return a `subsonic_id → rid` map (same telnet hops as
  `getDjQueueIds()`, shared code path; the 4s cache keeps its current shape).
  New `removeFromDjQueue(rid)` sends `dj_queue_remove <rid>` and invalidates
  the cache on success.
- **`broadcast/queue.ts`** — new `async removeUpcoming(trackId)`, the single
  place that owns cancel semantics:
  - Find the item in `upcoming` by `track.id`. Not found → `{ ok: false,
    reason: 'not-queued' }` (it probably just went on air).
  - If `!sent` (rare in-flight window): splice, persist, done.
  - If `sent`: resolve the RID; RID missing or Liquidsoap replies
    `NOT_FOUND` → `{ ok: false, reason: 'already-playing' }`, leave `upcoming`
    alone (reconcile will converge). On `OK`: splice, persist.
  - Log via the existing DJ log: `queue.log('scheduler', 'operator removed
    <title> — <artist> from queue')`. No LLM call, no session turn.
  - If the queue empties, the existing auto-pick gate
    (`upcoming.length === 0`) refills it on the next tick — no extra work.
  - The item's pre-rendered intro WAV (if any) simply never airs —
    `airIntro()` is keyed to `onTrackStarted` matching — and the >1h TTS
    cleaner collects the file.
- **`routes/dj.ts`** — `DELETE /dj/queue/:trackId`, `requireAdmin`-gated,
  next to `POST /dj/skip`. 200 `{ removed: true }` on success; 409 with the
  reason string on `not-queued` / `already-playing`; 502 on telnet failure.
- **`snapshot()`** (`queue.ts`) — add `id: i.track.id` to `mapItem` so the
  dash can target rows. `/state` is public but already exposes titles/artists,
  and `subsonic_id` already rides on `/now-playing`; no new exposure class.

### Web (`web/components/admin/DashPanel.tsx`)

- Each rendered queue row gets an `[X]` button (matching the dash's existing
  compact row styling), wired to `adminFetch('/dj/queue/<id>', { method:
  'DELETE' })`.
- **No confirmation dialog** — unlike Skip (which cuts on-air audio and got a
  confirm), removing a not-yet-aired track is low-stakes and the operator
  asked for a one-click `[X]`.
- While the request is in flight the row's button is disabled; on success
  re-fetch `/state` (reuse the existing refresh path) so the row disappears;
  on 409/error surface the message via the existing error/toast surface and
  re-fetch anyway (the queue moved under us).
- Rows without an `id` (shouldn't happen post-`snapshot()` change) render no
  button.

## Error handling summary

| Failure | Behaviour |
|---|---|
| Track went on air between render and click | 409 `already-playing`; UI toast + refresh |
| Track already consumed / not in `upcoming` | 409 `not-queued`; UI toast + refresh |
| Telnet unreachable (mixer restarting) | 502; `upcoming` untouched; UI toast |
| Liquidsoap removed but splice raced a reconcile | Reconcile pass 2 already drops confirmed-then-gone items — converges on its own |

## Testing

- `npm run lint` in `controller/` and `web/` (the merge gate).
- Manual: dev stack (`docker-compose.dev.yml` bind-mounts `radio.liq` and
  `controller/src`), queue two tracks via admin, cancel the second → row
  disappears, `dj_queue.queue` over telnet shows one RID, track never airs.
  Cancel the head item just as it starts → 409 path.
- No new pure-logic seam worth a unit test; the cancel path is I/O glue.

## Out of scope (YAGNI)

- Listener-facing cancel (players intentionally have no skip/cancel).
- MCP tool (`subwave_cancel_track`) — trivial to add later on top of the same
  endpoint if wanted.
- Reordering the queue / drag-and-drop.
- DJ acknowledging the cancellation on air.

## Deployment note

`radio.liq` is baked into the broadcast image: prod needs
`docker compose up -d --build broadcast` (dev bind-mounts it — restart only).
