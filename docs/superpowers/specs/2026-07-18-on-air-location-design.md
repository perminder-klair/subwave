# On-Air Location

**Date:** 2026-07-18
**Origin:** Discord feature request (Jaz666) — "On Air Location vs Actual Location"

## The request

> Please can we have a separate "On-Air" location, one that the DJs refer to on air, which can be different from the location set for weather and time of day.
>
> Whilst I don't intend on making my station public, if web indexers ever got hold of the URL, my Station name coupled with the location could easily Dox me.
>
> I'd love my DJs to be able to refer to a wider location, rather than a specific town or city. "&lt;station name&gt; coming to you from the beautiful Peak District" — rather than "...from Buxton".

## Problem

SUB/WAVE has exactly one location concept: `weather.locationName`. One string does two unrelated jobs — it is the Open-Meteo readout label *and* the `{location}` substituted into the DJ system prompt. The admin UI states the overload outright (`StationSection.tsx:84`): *"The location sets where the DJ thinks it broadcasts from **and** drives the Open-Meteo weather."*

Accurate weather requires a precise point. Privacy wants a vague one. Today an operator must choose.

### What actually leaks

The Discord post named the DJ prompt. Auditing the code found **four** surfaces, and the largest is not the prompt:

| # | Surface | Reads | Exposure |
|---|---|---|---|
| 1 | `GET /now-playing` → `context.weather.location` (`public.ts:229`) | `config.weather.locationName` | **Unauthenticated**, polled by every listener every 5s, and rendered to listeners in the classic skin (`ScheduleDrawer.tsx:182,199`) |
| 2 | `GET /dj` → `location` (`public.ts:342`) | `s.weather.locationName` | **Unauthenticated** |
| 3 | DJ system prompt `{location}` (`prompts/system.ts:50`) | `s.weather.locationName` | Spoken on air |
| 4 | `Weather in {X}` context line (`prompts/context.ts:152`) | `context.weather.location` | Spoken on air |

Surface 1 is the real doxxing vector: anyone who finds the URL can `curl /now-playing` and read the operator's town from JSON. No DJ has to say a word. A fix that only changed the prompt placeholder would leave it wide open — and would also leave surface 4 announcing "Weather in Buxton" on air, defeating the request's stated purpose.

### What does *not* leak

- `weather.lat` / `weather.lng` are already separate and are the **only** input to the Open-Meteo call (`context.ts:67`). No geocoding happens at weather time. Coordinates never reach a prompt, a listener, or a public response.
- `agentPersonaPreamble` (`settings.ts:4068`) — used by the picker, request, and skill-segment agents — carries **no** location clause at all ("a personal internet radio station"). Those paths are already safe.

- **Time-of-day is already separate.** The request asks for independence from "the location set for weather *and time of day*". Time-of-day semantics run off the top-level `timezone` field (an IANA zone), which is already independent of `locationName` and is never spoken as a place name. That half of the ask needs no work.

So the split is clean. The precise location is *already* isolated to the API call; only its human-readable label is overloaded.

## Design

Add one optional setting. Route every spoken and public surface through it. Leave the coordinates and the operator-facing label alone.

### Field responsibilities after the change

| Field | Role | Who sees it |
|---|---|---|
| `weather.lat` / `weather.lng` | Precise point for Open-Meteo | Open-Meteo only |
| `weather.locationName` | Operator-facing label for those coordinates | Admin UI, `/debug`, CLI `status` — **never spoken, never public** |
| `weather.onAirLocation` *(new)* | What the DJ says and what public APIs publish | Listeners, the LLM, public JSON |

`weather.onAirLocation` defaults to `''`, meaning **fall back to `locationName`**. Every existing install and every fresh install behaves exactly as it does today until an operator opts in.

### Schema

`weather.onAirLocation: string`, default `''`, trimmed, capped at 80 chars (matching `locationName` and `station`).

**Placement — nested under `weather`, not top-level.** The `weather` block is really the *location* block (`lat`, `lng`, `locationName`, and only `units` is genuinely weather). Nesting buys correctness cheaply: the field rides the existing `'weather' in patch` validator gate, the existing `'weather' in req.body` live-apply gate in `routes/settings.ts:195`, and the existing `invalidateWeatherCache()` call inside it. A top-level key would need its own gate at each site — and missing the cache-invalidation gate is a live bug (see *Cache invalidation* below).

**Name — `onAirLocation`, not `onAirName`.** The codebase already uses an `onAir*` prefix for persona concepts (`onAirRosterClause`, `pickOnAirSpeaker`, `onAirRoster`); `onAirName` would read as "the on-air persona's name". `onAirLocation` greps clean.

