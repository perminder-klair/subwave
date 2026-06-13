# Station timezone setting — design

**Date:** 2026-06-12
**Issue:** [#353 — Clock is off](https://github.com/perminder-klair/subwave/issues/353)

## Problem

The DJ's clock — time-of-day moods, schedule slots, hourly time checks, festival
dates — runs on the container's `TZ` env var, which defaults to
`Europe/London` in every compose file. Operators in other zones who never set
`TZ` in the root `.env` get a station clock that's hours off (the #353 reporter
is +2h: "afternoon" auto-playlist at their 6 pm). The setting exists but is
invisible: the browser onboarding wizard never asks for it, the admin UI never
shows it, and the coordinates an operator *does* set only drive weather, not
the clock. Fixing it today means editing `.env` and recreating containers.

## Goal

A **Timezone** field in admin → Settings → Station: pick an IANA zone, applies
live (no restart), drives everything the DJ derives from wall-clock time.
Default is "Auto" — the container's own zone — so existing installs behave
exactly as before.

## Approaches considered

1. **Write `TZ` into `.env` and restart** — rejected. The controller would
   have to edit a host file outside its mount, and container env is immutable
   without a recreate. Worst UX of the three.
2. **Mutate `process.env.TZ` at runtime** — rejected. Node caches the
   resolved zone inconsistently across Date APIs; behaviour is
   version-dependent. It would also silently shift log timestamps and
   everything else, not just DJ-clock logic.
3. **Settings field + explicit-zone date math** (chosen). Store an IANA zone
   in `settings.json`; a small helper computes wall-clock parts in that zone
   via `Intl.DateTimeFormat`. Only the handful of local-time-semantics call
   sites change; timestamps/durations stay untouched. Applies live, no
   restart, matches the "weather location applies live" convention already in
   the Station section.

## Design

### New module: `controller/src/time.ts`

The single home for station-zone date math. No imports from elsewhere in the
app (so `settings.ts` can import it without a cycle).

- `setStationTimezone(tz: string)` — module-level zone, `''` = auto. Called by
  `settings.load()` and `settings.update()`.
- `getStationTimezone(): string` — the *effective* zone: the configured one,
  or `Intl.DateTimeFormat().resolvedOptions().timeZone` when auto.
- `zonedParts(date = new Date())` → `{ year, month, day, hour, minute, dow }`
  (month 1-12, dow 0-6 Sunday-first, matching existing `getDay()`/
  `getMonth()+1` semantics). One `Intl.DateTimeFormat('en-GB', { timeZone, … })`
  `formatToParts` call; the formatter instance is cached per zone (these run
  several times a minute).
- `zonedISODate(date = new Date())` → `YYYY-MM-DD` in the station zone.
- `isValidTimezone(tz: string): boolean` — `try { new Intl.DateTimeFormat('en',
  { timeZone: tz }) }` so aliases (e.g. `Europe/Kiev`) validate, not just the
  canonical `Intl.supportedValuesOf` list.

When the zone is auto, `zonedParts` still goes through the formatter with the
process zone — one code path, no drift between auto and explicit modes.

### Settings (`controller/src/settings.ts`)

- `DEFAULTS.timezone = ''` (auto), top-level alongside `station` / `weather`.
- Load-time normalisation: non-string or invalid stored value → `''` with a
  console warning (covers hand-edited `settings.json`).
- `update()`: `if ('timezone' in patch)` — trim; `''` allowed (back to auto);
  otherwise must pass `isValidTimezone` or throw
  `invalid timezone — use an IANA name like Europe/Athens`.
- Both `load()` and a successful `update()` push the value into
  `setStationTimezone()` — same applied-on-save pattern as the
  `liquidsoap_*.txt` files, minus the restart.
- `resolveActiveShow()` (`settings.ts:1847`): `date.getDay()`/`getHours()` →
  `zonedParts(date)`. This is what makes schedule slots fire at station-local
  hours.

### Call-site rewiring (controller)

All in the "local-time semantics" class; timestamps (`toISOString` turn logs,
session `startedAt`, cleanup timers) are untouched.

