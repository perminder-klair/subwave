# SUB/WAVE Plugin System — Design

**Date:** 2026-07-12
**Status:** Draft for review

## Summary

Generalize the existing skills system into a plugin system: a plugin is a skill
folder that can, beyond airing a spoken segment, also **react to station events**,
**influence track selection**, **queue tracks and announcements**, and **run on its
own schedule**. Everything stays in the controller's existing runtime and trust
model — one load root, dynamic import, fenced call sites, discovered-but-disabled.

## Decisions (from brainstorm)

| Question | Decision |
|---|---|
| Scope | DJ behaviors & segments only — no web-UI extensions, no audio pipeline, no new music sources |
| Capabilities | Event hooks, picker influence, queue/announce actions, scheduled jobs (+ segments, which skills already do) |
| Distribution | Disk-drop + admin UI (existing zip import/export carries plugins; no registry/npm in v1) |
| Relation to skills | Skills become one plugin capability — a skill is a segment-only plugin; `state/skills/` stays the single load root, nothing breaks |
| Isolation | In-process, defensively wrapped — timeout + try/catch per call, auto-disable after repeated failures |
| API shape | Declarative definition object exported from `plugin.mjs` (inspectable without executing handlers) |

## Plugin format

A plugin lives where skills live: `state/skills/<slug>/`. It is a skill folder
with one new optional file:

```
state/skills/
  play-milestones/
    SKILL.md      # manifest (frontmatter) + optional segment brief (body)
    tool.mjs      # OPTIONAL: segment data fetcher (unchanged)
    plugin.mjs    # NEW, OPTIONAL: the plugin definition module
```

