# Unified skills architecture — built-ins and custom skills share one mechanism

**Date:** 2026-06-30
**Depends on:** PR #695 (admin skill CRUD + `now-playing-dig`) — this refactors files that PR introduced, so it stacks on / lands after it.

## Problem

A SUB/WAVE skill (a between-track segment) is defined two different ways depending
on who ships it:

- **Built-in skills** — metadata in the `CAPABILITIES` table (`skills/_agent.ts`),
  and their data tool in a hand-written, `kind`-keyed block in
  `llm/internal/tools/segment-tools.ts` (compiled TypeScript). The data tool reaches
  straight into the station's internals: `searchWeb`, the Subsonic client
  (`getArtist`/`getAlbum`/`searchArtists`), `queue` (now-playing, `recentlyPlayed`),
  the on-this-day fetcher.
- **Custom skills** — a self-contained directory `state/skills/<slug>/` with
  `SKILL.md` (metadata + brief) and an optional `tool.mjs` (`export default async
  (ctx, state) => data`). The fetcher receives only the **moment** — `ctx =
  { time, weather, festival, dominantMood, clock }` — and `state` (cross-tick
  memory). It has **no handle to search, the library, or the play log.**

Two consequences:

1. **Capability gap.** A custom `tool.mjs` literally cannot do what `now-playing-dig`,
   `library-deep-cut`, `web-search`, or `curiosity` do — it can't search the web or
   query the library. So any genuinely useful new skill has to be built *into* core.
2. **Plumbing cruft.** Adding a built-in touches ~6 files because `kind` is duplicated
   across parallel hand-maintained lists: `CAPABILITIES`, `BUILTIN_KINDS`
   (`loader.ts`), `queue`'s `VOICE_KINDS`/`DEDUPE_KINDS`/`KIND_LABEL`, and
   `tts.VOICE_KINDS`. (We felt this adding `now-playing-dig`.)

## Goal

**Every skill — shipped or operator-added — is a self-contained directory
(`SKILL.md` + optional `tool.mjs`) built against one shared station-services API.
The seven built-ins are just pre-installed skills.** Adding a skill (built-in or
custom) is the same recipe: drop a folder, write the brief, optionally add a
`tool.mjs` using `ctx.services`.

### Non-goals

- No change to *what the skills do* — `now-playing-dig` still digs, weather still
  reads the weather. Pure mechanism refactor; on-air behaviour is unchanged.
- No new skill features (no new context fields, no scheduling changes).
- No change to the admin UI's skill sheet beyond what falls out of the registry
  change (it already reads `skillCatalog()`).

## Target architecture

### 1. Station-services API (the unlock)

Introduce a single, curated services facade and pass it to **every** tool fetcher
as a third argument — additive, so existing 2-arg custom `tool.mjs` files keep
working unchanged:

```js
export default async function (ctx, state, services) { … }
//   ctx      — the moment: { time, weather, festival, dominantMood, clock }
//   state    — cross-tick dedup memory (persists between firings)
//   services — the station (NEW)
```

`services` (built in `llm/internal/tools/station-services.ts`, one factory, typed):

```
services = {
  searchWeb(query, opts?),          // the configured provider (DDG/Tavily/SearXNG)
  searchReady(): boolean,           // is a provider configured?
  nowPlaying(): { artist, title, album, year, id } | null,   // queue.current.track
  recentPlays(hours): { ids:Set, keys:Set },                 // queue.recentlyPlayed
  library: { getArtist, getAlbum, searchArtists },           // Subsonic facade
  onThisDay(): Promise<items>,      // curiosity's fetchOnThisDay
  log(msg): void,                   // queue.log('skills', …) — namespaced
}
```

The factory is the *only* place these internals are wired. Built-in tools and custom
`tool.mjs` both consume `services`; neither imports controller internals directly.

### 2. Built-ins are pre-installed skill directories

The seven built-ins move from the `CAPABILITIES` array + `segment-tools.ts` blocks to
shipped directories:

```
controller/src/skills/builtins/<kind>/   # bundled in the image, first-party, read-only
  SKILL.md                               # frontmatter (kind/label/cooldown/window/context/requiresKey…) + brief
  tool.mjs                               # optional; the same (ctx,state,services)=>data contract
```