| Site | Today | Change |
|---|---|---|
| `context.ts` `getTimeContext` | `date.getHours()` | `zonedParts(date).hour` |
| `context.ts` `getFestivalContext` | `getMonth()+1` / `getDate()` | `zonedParts(date)` month/day |
| `context.ts` `getDateContext` | `getDay()`/`getMonth()`/`getDate()` + `toISOString().slice(0,10)` | `zonedParts(date)`; `iso` via `zonedISODate` (the current `iso` is UTC — wrong near midnight even today; this fixes it) |
| `context.ts` `getClockContext` | `getHours()`/`getMinutes()`/`getDay()` | `zonedParts(date)` |
| `broadcast/dj-gate.ts:32` | quiet hourly: `now.getHours() % 2` | `zonedParts(now).hour % 2` |
| `skills/curiosity.ts:65` | `getMonth()`/`getDate()` for `{mm}`/`{dd}` | `zonedParts(d)` |
| `routes/public.ts:238` | `Intl.DateTimeFormat().resolvedOptions().timeZone` | `getStationTimezone()` — the schedule grid hint now reflects the configured zone |

**Deliberately unchanged:** `dj-gate.ts` minute slots (`m === 15/30/45`) stay
on system-TZ minutes — they must align with when the crons actually fire,
which node-cron schedules in the process zone. `segment-tools.ts`
album-anniversary year stays on process time (a year-boundary edge case with
no audible effect).

### API

- `GET /settings` — `timezone` flows out automatically via `getRedacted()`.
  Additionally expose `serverTimezone:
  Intl.DateTimeFormat().resolvedOptions().timeZone` in the response so the UI
  can label the Auto option with what it resolves to.
- `POST /settings` — `timezone` accepted in the patch like any other field.
- `GET /schedule` (`routes/public.ts`) — `timezone` field switches to the
  effective station zone (see table). `ScheduleDrawer.tsx` already consumes
  it; no web change needed there.

### Admin UI (`web/components/admin/SettingsPanel.tsx`, Station section)

- Form state: `timezone: string` (`''` = auto), loaded from
  `v.timezone ?? ''`, included in `StationSection`'s `save()` patch.
- New **Timezone** card between "Station location" and the section's end:
  - A `Select` (existing component, pattern-matched from the archive bitrate
    select). First item: `Auto — server timezone (<serverTimezone>)`, value
    `''`. Then `Intl.supportedValuesOf('timeZone')` grouped with
    `SelectGroup`/`SelectLabel` by region prefix (`Europe/…`, `America/…`, …)
    — already imported in this file.
  - Below the select, a live preview line: current station time computed
    client-side with the selected zone
    (`new Date().toLocaleTimeString('en-GB', { timeZone })`) so the operator
    sees "Station clock: 18:04" *before* saving and can sanity-check the #353
    symptom directly.
  - Hint: drives the DJ's clock — time-of-day moods, schedule slots, hourly
    time checks, festival dates. Applies live. Hourly archive filenames still
    follow the server's `TZ`.
- Section nav hint (`line 23`): `'name · location'` → `'name · location ·
  timezone'`; SectionHeader sub-text extended to mention the timezone.

### Out of scope

- **Onboarding wizard** — explicitly admin-settings-only per the request. The
  CLI paths already auto-detect `TZ`.
- **`TZ` env var removal** — it stays the default (Auto resolves to it) and
  still governs the broadcast container: Liquidsoap's hourly archive paths
  and the cron *firing* minutes.
- **node-cron timezone option** — crons keep firing in the process zone.
  Limitation: if the configured zone is offset from the server zone by
  :30/:45 (India, Nepal, Chatham), the "top of the hour" check fires at local
  :30/:45. The announced time is still correct. Mitigation is setting the
  host `TZ` to match; not worth re-registering cron tasks on settings change
  for it.

### Edge cases

- **Invalid stored zone** (hand-edited file): normalised to auto on load,
  warning logged. The station never crashes on a bad zone.
- **Zone change mid-session**: the next `getFullContext()` reflects it;
  `session.maybeRoll()` may roll the DJ session when the period/mood key
  changes — the same thing that happens naturally at a daypart boundary.
- **DST**: handled by `Intl`; no offset math anywhere in the design.
- **Weather**: unaffected — driven by coordinates, not the clock.

### Testing

No test runner in this repo; the merge gate is `npm run lint` (eslint +
`tsc --noEmit`) in both `controller/` and `web/` — both must pass. Manual
verification on the dev stack: set a zone several hours off the host's in
admin → Station, then confirm (1) `/state` reports the matching period/mood,
(2) `/schedule` returns the configured zone and the drawer hint shows it,
(3) the saved value round-trips through `GET /settings`, (4) Auto restores
host behaviour.

### Issue closure

After merge, reply on #353: point at the new field (admin → Settings →
Station → Timezone) and note the immediate workaround for older builds
(`TZ=<zone>` in root `.env` + `docker compose up -d`).