### Resolution seam

One exported helper in `settings.ts`, next to `renderDjPrompt`:

```ts
// The place the station claims to broadcast from — what the DJ says and what
// public endpoints publish. Falls back to the weather label so installs that
// never set it are unchanged. weather.locationName stays the operator-facing
// label for the coordinates and is never spoken or published.
export function resolveOnAirLocation(s = cache) {
  return (s?.weather?.onAirLocation || '').trim()
    || (s?.weather?.locationName ?? DEFAULTS.weather.locationName);
}
```

**The fallback rule is expressed in two places, and that is intentional.** `context.ts` reads `config.weather.*`, never `settings.get()` (see *Config mirror*), so it cannot call this helper — it applies the same `onAirLocation || locationName` fallback against `config`. Every other consumer goes through `resolveOnAirLocation`. Keep the two in agreement; a reader finding the inline version in `context.ts` should not "fix" it by importing the helper, which would create a settings→context dependency the module deliberately avoids.

### Consumer changes

**`context.ts:getWeather()` — the high-leverage one.** Emit the on-air name as `location` on both the success (`:78`) and failure (`:83`) paths:

```ts
location: config.weather.onAirLocation || config.weather.locationName,
```

This single edit fixes **five** consumers at once, because they all read `context.weather.location`:
- `prompts/context.ts:152` — the spoken `Weather in {X}` line
- `skills/builtins/weather/tool.mjs:10` — the `location` field returned to the LLM
- `routes/public.ts:229` — `GET /now-playing`'s public `context` blob
- `web/.../ScheduleDrawer.tsx:182,199` — the listener-facing render
- `cli/src/commands/status.ts:66` — operator CLI (cosmetic; harmless either way)

`context.ts` reads `config.weather.*`, not `settings.get()`, so the value must be mirrored into `config` — see *Config mirror*.

**`prompts/system.ts:50`** — the `{location}` call site:

```ts
location: settings.resolveOnAirLocation(s),
```

**`settings.ts:4036`** — `renderDjPrompt`'s fallback chain. It reads `weather.locationName` directly, so it stays a live fallback for any caller that passes no `ctx`. Becomes:

```ts
const location = c.location || resolveOnAirLocation();
```

**`routes/public.ts:342`** — `GET /dj`:

```ts
location: settings.resolveOnAirLocation(s),
```

**`routes/debug.ts:288`** — admin-only diagnostic. Show **both**, so an operator can confirm the split is working. Mirror the existing config-fallback shape rather than the settings helper, since `settingsSnapshot` may be absent here:

```ts
location: settingsSnapshot?.weather?.locationName || config.weather.locationName,
onAirLocation: settingsSnapshot?.weather?.onAirLocation
  || config.weather.onAirLocation
  || settingsSnapshot?.weather?.locationName
  || config.weather.locationName,
```

**Deliberately unchanged:** `agentPersonaPreamble`. It has no location clause today. Adding one would *increase* leak surface in service of a privacy feature, and the picker/request/skill agents have never needed it. Out of scope.

### Config mirror

`context.ts` reads `config.weather.*`, so the new field needs a home and two mirror sites:

- `config.ts:235` — add `onAirLocation: ''` to the `weather` block
- `server.ts:176` — boot mirror: `config.weather.onAirLocation = s.weather.onAirLocation;`
- `routes/settings.ts:198` — live mirror: `config.weather.onAirLocation = result.saved.weather.onAirLocation;`

There is no env var for any location field today (`config.ts:235` hard-codes the defaults with no `process.env` override, unlike its neighbours). Keep it that way — this is settings-layer config, not boot config, and the root `.env` is deliberately a three-variable surface.

### Cache invalidation

`context.weather.location` is baked into a cached result with a 30-minute TTL. Without invalidation, an operator who changes the on-air location keeps hearing the old town on air for up to half an hour and keeps publishing it from `/now-playing`.

`routes/settings.ts:200` already calls `invalidateWeatherCache()` inside the `'weather' in req.body` gate. Nesting the field under `weather` means this works with no new code — **this is the main reason for the placement decision.** Verify it rather than assume it.

### Validation

`locationName`'s validator (`settings.ts:3169`) silently ignores empty strings — deliberate, since the weather label must never be blanked. `onAirLocation` needs the **opposite** behaviour: blanking is how an operator resets to the fallback. Do not copy the neighbouring pattern.

```ts
if (typeof w.onAirLocation === 'string') {
  next.weather.onAirLocation = w.onAirLocation.trim().slice(0, 80);
}
```

Three settings sites, as always: `DEFAULTS` (`:1087`), the load normalizer (`:1943`, `onAirLocation: stored.weather?.onAirLocation ?? DEFAULTS.weather.onAirLocation`), and the `update()` validator (`:3157`).

