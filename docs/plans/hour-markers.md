# Hour markers in the queue

An operator pins a queued track to a time: "the news starts at 07:00". The rules are `controller/src/broadcast/marker-policy.ts`, pinned by `controller/scripts/marker-policy.test.ts`. The queue's use of them is pinned by `controller/scripts/queue-marker-wiring.test.ts`.

## Problem

An operator running the station by hand needs parts of the running order to land on the clock: news at 07:00, a network join, a show that must start on the hour. A skill's `cron` speaks at a time, and held talk waits for the next track change, but nothing made a queued track start at a time. Broadcast playout systems handle this with markers in the playlist. RadioMaster, for example, has three: *wait* (early: hold until the time), *soft* (late: finish the song, then jump to the marker) and *hard* (cut in exactly on time).

## The model

**A marker is a time attached to the queue item that must follow it**, its *anchor*: `QueueItem.marker = { id, at, kind }`.

It is not a queue item of its own. Every `QueueItem` is a track, and every walk of `upcoming` assumes so: the snapshot, the picker's dedup, the drain, the block cancel. Attaching the marker to its anchor means:
- It persists in `queue.json` and survives a restart, with no new state file.
- It moves with its anchor.
- When the anchor leaves the queue without airing (an operator cancel, a length or clean-show drop, a show change while paused, the blocklist, a pick the mixer could not play), the marker moves to the next item that has no marker of its own. With no such item, it is dropped and the booth log says so.

**Timing is `forecastQueue`** (`drain-policy.ts`), the walk behind `GET /state`'s `airsAt` and the listener wait notice, so what an operator app shows and what the station does cannot disagree.

## The rules (`planMarkers`)

Markers are planned in queue order. Each one sees the queue as the markers before it left it, with their drops, cuts and waits applied.

- **Both kinds wait when early.** An unsent anchor that would start 90 s (`MARKER_MIN_PLAY_SEC`) or more before its time is held back from the mixer. With nothing queued ahead of it, Liquidsoap plays the auto playlist, and the plan runs again as each auto-playlist track starts. The anchor is released once it would join less than 90 s early. Less early than that, it joins early rather than leave the auto playlist a stub to fill.
- **Soft.** Unsent rows ahead of the anchor that would only *start* at or after the marker are dropped. The track airing at the marker finishes, then the anchor plays.
- **Hard.** The same drops, and the track airing at the marker *ends* at it:
  - **Unsent:** it gets an `endBy`, folded into the earliest-wins `cue_out` at its drain exactly as the show-boundary fade is.
  - **Sent, on air, or an auto-playlist track:** its cue is already fixed, so the cut at the marker ends it (below). That is a cut, not a fade, until S7's fade-out lands.
  - **Would play 90 s or less:** an unsent track is dropped instead, and the anchor starts that much early, because a stub is worse than an early join (the show-boundary fade's rule).
  - **Within 5 s:** a track ending within `MARKER_HARD_TOLERANCE_SEC` (5 s) of the marker is left alone.
- **Never dropped:** a sent row, which is already in the mixer, and another anchor, which is an operator instruction of its own. One starting after the marker is reported as `late`, with how far it pushes the anchor.
- **Unknown drops nothing.** If the on-air clock or a length ahead is unknown, the marker is reported `unknown` and nothing is dropped on a guess. An unsent anchor is still held until 45 s (`MARKER_RELEASE_LEAD_SEC`) before its time, so an unknown clock cannot air it early.

## How the station runs it

- **Routes.** `POST /dj/queue-marker { trackId, at, kind }` pins the first queued copy of `trackId`, with `at` an ISO date-time or epoch ms within the next 12 hours. A second marker on the same track replaces the first. It answers 409 when the track is not queued. `DELETE /dj/queue-marker/:id` removes one. Both are admin-only.
- **The drain** asks the plan about its head before each send. A row the plan drops goes through `removeUpcomingItem` with a booth-log line ("07:00 soft marker removed from queue: …"), the same path as an operator cancel. A held anchor stops the drain, as a pair-drain hold does. The row ahead of a held anchor drains with no successor, so no pair stamps or stem blend are shaped into a track that will not follow it. A hard anchor is sent by its release lead even when a pair drain would hold it, so it is queued behind the track it must end. No bed or pause-and-talk break is put in front of a hard anchor, because it would delay the join.
- **`endBy`** goes through `resolveBoundaryCueSec` with the marker as the boundary, `toleranceSec: MARKER_HARD_TOLERANCE_SEC` and `minPlaySec: MARKER_MIN_PLAY_SEC`. It shares `queue.plannedAirSpan` with the show-boundary fade, and the earlier of the two cuts wins. It stamps `liq_show_fade`, so the seam is the plain full-buffer fade. Requests are not exempt: a marker is the operator's instruction for that exact time.
- **The cut at the marker** is `queue.maybeHourMarkerCut`, on the 1.5 s watcher tick. When a hard marker's time has come, its anchor is next and already sent, and the on-air track will not end within 5 s on its own, it skips the on-air track once (`markerCutDue`). It needs no forecast, so an auto-playlist track of unknown length is still cut on time.
- **An operator skip** while an anchor is held does not commit it: the skip airs the next auto-playlist track, and the anchor still joins at its time.
- **`GET /state`**: each anchor's row carries `marker: { id, at, kind, outcome }`, where `outcome` is the plan's verdict now: `on-time`, `waiting`, `early`, `late` or `unknown`, the last three with `bySec`. Queue rows pass through the public feed, so listeners can see marker times too.
- **The booth log** says when a marker is set, moved, dropped, acted on, and how its anchor kept the time when it started ("07:00 hard marker: "News" started on time").

## Decided

1. **Wait.** An early anchor is held and the auto playlist fills the gap (2026-11-02).
2. **Show changes and takeovers.** Markers are kept. They are absolute times and the plan reruns on every tick, so a show change only changes what the plan sees. An anchor removed by the show change passes its marker on.
3. **Restarts.** A marker whose time passed while the controller was down catches up: once the on-air clock is known, soft drops the rows ahead, and hard cuts what is on air as soon as the anchor is queued next. Items in `queue.json` older than two hours are still dropped at boot, with their markers.

## Still open

1. **Forecast drift.** The forecast ignores crossfade overlap, so a hard cut is measured from a slightly late start. Measure it on a live station before tuning the 5 s tolerance.
2. **A late hard anchor behind sent rows** cuts the last of them as soon as the anchor is next, which can be seconds into that track. That is the price of catching up; a station that sees it often may want those rows pulled from the mixer instead.
3. **Surfaces.** The Dash shows no markers yet, and there is no MCP tool. Advertise `queue.markers` on `/health` once capabilities exist there.