> **Location:** under `src/` (not a top-level `controller/skills/`) because the
> controller runs `tsx src/server.ts` in both dev and prod, the Dockerfile only
> `COPY`s `controller/src`, and dev bind-mounts `controller/src`. Putting the
> built-in dirs under `src/` gives them the prod COPY and the dev bind-mount with
> no Dockerfile or compose change. The loader resolves the dir relative to its own
> `import.meta.url`.

- The loader scans **two roots**: `controller/skills` (built-ins) then
  `state/skills` (operator). A built-in's `SKILL.md` is still **scaffolded to
  `state/skills/<kind>/SKILL.md` as an editable override** (prompt/cooldown/context/
  feed) — the merge-over-default behaviour from today is preserved, so operators keep
  editing built-in briefs in the admin sheet.
- A built-in's `tool.mjs` runs from the **read-only app dir** — first-party code,
  not operator-editable, not scaffolded to `state/`. (An operator can still *override
  the brief*; they cannot break weather's fetch.) This keeps the "edit the words, not
  the code" guarantee for built-ins while using the identical loader path.
- `CAPABILITIES` (the array) is replaced by "load the built-in directories at boot."
  `builtinCapabilities()` becomes "built-ins + their `state/` overrides," same shape
  as today.

### 3. One registry → derived `kind` lists

A single loaded-skill registry becomes the source of truth. Derive, rather than
hand-maintain:

- `BUILTIN_KINDS` → the set of kinds loaded from `controller/skills`.
- `RESERVED_KINDS` → `BUILTIN_KINDS` + the queue-internal kinds (`link`, `dj-speak`,
  `station-id`, `hourly-check`, `announcement`).
- `queue`'s `VOICE_KINDS` / `DEDUPE_KINDS` / `KIND_LABEL` → derived from the registry
  (every loaded skill kind is a voice + dedupe kind; label defaults to the kind).
- `tts.VOICE_KINDS` → the fixed voice channels (`dj-speak`/`link`/`station-id`/
  `hourly-check`/`jingle`/`default`) **plus** every loaded skill kind.

Adding a skill then touches **one place**: its directory.

### 4. Readiness lives with the skill

Some built-ins gate on more than a static env var (web-search / now-playing-dig are
ready only when a search provider is configured; that's *dynamic*, provider-derived).
Express readiness in the skill's own module so it stays self-contained:

```js
export const ready = () => services...   // optional; absent → always ready
```

- The loader reads optional `ready` from the tool module (alongside `default`).
- `SKILL.md` frontmatter keeps `requiresKey` / (optional) `keyUrl` for the **admin UI
  affordance** ("set SEARCH_API_KEY"). The web-search provider-dependent `requiresKey`
  (Tavily needs a key, DDG doesn't) is computed in `skillCatalog()` exactly as today —
  that small piece of provider-aware UI logic stays; it's display-only.
- The agentic tick's gate becomes: skill enabled + assigned + off-cooldown + in-window
  + `ready()` (if present). Same as today, just sourced from the module.

## The unified `tool.mjs` contract (documented)

```js
// state/skills/<slug>/tool.mjs  (or controller/skills/<kind>/tool.mjs for built-ins)
export default async function (ctx, state, services) {
  // Return JSON-serialisable data, or { available: false } to tell the agent
  // there's nothing worth airing right now (the DJ then stays silent or skips).
  return { available: true, … };
}
export const ready = () => services.searchReady();  // OPTIONAL
```

Backward compatible: existing custom skills (`(ctx, state) => …`, e.g. the operator's
`bhangra-tip`) ignore the third arg and keep working.

## Migration & backward compatibility

- **Existing custom skills** — unaffected (services is additive; signature unchanged).
- **Existing `state/skills/<kind>/SKILL.md` built-in overrides** — still parsed as
  overrides over the (now directory-shipped) built-in default. Same merge.
- **The seven built-ins** — their briefs (current `CAPABILITIES.desc`, post-#695) move
  verbatim into `controller/skills/<kind>/SKILL.md`; their tools move from
  `segment-tools.ts` blocks into `controller/skills/<kind>/tool.mjs` rewritten against
  `services`. No behaviour change.
- A running station that already scaffolded the old built-in `SKILL.md` files keeps
  them (file wins), same as today.

## What gets deleted / shrinks

- The `CAPABILITIES` literal array (replaced by directory load).
- The per-kind `if (kinds.has('weather'))…` blocks in `segment-tools.ts` (collapse to:
  for each offered cap with a tool module, wrap it with `services` injected).
- The hand-maintained `kind` lists in `loader.ts`, `queue.ts`, `tts.ts` (derived).

## Security posture

`services` hands operator-supplied `tool.mjs` access to `searchWeb` (which may spend
the operator's paid Tavily quota) and the Subsonic client (which can hit Navidrome).
This widens the existing sandbox. Mitigations / rationale:

- The 8 s timeout fence + try/catch already wrap every tool call (degrade to "no data",
  never hang the tick).
- It is the operator's own controller and their own keys — the same trust model as a
  locally-installed Claude Code skill, which the docs already state. Custom skills are
  still **discovered-but-disabled** until the operator enables them.
- `services` is a *curated* facade (read-mostly: search, library reads, play-log reads,
  log). It exposes no write/delete/settings/secret surface. This is called out as a
  deliberate boundary, not "hand them the whole controller."

## Files touched (anticipated)

- **New:** `controller/skills/<kind>/{SKILL.md,tool.mjs}` ×7;
  `llm/internal/tools/station-services.ts`.
- **Rewritten:** `skills/_agent.ts` (load built-in dirs instead of `CAPABILITIES`;
  ready-from-module), `llm/internal/tools/segment-tools.ts` (generic wrap + services),
  `skills/loader.ts` (scan two roots; derive `BUILTIN_KINDS`/`RESERVED_KINDS`; read
  optional `ready`), `skills/scaffold.ts` (seed overrides from the built-in dirs),
  `broadcast/queue.ts` (derive kind sets/labels), `audio/tts.ts` (derive voice kinds).
- **Docs:** `docs/custom-skills.md` (the `(ctx, state, services)` contract + the
  services reference + the `ready` export); the example skill under
  `docs/examples/skills/`.

## Testing & verification

No unit runner; the merge gate is `npm run lint` (eslint + `tsc --noEmit`) in
`controller/` + `web/`. Plan:

1. Lint green in both packages.
2. Dev-stack smoke: each of the seven built-ins still appears in `/dj/skills`, scaffolds
   its override, and **Run now** fires it (weather speaks, now-playing-dig searches the
   on-air track, curiosity hits on-this-day, etc.) — proving the `services`-backed tools
   match the old hardcoded ones.
3. A throwaway **custom** skill with a `tool.mjs` that calls `services.searchWeb` /
   `services.library` returns data and airs — proving the capability gap is closed.
4. The operator's existing `bhangra-tip` (2-arg `tool.mjs`) still loads and runs —
   proving backward compatibility.
5. Adding a hypothetical built-in touches only its directory — proving the derived lists.

## Suggested implementation order (one PR, staged commits)

1. `station-services.ts` factory + thread `services` through `buildSegmentTools` and the
   custom-tool wrap (3rd arg). Existing built-in blocks rewritten to use `services` in
   place (still in `segment-tools.ts`). — *capability + plumbing, no behaviour change.*
2. Move the seven built-ins to `controller/skills/<kind>/` dirs; loader scans two roots;
   `CAPABILITIES` array removed; `segment-tools.ts` blocks deleted (tools now live in the
   dirs). — *the unify.*
3. Derive `BUILTIN_KINDS`/`RESERVED_KINDS`/queue sets/tts kinds from the registry. —
   *kill the duplication.*
4. Docs + example skill.

## Contract (as built)

The tool fetcher signature is **`(ctx, state, services, config)`** — `services` is
a 3rd arg (so `ctx` stays "the moment" and `services` is "the station"), and a 4th
`config` arg carries the skill's own frontmatter (e.g. news' `feed`/`feedMaxItems`),
which surfaced as a need while porting. The tool module may also export an optional
`description` (the agent-facing tool description) and an optional
`ready(services) => boolean` (gates availability — e.g. web-search/now-playing-dig
return `services.searchReady()`). All additive, so existing two-arg custom skills
keep working.
