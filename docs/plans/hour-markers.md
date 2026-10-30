# Hour markers in the queue

Proposed design. The rules are written as a pure module, `controller/src/broadcast/marker-policy.ts`, pinned by `controller/scripts/marker-policy.test.ts`. Nothing on the air path calls it yet: this is for review before the drain changes.

## Problem

An operator running the station by hand needs parts of the running order to land on the clock: news at 07:00, a network join, a show that must start on the hour. Today a skill's `cron` speaks at a time, and held talk waits for the next track change, but nothing makes a queued track start at a time. Broadcast playout systems handle this with markers in the playlist. RadioMaster, for example, has three: *wait* (early: hold until the time), *soft* (late: finish the song, then jump to the marker) and *hard* (cut in exactly on time).

## The model

**A marker is a time attached to the queue item that must follow it**, its *anchor*: `QueueItem.marker = { id, at, kind }`.

It is not a queue item of its own. Every `QueueItem` is a track, and every walk of `upcoming` assumes so: the snapshot, the picker's dedup, the drain, the block cancel. Attaching the marker to its anchor means:
- It persists in `queue.json` and survives a restart, with no new state file.
- It moves with its anchor.
- When the anchor is cancelled, the marker moves to the next item. With no next item, it is dropped and logged.

**Timing is `forecastQueue`** (`drain-policy.ts`), the walk behind `GET /state`'s `airsAt` and the listener wait notice. This PR moves that walk out of `queue.upcomingTiming()` unchanged, so what an operator app shows and what the station does cannot disagree.

## The rules (`planMarkers`)

Markers are planned in queue order. Each one sees the queue as the markers before it left it, with their drops and cuts applied.

- **Soft.** Unsent rows ahead of the anchor that would only *start* at or after the marker are dropped. The track airing at the marker finishes, then the anchor plays. An early anchor is left alone.
- **Hard.** The same drops, and the track airing at the marker *ends* at it:
  - **Unsent:** it gets an `endBy`, folded into the earliest-wins `cue_out` at its drain exactly as the show-boundary fade is.
  - **Sent, or on air:** its cue is already fixed, so the plan asks for a `skipAt` the marker time. That is a cut, not a fade, until S7's fade-out lands.
  - **Would play under 90 s:** an unsent track that would only play `BOUNDARY_MIN_PLAY_SEC` (90 s) or less before the marker is dropped instead. The anchor then starts that much early, reported as `early`, because a stub is worse than an early join (the show-boundary fade's rule).
  - **Within 5 s:** a track ending within `MARKER_HARD_TOLERANCE_SEC` (5 s) of the marker is left alone.
- **A sent row is never dropped.** It is already in the mixer. A sent row starting after the marker is reported as `late`, with how far it pushes the anchor.
- **Unknown is never acted on.** If the on-air clock or a length ahead is unknown, the marker is reported `unknown` and nothing is dropped on a guess.

## Wiring (the follow-up PR)

1. **Routes.**
   - `POST /dj/queue-marker { at, kind, before? }`: `before` names the anchor. Without it, the anchor is the first item forecast to start at or after `at`.
   - `DELETE /dj/queue-marker/:id`.
   - Both are admin-only.
2. **When the plan runs:** before each drain decision and on the watcher's deadline tick, so a drop happens before the row is sent. Each drop gets a booth-log line ("dropped X for the 07:00 marker"), as a block cancel does.
3. **`endBy`:** goes through `resolveBoundaryCueSec`, with the marker time as the boundary, `toleranceSec: MARKER_HARD_TOLERANCE_SEC` and `minPlaySec: MARKER_MIN_PLAY_SEC`. It stamps `liq_show_fade`, so the seam is the plain full-buffer fade.
4. **`skipAt`:** a timer that skips at the time with `expectId` (the targeted skip). If the track has changed by then, nothing is cut.
5. **Exemptions.** A hard marker cuts requests and operator tracks too: it is an explicit operator instruction, and manual triggers are exempt from every automatic gate. The show-boundary fade keeps its own exemptions.
6. **No hidden delay in front of a hard anchor.** The drain must not put a bed or a pause-and-talk break in front of a hard anchor, because that would delay the join.
7. **`/state`:** each anchor carries `marker: { id, at, kind }`, and each marker its outcome (`on-time`, `late`, `early`, `unknown`), so the Dash and operator apps can warn. Advertise `queue.markers` on `/health` once capabilities exist there.

## Open questions

1. **Wait.** What fills an early arrival? The station must keep making sound. The options:
   - let the auto playlist play, ended by a hard cut at the time
   - a looping bed
   - a timed pause-and-talk break

   Left out until decided.
2. **Show changes and takeovers.** Does a show change or a new takeover re-plan markers set in the next show, or drop them?
3. **Forecast drift.** The forecast ignores crossfade overlap, so a hard cut is measured from a slightly late start. Drain-time forecasts are about two minutes ahead, so the drift should be small. Measure it on a live station before tuning the tolerance.
4. **Restarts.** A marker whose time passed while the controller was down: plan it as late (soft drops, hard skips now), or drop it as missed? The proposal is to plan it as late and say so in the booth log.
