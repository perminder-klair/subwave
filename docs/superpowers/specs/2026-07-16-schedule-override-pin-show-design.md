# Schedule override — pin a show for N hours (issue #930)

**Date:** 2026-07-16
**Issue:** [#930 — Dashboard show picker to pin a selected show for x hours](https://github.com/perminder-klair/subwave/issues/930)

## Problem

To temporarily air a different show (e.g. "Hard Rock for the next hour while I'm at
the gym"), the operator has to repaint the weekly schedule grid and remember to
undo it afterwards. There is no transient "play this show now, then go back to
normal" control.

## Goal

A timed schedule override — "takeover" — set from the admin Shows page:

- Pick any saved show, pick a duration (1h / 2h / 3h / custom), pin it.
- While the override is live, that show is the on-air show everywhere: picker,
  auto-playlist steer, DJ prompts, persona/guests, theme, session identity.
- When the timer expires, the station reverts to the weekly grid automatically.
- The operator can cancel early and revert immediately.

## Approaches considered

1. **Rewrite the grid temporarily, restore later** — mutates the operator's
   painted schedule; a crash mid-restore loses the real schedule. Rejected.
2. **Override checked at every consumer** (picker, prompts, theme, session…) —
   many touch points, easy to miss one. Rejected.
3. **Single injection point in `resolveActiveShow`** (chosen) — every consumer
   of "what show is on air" already flows through
   `settings.resolveActiveShow(date)` (directly or via `ctx.activeShow`). One
   date-aware check at the top of that function propagates the pin to picks,
   prompts, persona, theme, and session key with zero consumer changes.

## Design

### State

New transient field, persisted as a third top-level key in
`state/schedule.json` (it is schedule-domain state and must survive a
controller restart):

```jsonc
{
  "shows": [...],
  "schedule": {...},
  "override": { "showId": "s_ab12cd", "startedAt": 1752663600000, "expiresAt": 1752667200000 }
}
```

- `override` is `null` / absent when no takeover is live.
- Epoch-ms timestamps — no timezone interpretation needed (unlike the grid,
  which is station-zone wall-clock).
- In-memory it lives on the settings cache as `scheduleOverride`; `update()`
  strips it from the `settings.json` payload exactly like `shows`/`schedule`.
- Validation (`validateScheduleOverrideStrict`): `showId` must reference an
  existing show; `startedAt < expiresAt`; duration capped at 12h. `null`
  clears.

### Resolution (the core)

At the top of `resolveActiveShow(date, s)` (`controller/src/settings.ts`):

```ts
const ov = s?.scheduleOverride;
if (ov && date.getTime() >= ov.startedAt && date.getTime() < ov.expiresAt) {
  const show = s.shows?.find(x => x.id === ov.showId);
  if (show) return resolveShow(show, s);   // same resolved shape as the grid path
}
// fall through to the weekly grid
```

- **Date-aware, lazily expired.** No live timer: a `date` past `expiresAt`
  simply falls through to the grid. Because the queue picks the *next* track
  with `getFullContext(atExpectedAirtime)`, picks that straddle the start/end
  boundary automatically follow whichever show is on air at the pick's
  airtime.
- **Session roll is free.** `sessionKeyFor` keys on `ctx.activeShow.id`, so
  pin/expiry/cancel hard-rolls the DJ session (handoff + persona mic-pass)
  through the existing `maybeRoll` call sites (track start, hourly cron,
  requests). Pinning the show that is already on air is a no-op (same key).
- A dangling `showId` (show deleted mid-override) voids the override — falls
  through to the grid. Show deletion (`DELETE /shows/:id` and the
  `settings.update` integrity sweep) also clears an override pointing at the
  deleted show, so the persisted state never goes stale.

### Takeover/revert latency

Setting or cancelling an override does not interrupt the playing track (shared
live stream — same reason listener skip doesn't exist). The switch airs at the
next natural roll point. To make that prompt rather than "up to an hour":

- The override routes fire a **background session-roll** after saving —
  `getFullContext()` → `session.maybeRoll` → `programme.ensurePlan` →
  `djAgent.runPersonaHandoff`, the exact `hourlyCheck()` sequence in
  `broadcast/scheduler.ts`. Exported from scheduler as a reusable
  `rollSessionNow(reason)` helper; the HTTP response does not wait on it.
  The next track pick (already in `next.txt`) may still be a pre-pin pick;
  the takeover fully lands one track later — acceptable and consistent with
  how show boundaries already behave.
- **Expiry janitor:** the scheduler's quarter-hour tick checks for a persisted
  override with `expiresAt <= now`, clears it (`settings.update({
  scheduleOverride: null })`) and calls `rollSessionNow`. Lazy resolution
  already guarantees correctness before the janitor runs; the janitor makes
  the on-air revert prompt (≤15 min worst case, usually sooner via a track
  boundary) and keeps the persisted file clean.

### API (controller, `routes/shows.ts`, admin-gated)

- `POST /schedule/override` — body `{ showId, minutes }`. `minutes` integer,
  15–720. Sets `{ showId, startedAt: now, expiresAt: now + minutes*60_000 }`
  via `settings.update`, kicks the background roll, returns the override.
  Re-POSTing while one is live replaces it (switch show or extend time).
- `DELETE /schedule/override` — clears it, kicks the background roll, 204/ok.
- `GET /schedule` (public, `routes/public.ts`) gains an additive
  `override: { showId, startedAt, expiresAt } | null` field (expired ⇒
  reported as `null`) so the admin panel — and any curious skin — can show a
  countdown. Additive, so the native app is unaffected.

### Programme shows

`showSpan()` (`broadcast/programme-pure.ts`) derives the episode arc from
contiguous grid slots; a pinned show usually isn't in the grid at that hour.
While an override is live, the span is derived from the override window
instead: index = hours elapsed since `startedAt`, total = ceil(window / 1h)
(pure helper `overrideSpan`, pinned by `scripts/programme.test.ts` alongside
`showSpan`). A 1-hour pin of a programme show therefore airs as a compact
single-hour episode — intro, feature, outro.

### Admin UI (`web/components/admin/ShowsPanel.tsx`)

On the "On air" NowCard row:

- **No override live:** a compact "Takeover" control — show `<Select>`
  (saved shows only) + duration chips `1h / 2h / 3h` + custom-minutes input +
  "Pin" button → `POST /schedule/override` via `adminFetch`, toast on result.
- **Override live:** the On-air card shows the pinned show with a
  `TAKEOVER · ends 15:30` badge (station-zone clock, reusing `fmtClock`) and
  a "Cancel" button → `DELETE /schedule/override`.
- Override state comes from the existing panel load (it already fetches
  `/settings`; the override rides on `GET /schedule` — the panel fetches it
  alongside) and refreshes after each action. Countdown is rendered from
  `expiresAt`; no per-second timer needed (per-minute is fine).

### Out of scope (noted for later)

- MCP tool (`subwave_pin_show`) — the existing `subwave_schedule` tool stays
  read-only; a write tool can follow if wanted.
- Listener-facing pinning — this is an operator control; listeners still see
  the outcome via `/state`/`/schedule`.
- Interrupting the current track on pin — deliberately not done.

## Testing

- No test runner in the repo; `npm run lint` (eslint + tsc) in `controller/`
  and `web/` is the merge gate.
- `overrideSpan` is pure → pinned in `controller/scripts/programme.test.ts`
  (existing `npm run test:*` pattern for pure helpers).
- Manual verification: pin a show via the API on a dev stack, confirm
  `resolveActiveShow()` flips, session hard-rolls at next track, `GET
  /schedule` reports the override, expiry janitor clears it.

## Touch list

| File | Change |
|---|---|
| `controller/src/settings.ts` | `scheduleOverride` load/persist/validate; `resolveActiveShow` injection; sweep clears dangling override |
| `controller/src/routes/shows.ts` | `POST`/`DELETE /schedule/override`; clear override on show delete |
| `controller/src/routes/public.ts` | `override` field on `GET /schedule` |
| `controller/src/broadcast/scheduler.ts` | exported `rollSessionNow`; expiry janitor on the quarter-hour tick |
| `controller/src/broadcast/programme.ts` / `programme-pure.ts` | override-aware episode span (`overrideSpan`) |
| `controller/scripts/programme.test.ts` | pin `overrideSpan` |
| `web/components/admin/ShowsPanel.tsx` | Takeover control + active-override badge/cancel |
