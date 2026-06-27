# Location picker with city search — design

**Date:** 2026-06-27
**Status:** Approved, ready for implementation plan
**Area:** `web/` (admin settings + onboarding) and `controller/` (geocoding proxy + onboarding save)

## Problem

The station's broadcast location is entered as three raw inputs — a free-text
name, a numeric latitude, and a numeric longitude — in two places that duplicate
the same markup:

- **Admin:** `web/components/admin/SettingsPanel.tsx`, the "Station location" card
  (~line 4099), bound to `form.weather = { locationName, lat, lng, units }`.
- **Onboarding:** `web/components/onboarding/steps.tsx`, `DjStep`, bound to
  `w.data.dj = { stationName, locationName, lat, lng }`.

Both back lat/lng with **strings**. The data feeds exactly two things:

1. the DJ's `{location}` prompt context, and
2. Open-Meteo weather — `controller/src/context.ts` →
   `api.open-meteo.com/v1/forecast?latitude=…&longitude=…`.

The friction: an operator must look up their coordinates elsewhere (right-click
Google Maps, copy two decimals) and risks transposing lat/lng. We replace this
with a **type-a-city → pick-from-a-list → coordinates auto-fill** flow.

The lucky break: we already depend on Open-Meteo, which ships a **free,
no-API-key geocoding endpoint** that *also returns the IANA timezone* for each
result — so this needs zero new keys and no map library, and the same pick can
set the station timezone.

## Goals

- Operator types a place name, picks from a dropdown, and lat/lng/name fill in
  one action.
- A city pick also captures the **IANA timezone** and applies it to the station
  clock (admin: as a suggestion; onboarding: auto-applied — see Wiring).
- Manual coordinate entry remains available as an always-works fallback (offline
  homelab boxes, power users).
- One shared component, used in both admin settings and onboarding (kills the
  duplication).

## Non-goals

- No interactive map / tile rendering.
- No new third-party API keys or dependencies.
- No change to how location/weather is consumed downstream (DJ prompt,
  `getWeather()`), or to the lat/lng save payload shape.
- No full timezone `<Select>` added to onboarding (keep that step short).

## Architecture

Three units, each independently understandable:

1. **Geocoding proxy (controller)** — owns the external Open-Meteo geocoding
   call, matching the existing convention that the web layer only ever calls
   same-origin `/api` and the controller owns all external IO.
2. **`<LocationPicker>` (web, shared)** — a controlled, style-neutral composite
   that turns a query into a coordinate selection. Knows nothing about admin vs
   onboarding.
3. **Two wirings** — admin and onboarding each mount the picker against their own
   state shape; both consume the picked timezone, differently.

### 1. Backend — geocoding proxy

**Helper** `geocodePlace(q)` in `controller/src/context.ts`, next to the existing
Open-Meteo weather code:

- Calls
  `https://geocoding-api.open-meteo.com/v1/search?name=<q>&count=6&language=en&format=json`
  (free, **no API key**).
- Maps each `results[]` entry to a compact shape:

  ```ts
  {
    name: string;         // "Chandigarh"
    admin1?: string;      // "Punjab"  (state/region)
    country?: string;     // "India"
    countryCode?: string; // "IN"
    lat: number;          // result.latitude
    lng: number;          // result.longitude
    timezone?: string;    // IANA, e.g. "Asia/Kolkata"
    label: string;        // formatted "Chandigarh, Punjab, India"
  }
  ```

  `label` joins the present-of `[name, admin1, country]` with `, `.
- **Cache:** in-memory `Map` keyed by the lowercased query, ~24h TTL, to be
  polite to Open-Meteo. Soft cap ~200 entries.
- On fetch error, throws; the route translates to a clean failure (the web side
  degrades to manual entry — see Error handling).

**Route** `GET /geocode?q=` in `controller/src/routes/public.ts` (alongside
`/health`, `/now-playing`):

- **Unauthenticated** — onboarding runs pre-auth, and this is harmless public
  reference data.
- Trims `q`; if `< 2` chars, returns `{ results: [] }` (no upstream call).
- Returns `{ results: GeocodeResult[] }`. On upstream failure, returns HTTP 502
  with `{ error: "geocode_unavailable" }` so the client can show the right
  fallback.

### 2. Frontend — shared `<LocationPicker>`

**File:** `web/components/LocationPicker.tsx` (shared composite; built on the
`ui/input` primitive so it renders natively in both contexts).

**Props (controlled):**

```ts
interface LocationValue { locationName: string; lat: string; lng: string }

interface LocationPickerProps {
  value: LocationValue;
  onChange: (next: LocationValue) => void;
  // Fires with the full geocode result on selection, so a host can react to
  // extra fields (both hosts use it for the timezone — admin suggests,
  // onboarding auto-applies). Optional so a host can ignore it.
  onPick?: (result: GeocodeResult) => void;
  className?: string;
}
```

**Behaviour:**

- A search text input, **debounced ~300ms**, queries `/api/geocode?q=` once the
  query is ≥ 2 chars.
- Results render as a **keyboard-navigable ARIA combobox dropdown**
  (`role="combobox"` on the input, `role="listbox"`/`role="option"` on results;
  ArrowUp/Down to move, Enter to select, Esc to close, click to select). Each row
  shows `label` plus faint coordinates.
- Selecting a result calls `onChange({ locationName: label, lat: String(lat),
  lng: String(lng) })` and `onPick(result)`, then closes the dropdown.
- A `▸ Enter coordinates manually` **disclosure** reveals the raw name / lat /
  lng inputs (the existing three inputs, preserved). This is the offline / power
  fallback and must always be reachable. Editing them flows straight to
  `onChange`. Manual mode enforces lat ∈ [−90, 90], lng ∈ [−180, 180] (inline
  hint on out-of-range; does not block typing).