`SKILL.md` remains the manifest. One loader rule change: today a non-seeded
skill is rejected when the body (the DJ's brief) is empty; with a valid
`plugin.mjs` present, an empty body becomes legal — the plugin simply has no
between-track segment. Frontmatter gains two optional, purely informational
keys: `version:` and `author:` (shown in `/admin/skills`, no behavior).

### `plugin.mjs` contract

```js
export default {
  hooks: {
    // all optional; async; each call fenced (8s timeout + try/catch)
    trackStarted:    async (ctx, ev) => {},  // ev: { track, previous }
    requestReceived: async (ctx, ev) => {},  // ev: { requester, text }
    sessionRolled:   async (ctx, ev) => {},  // ev: { fromKey, toKey, show }
  },
  schedules: [
    // node-cron expressions, validated at load; runs are rate-limited — a run
    // firing <5 min after the plugin's previous run is skipped and logged
    { cron: '0 18 * * 5', label: 'friday kickoff', run: async (ctx) => {} },
  ],
  picker: {
    // contribute up to 5 candidates to the pool (pool-mode picker only, see limits)
    candidates: async (ctx) => [/* songs from ctx.library / ctx.search */],
    // one call per pick with the FULL candidate list; return ids to drop
    veto: async (ctx, candidates) => [/* subsonic ids to exclude */],
  },
};

// OPTIONAL, same contract as tool.mjs: gate availability (e.g. on an API key)
export const ready = (services) => true;
```

Everything is optional; a plugin declaring nothing but `hooks.trackStarted` is
valid. The loader validates the shape at import time (unknown keys warned and
ignored; non-function handlers rejected with a logged error, mirroring how a
malformed `tool.mjs` degrades today).

### The `ctx` object

`ctx` is the existing `StationServices` facade (`station-services.ts` —
`nowPlaying`, `recentPlays`, `library`, `searchWeb`, `fetchHeadlines`,
`onThisDay`, `recall`, `log`) extended with an **actions** surface:

```js
ctx.actions.announce(text, { atNextTrack = false } = {})
ctx.actions.queueTrack(songId, { intro = null } = {})
```

- `announce` wraps `queue.announce(text, kind)` with `kind` fixed to the
  plugin's own slug — so plugin speech rides the existing voice serializer,
  jingle-hold, session logging, and anti-repeat dedup (`registerSkillKinds`
  already registers every loaded kind). `atNextTrack: true` routes through
  `queue.announceAtNextTrack`. Gated (see Safety).
- `queueTrack` resolves the id via Subsonic, then `queue.push({ track,
  requestedBy: 'plugin:<slug>', introScript: intro })` — riding the existing
  dedup guard and never-play blocklist for free.

`ctx.log(msg)` prefixes `[plugin:<slug>]` into the station event log.

## Runtime: `skills/plugin-runtime.ts` (new module)

One module owns everything dynamic about plugins, rebuilt by `loadSkills()` on
every rescan:

- **Hook dispatch.** `emitStationEvent(name, ev)` — called from the three emit
  points below. Dispatch is `setImmediate`-deferred (never blocks the hot
  path), sequential per plugin, each handler behind the same `withTimeout(…,
  8000)` + try/catch shape as `segment-tools.ts`.
- **Schedule registry.** On rescan, existing plugin cron jobs are destroyed and
  re-registered from the current definitions (`cron.validate` at load; invalid
  expressions rejected with a logged error). Runs are fenced like hooks.
- **Failure accounting + auto-disable.** A per-plugin, per-capability counter:
  5 consecutive failures (throw or timeout) auto-disables that capability
  in-memory, logs loudly, and surfaces in the admin catalogue. A successful
  call resets the counter; a rescan or re-enable clears the state.

### Emit points (three one-line seams)

| Event | Where | Payload |
|---|---|---|
| `trackStarted` | `queue.onTrackStarted()` (`broadcast/queue.ts:1180`) | `{ track, previous }` |
| `requestReceived` | `djAgent.runRequest()` entry (`broadcast/dj-agent.ts:929`) | `{ requester, text }` |
| `sessionRolled` | `session.maybeRoll()` roll branch (`broadcast/session.ts:270`) | `{ fromKey, toKey, show }` |

A show boundary *is* a session roll (`sessionKeyFor` derives from the active
show), so `sessionRolled` covers show start/end without a separate event; the
`show` field tells the plugin which show (if any) just came on air.

### Picker seams (two)

- **Candidates:** inside `buildCandidates()` (`music/picker.ts:178`), after the
  built-in sources: for each enabled plugin with `picker.candidates`, call it
  fenced (4s timeout), take the first **5** results, `add('plugin:<slug>',
  items)`. Plugin candidates get the same dedup/recency filtering as every
  other source.
- **Veto:** in `pickViaPool()` alongside the existing excluded-playlist filter
  (`music/picker.ts:595`): one fenced call (4s timeout) per plugin with the
  full candidate list; returned ids are dropped. If vetoes would empty the pool, the veto
  result is discarded (logged) — a plugin must not be able to silence the
  station.

**Known limit (documented, accepted):** agent-mode picking (`pickViaAgent`,
default on) selects via tools, not the pool, so plugin candidates/vetoes apply
only when the pool picker runs (agent off, budget-soft, breaker open, agent
failure fallback). Exposing plugin pickers as agent tools is explicitly out of
scope for v1.

## Safety & budget

- **Announce gating:** `ctx.actions.announce` checks, in order: plugin enabled →
  `optionalSegmentsAllowed()` (`dj-budget.ts` — plugin voice mutes under budget
  pressure exactly like built-in segments) → per-plugin announce cooldown (the
  skill's existing `cooldown:` frontmatter value, default 60 min, floor 5 min).
  A gated call returns `{ aired: false, reason }` rather than throwing.
- **queueTrack gating:** plugin enabled + a per-plugin cap of 2 queued tracks
  pending at once. No budget gate (no tokens spent); blocklist and dedup apply
  via `queue.push`.
- **Enable state:** the existing single toggle per slug
  (`settings.skills.enabled`). Operator plugins arrive **disabled**, like all
  operator skills. No per-capability toggles in v1 — auto-disable handles the
  misbehaving-capability case; the toggle handles trust.
- **Trust posture unchanged:** `plugin.mjs` is operator code in `state/`, same
  as `tool.mjs` today. No sandbox claim is made; fencing is about *accidents*
  (hangs, throws), not hostility. Docs say this plainly.

## Loader & admin changes

- `skills/loader.ts` — `loadSkillDir()` additionally imports `plugin.mjs`
  (cache-busted, like `tool.mjs`), validates the definition shape, and attaches
  `cap.plugin`. The empty-body rule is relaxed when a plugin definition loads.
- `skills/plugin-runtime.ts` — new, as above. `loadSkills()` calls its
  `rebuild(caps)` at the end of every scan.
- `routes/dj.ts` — `skillCatalog()` gains per-slug capability metadata
  (`{ hooks: [...], schedules: n, picker: {candidates, veto}, autoDisabled:
  [...] }`) for the UI. Rescan/enable/create/delete/zip-import routes work
  unchanged (they operate on folders and the enabled map).
- `web/…/SkillsPanel.tsx` — capability badges on each card (hooks / schedule /
  picker), an auto-disabled warning state, and `version`/`author` display.
  No new pages.
- **Community catalog stays prompt-only.** Code-carrying plugins are not
  accepted through the community-submission flow in v1 (review burden);
  the catalog and its install route are untouched.

## Documentation & examples

- `docs/plugins.md` — the operator-facing guide (contract, ctx reference,
  safety model), cross-linked from `docs/custom-skills.md` ("skills are
  segment-only plugins").
- `docs/examples/plugins/play-milestones/` — counts plays via `trackStarted` +
  `recall`, announces every 100th track. Exercises hooks + announce.
- `docs/examples/plugins/friday-kickoff/` — a `schedules` entry that queues an
  upbeat starred track and announces the weekend. Exercises schedules +
  queueTrack.

## Testing

- Pure logic — definition-shape validation, failure-counter/auto-disable state
  machine, cron/interval validation, veto-empties-pool guard — lands in pure
  functions pinned by a `controller/scripts/plugins.test.ts` (same pattern as
  `programme.test.ts` / `llm-pure.test.ts`), wired into `npm run test:*`.
- `npm run lint` (eslint + tsc) in `controller/` and `web/` stays the merge gate.
- Manual verification: the two example plugins, installed into a dev stack,
  driven via the existing manual-fire route and a forced pool pick.

## Out of scope (v1)

Web-UI extensions, audio-pipeline plugins, new music-source providers,
npm/registry distribution, real sandboxing (workers/processes), per-capability
enable toggles, plugin-supplied agent tools for the agent-mode picker, plugin
settings UI (plugins read their own frontmatter via `config`, as tools do
today).