No `restart = true` — this applies live, like every other field in the block.

### Migration

None. An absent key normalizes to `''`, which falls back to `locationName`. Behaviour is byte-identical until an operator types something.

## Admin UI

**Decision: admin settings only.** The first-run wizard is deliberately short and this is an opt-in privacy refinement, not a setup requirement. `web/components/onboarding/**` and `routes/onboarding.ts` are untouched — and because the field nests under `weather`, the wizard's existing `settingsPatch.weather = b.weather` passthrough (`onboarding.ts:242`) would carry it anyway if that ever changes.

**Decision: free-text input, no geocode assist.** Operators know their own region better than a geocoder does — Jaz666 already knew they wanted "the Peak District". Suggesting `admin1`/`admin2` from Open-Meteo would mean changing the `/geocode` response shape, the `GeocodeResult` interface, and `LocationPicker`, for a worse answer. If operators ask for it later, that is its own issue.

### Changes

**`StationSection.tsx`** — a new field inside the existing "Station location" card, directly under `LocationPicker`:

- Label: `On-air location` with an `(optional)` affordance
- Placeholder: `e.g. the Peak District`
- Hint: *"What the DJ says on air and what public listeners see. Leave blank to use the location above. Set a broader area if you'd rather not name your exact town — the weather still uses the precise coordinates."*
- `maxLength={80}`
- Added to the `save()` payload at `:43-49`

**Copy that currently conflates the two — must be rewritten:**

- `:84` SectionHeader `sub` — the "sets where the DJ thinks it broadcasts from **and** drives the Open-Meteo weather" sentence
- `:108` Card `sub` — "DJ context + Open-Meteo weather"
- `:146` field hint — "Where the station broadcasts from. Sets the DJ's `{location}` and the Open-Meteo weather"

New framing: the picked location drives weather and is private to the operator; the on-air location is what the station says and publishes.

**Types and hydration:**

- `shared.tsx:22-27` — add `onAirLocation: string` to `WeatherCfg`
- `shared.tsx:252` — add `onAirLocation?: string` to the server-values `weather` shape
- `SettingsPanel.tsx:139-143` — hydrate: `onAirLocation: v.weather?.onAirLocation ?? ''`

**`SystemPromptModal.tsx:183`** — documents `{location}` to operators writing custom prompt templates. Update so it says `{location}` resolves to the on-air location, not the weather location.

## Known limitations

**Session history is not retroactively scrubbed.** The DJ session (`session.json`) is a chat history of past turns, and the system prompt is rebuilt per call. Changing the on-air location takes effect immediately for new output, but prior turns in the current session may still contain the old place name, so the model could echo it. Sessions roll on show/mood change or after 4h (`session.maybeRoll()`), so this self-corrects. Not worth building around; document it in the field hint's neighbourhood or the release note.

**No way to express "say no location at all."** Blank means fall back, so there is no value that suppresses the location entirely. The escape hatch already exists: `{location}` is not a mandatory placeholder (only `{name}` is — `update()` refuses templates dropping it), so an operator who wants no location can remove `{location}` from their custom DJ prompt template.

## Verification

No test runner in this repo. Gates and checks, in order:

1. **Lint is the merge gate** — `npm run lint` in `controller/` and `web/` (`eslint . && tsc --noEmit`). CI runs both.
2. **`/verify` skill** — drives the controller + admin UI end-to-end from this worktree on a spare port with a temp `STATE_DIR`, without touching the live station. This is the right harness for the admin-form round-trip.
3. **Manual checks** that matter, since they cross the settings→config→context boundary:
   - Fresh state with no `onAirLocation` → `/dj` and `/now-playing` return `locationName` exactly as before (no-op proof)
   - Set on-air location → `curl /now-playing | jq .context.weather.location` returns the new value **within seconds**, not 30 minutes (proves `invalidateWeatherCache()` fires through the nested key)
   - `curl /dj | jq .location` returns the on-air value
   - `curl /debug` (admin) shows both fields, differing
   - Blank the field → both endpoints revert to `locationName` (proves the empty-string validator, the one place the neighbouring pattern is wrong)
   - Weather readout is still correct for the *precise* coordinates while naming the *vague* place

## Out of scope

- Geocode-assisted region suggestions (`admin1`/`admin2` from Open-Meteo)
- Onboarding wizard field
- Adding a location clause to `agentPersonaPreamble`
- Any change to `web/lib/stations.ts`'s public station-directory `location` — a separate free-text field on submitted third-party stations, different concept and data source
- Env-var override for any location field