- States: loading spinner in the input while a query is in flight; "No matches"
  empty row when results are empty; on request failure show
  "Search unavailable — enter coordinates manually" **and auto-expand the manual
  disclosure**.
- Shows a one-line summary of the current selection (name @ lat, lng).

### 3. Wiring

**Admin** (`SettingsPanel.tsx`, "Station location" card): replace the three
inputs with

```tsx
<LocationPicker
  value={{ locationName: form.weather.locationName, lat: form.weather.lat, lng: form.weather.lng }}
  onChange={next => setForm(f => ({ ...f, weather: { ...f.weather, ...next } }))}
  onPick={handleGeocodePick}
/>
```

Keep the existing "Applies live" hint and the "current: … @ lat, lng" line.

*Timezone — admin = suggestion.* Admin already has a full Timezone `<Select>`
card, so a city pick must **not** silently overwrite the operator's chosen zone.
`handleGeocodePick` stashes the picked `result.timezone`; when it is present and
differs from the effective current zone (`form.timezone || serverTz`), render a
subtle inline action beneath the picker (or atop the Timezone card): **"Set
station timezone to `Asia/Kolkata`?"** with an Apply control that does
`setForm(f => ({ ...f, timezone: result.timezone }))`. Non-automatic; dismissible.

> **Radix Select caveat:** `form.timezone` is rendered by a Radix `Select` whose
> items come from `TZ_GROUPS`. Setting a zone not in `TZ_GROUPS` leaves the
> trigger blank. Fix: in the Timezone card, render a fallback `SelectItem` for
> the current `form.timezone` when it is non-empty and not already in
> `TZ_GROUPS`, so any picked IANA zone displays correctly.

**Onboarding** (`steps.tsx`, `DjStep`): replace the Location + Latitude +
Longitude `Field`s with a single `<LocationPicker>` bound to `w.data.dj`.

*Timezone — onboarding = auto-apply.* Onboarding has no timezone control and the
step is meant to stay short, so `onPick` **auto-applies** the picked timezone:
`w.patch(d => ({ dj: { ...d.dj, timezone: result.timezone } }))`, with a small
visible note under the picker — e.g. "Timezone: `Asia/Kolkata` (from your
location)". No separate `<Select>`. If the operator only ever types coordinates
manually, `timezone` stays `''` (Auto / server zone), exactly as today.

Onboarding plumbing for the new field:

- `web/components/onboarding/useWizard.ts`:
  - add `timezone: string` to `WizardData.dj`; default `''` in `DEFAULT_DATA.dj`
    (`''` = Auto, matching the admin sentinel).
  - in `save()`, add `timezone: data.dj.timezone` to the request `body`.
- `controller/src/routes/onboarding.ts` save handler: add a pass-through line
  `if (typeof b.timezone === 'string') settingsPatch.timezone = b.timezone;`
  (alongside the existing `weather` / `station` lines). `settings.update()`
  already validates `timezone` via `isValidTimezone`, and Open-Meteo returns
  valid IANA names, so no extra validation is needed.

## Data flow

```
user types → LocationPicker (debounce) → GET /api/geocode?q=
  → controller geocodePlace() → Open-Meteo geocoding (cached)
  → results → dropdown → select
  → onChange fills {locationName, lat, lng} into host form state
  → onPick surfaces timezone:
       admin     → optional "set timezone" action (form.timezone)
       onboarding→ auto-applies (w.data.dj.timezone) + note
  → Save:
       admin     → existing settings save (lat/lng parseFloat, timezone) — path unchanged
       onboarding→ /onboarding/save body now carries timezone → settings.update()
  → getWeather() / station clock pick up new values — consumption UNCHANGED
```

## Error handling

- **Geocode request fails / no internet to Open-Meteo:** inline "Search
  unavailable — enter coordinates manually"; auto-expand manual fields. Config is
  never blocked by search being down. Timezone simply isn't set (stays Auto).
- **No matches:** "No matches" empty state.
- **Query < 2 chars:** no request; dropdown closed.
- **Out-of-range manual coords:** inline range hint; typing not blocked; save
  validation/`parseFloat` unchanged.

## Testing

This repo has no route/component test harness (only `npm run test:llm` pure
tests). The merge gate is `npm run lint` (`eslint . && tsc --noEmit`) in both
`controller/` and `web/`. Verification:

- `npm run lint` passes in `controller/` and `web/`.
- Manual smoke (dev stack), **admin**: Station tab → type a city → results →
  select → name/lat/lng fill → timezone suggestion offered → Apply → Save →
  "current:" line, weather, and station clock reflect the new location.
- Manual smoke, **onboarding**: DJ step → pick a city → lat/lng fill + timezone
  note shows → finish wizard → settings reflect location *and* timezone.
- Manual fallback: with search unreachable (or offline), the manual disclosure is
  reachable and saving works in both places.

## Files touched

- `controller/src/context.ts` — add `geocodePlace(q)` + cache.
- `controller/src/routes/public.ts` — add `GET /geocode`.
- `controller/src/routes/onboarding.ts` — pass `timezone` into `settingsPatch`.
- `web/components/LocationPicker.tsx` — **new** shared component.
- `web/components/admin/SettingsPanel.tsx` — mount picker in Station location
  card; timezone-suggestion action + Timezone-card fallback `SelectItem`.
- `web/components/onboarding/steps.tsx` — mount picker in `DjStep`; auto-apply
  timezone + note.
- `web/components/onboarding/useWizard.ts` — add `timezone` to `dj` state +
  default + save body.
```
