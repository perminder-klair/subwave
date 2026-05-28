# Selection rules — plan + spec

Two listener asks landed on the same week and want the same feature, from
opposite sides:

- **#172 (corvock)** — *exclude* genres/artists/albums from being picked
  (Christmas, classical). "I love how it's working, just want to exclude
  some albums."
- **AzuraCast-style rules (separate feedback)** — *force-insert* a track
  from a specific Navidrome playlist or folder every N tracks or every Y
  minutes. Use cases: hourly idents, an SFX clip every 7 tracks, story
  vignettes for a themed-universe station.

Both are programmable selection rules over the picker's output — one
subtractive, one additive. We can give the operator a single **Rules**
surface in admin and back it with two execution paths inside SUB/WAVE.

## TL;DR

One new `settings.rules[]` array. Each rule is either an **exclude** rule
(filters the picker's candidate pool) or a **force-insert** rule (jams a
track into the broadcast at a cadence). Force-insert with a track-counted
cadence runs in Liquidsoap; with a minute-counted cadence it runs in the
controller scheduler. Admin gets a new `/admin/rules` page. No new
dependencies. The existing `jingleRatio` knob stays as the simplest case
of an implicit always-on rule — we don't migrate it.

Estimated work: 1.5 days for v1, mostly UI + the Liquidsoap rotate-slot
plumbing.

## Data model

`state/settings.json` gains:

```ts
rules: Rule[]                       // ordered; UI displays + reorders

type Rule = {
  id: string;                       // uuid
  name: string;                     // operator-facing label
  enabled: boolean;
  mode: 'exclude' | 'force-insert';
  source: RuleSource;
  cadence?: RuleCadence;            // force-insert only
  pickStrategy?: 'random' | 'least-recently-played';  // force-insert only
  djBehavior?: 'silent' | 'announce';                 // force-insert only
}

type RuleSource =
  | { kind: 'playlist'; ref: string }    // Subsonic playlist id
  | { kind: 'genre'; ref: string }       // genre name
  | { kind: 'artist'; ref: string }      // artist id
  | { kind: 'album'; ref: string }       // album id
  | { kind: 'jingle-tag'; ref: string }  // pre-rendered TTS jingle pool, filtered

type RuleCadence =
  | { kind: 'every-n-tracks'; value: number }
  | { kind: 'every-n-minutes'; value: number; jitter?: number }
```

Why this shape:

- **Single table, two modes** keeps the admin UI coherent — same source
  pickers, different downstream action.
- **Source is a union** because Subsonic exposes four natural scopes
  (playlist / genre / artist / album); `jingle-tag` is the controller-side
  TTS pool, included so operators can mix custom-tagged ident rotations.
- **Folder paths are deliberately not a source**. Listeners can already
  achieve "play from folder X" by saving that folder as a Navidrome
  playlist, and going through playlists avoids us re-implementing
  filesystem scanning inside the controller.
- **No conditionals** (day-of-week, time-of-day, listener count) in v1.
  They're easy to retrofit by adding a `when?: {...}` field later.

Validation in `controller/src/settings.ts`:

- `rules` is bounded (`max 32` entries) to keep the Liquidsoap rotate
  chain tractable.
- `every-n-tracks.value ∈ [1, 1000]`, `every-n-minutes.value ∈ [1, 720]`.
- For force-insert: `cadence` is required; for exclude: `cadence` must be
  absent.
- A force-insert rule pointing at a `genre`/`artist` source is **not
  allowed** (forcing "play a random rock track" makes no sense as a
  cadenced insert — it's just biasing the pool). Force-insert sources are
  restricted to `playlist | album | jingle-tag`.

## Execution paths

### Path A — exclude rules (picker filter)

Single filter pass in `controller/src/music/picker.ts buildCandidates()`,
just before each `add(...)` call. A candidate is dropped if any
**enabled, mode='exclude'** rule matches it:

- `genre` → match against `candidate.genre` (case-insensitive)
- `artist` → match against `candidate.artistId` or `candidate.artist`
- `album` → match against `candidate.albumId`
- `playlist` → membership check against a memoised playlist-track-id set
  (refreshed every 30 min via the existing memo cache pattern)

Same filter is wired into `controller/src/llm/tools.ts` — passed in as
`excludedIds` / `excludedArtists` / `excludedGenres` alongside the
existing `recentIds` etc. The agent path then literally cannot fetch
blocked tracks via `searchLibrary` / `similarSongs` / `topByArtist`.

The picker's `done`-schema prompt gets one extra line:

> Your library has tracks excluded by operator-configured rules
> (e.g. genres/artists they don't want on air). You will not see those
> tracks in any tool result. If the pool looks thin, that's why — pick
> from what's available.

Edge case: if exclude rules wipe out >90% of candidates the picker
already has a "no candidates available" branch. We add a single
`queue.log('rules', 'exclude rules removed N candidates from pool')`
breadcrumb so debugging is easy. We don't auto-disable rules — the
operator decides.

### Path B — track-counted force-insert (Liquidsoap rotate slots)

This is the same mechanic that already runs the jingles slot. Today
`radio.liq` has:

```liquidsoap
radio = rotate(
  weights=[1, jingle_ratio()],
  [jingles, radio]
)
```

We extend it to N additional rule slots. To avoid regenerating Liquidsoap
source on every rule change, **`radio.liq` pre-declares a fixed number of
rule slots (6)** and reads two state files per slot:

- `state/liquidsoap_rule_N.m3u` — empty file means "slot inactive"
- `state/liquidsoap_rule_N_ratio.txt` — integer; 0 means "slot inactive"

```liquidsoap
rule_slots = [1, 2, 3, 4, 5, 6]
rule_sources = list.map(fun (i) ->
  playlist(id="rule_#{i}", reload_mode="watch",
           "/var/sub-wave/liquidsoap_rule_#{i}.m3u"),
  rule_slots
)
# weights are read at startup from liquidsoap_rule_N_ratio.txt (0 = skip)
```

The empty-playlist case is benign — Liquidsoap's `playlist(...)` with no
items contributes nothing to the rotate output, so unused slots are
inert.

**Controller side** — when settings save:

1. For each track-counted force-insert rule (up to 6 active), allocate
   it to a slot index.
2. Resolve `source.ref` → list of track ids → annotated `subhttp:` URIs
   (same `getAnnotatedUri` path the queue uses).
3. Write `state/liquidsoap_rule_N.m3u` and
   `state/liquidsoap_rule_N_ratio.txt`.
4. Trigger `restart-mixer` so the new weights take effect. (We can't hot-swap
   weights — the `rotate(weights=…)` value is read at construction.)

Two thorns:

- **Weight semantics.** Liquidsoap `rotate(weights=[w1, w2, …])` picks
  source `i` every `(w1+w2+…)/wi`-th track. So "every 7th track from rule
  R1" alongside jingle-ratio 30 means: `w_radio=1, w_jingles=30,
  w_R1=K` where `K` satisfies `(1+30+K)/K = 7` → `K = 31/6 ≈ 5.17`. We
  round to nearest integer (5). Document the rounding in the rule form
  ("cadence is approximate — actual: every ~7 tracks"). For multiple
  rules the math compounds; we compute all weights together in
  `controller/src/broadcast/rule-weights.ts` (new file).
- **Reload of slot ratios.** Current `radio.liq` only reads
  `liquidsoap_jingle_ratio.txt` at startup. We follow the same pattern
  for rule ratios — startup-only, restart-mixer on change. No tighter
  reactivity needed; rule changes are a deliberate operator action.

If the operator configures >6 track-counted rules, validation fails with
"max 6 track-counted force-insert rules; the rest must be
minute-counted." This is a soft cap we can lift later by widening
`rule_slots` in `radio.liq`.

### Path C — minute-counted force-insert (controller scheduler)

Existing `controller/src/broadcast/scheduler.ts` already ticks on the
top of every minute. We add a new handler per minute-counted rule:

- On each minute tick, for each enabled minute-counted rule, check
  `lastFiredAt`. If `now - lastFiredAt >= rule.cadence.value` minutes,
  the rule is **due**.
- Resolve `source.ref` → candidate track list, apply `pickStrategy` to
  pick one.
- Inject it at the head of `upcoming` via a new
  `queue.injectRule(rule, track)` method that:
  - Logs the rule-driven play distinctly so `/debug` shows it.
  - Optionally writes a TTS intro via `tts.speak()` before the track
    (`djBehavior: 'announce'`).
  - Sets `lastFiredAt = now` (persisted to settings — we add a tiny
    `state/rules-state.json` for ephemeral per-rule timestamps so
    settings.json doesn't churn).
- If multiple rules come due in the same tick, sort by `weight` desc and
  insert in order; they queue back-to-back rather than competing for the
  same slot.
- Jitter (`every-n-minutes.jitter`) adds `±jitter%` to the next-due
  computation, avoiding mechanical-clockwork-feel.

Why a separate `state/rules-state.json` and not settings: settings is
operator-authored config that flows through validation and triggers
Liquidsoap restarts. `lastFiredAt` is runtime state — updating settings
every minute would be wrong, both semantically and because of the
restart-mixer side-effects on the track-counted path.

## DJ behaviour around forced inserts

The session DJ agent (`broadcast/dj-agent.ts`) sees a "track started"
event for every track that plays — including rule-injected ones. Today
that triggers `runTrackEvent`, which picks the *next* track and writes a
between-track link.

Two behaviours, operator's choice per rule:

- `djBehavior: 'silent'` — the rule-injected track plays cold. The agent
  still sees the event but we mark the session message with
  `kind: 'rule-track'` so the prompt knows not to back-announce it.
- `djBehavior: 'announce'` — controller pre-writes a TTS line *before*
  the rule track lands ("Quick sponsor message…", "Time for the hourly
  ident…", or operator-supplied template). The agent then picks the
  *next* music track as usual.

Both behaviours append a turn to the session so the broader narrative
stays coherent — the DJ persona can later make passing reference to "the
sponsor we just heard."

## Admin UI

New `/admin/rules` route under the existing `AdminShell`.

Top-level: table of rules with columns `Enabled | Name | Mode | Source |
Cadence | Actions`. Row drag-reorders set rule priority (matters for
`weight` resolution in Path C, and for slot allocation in Path B).

Edit modal:

1. **Mode** segmented control (`Exclude` / `Force-insert`).
2. **Source** picker — dropdown for kind, autocomplete for ref. The
   autocomplete hits new helper endpoints under
   `controller/src/routes/library.ts`:
   - `GET /api/library/playlists` (existing — reuses `getPlaylists`)
   - `GET /api/library/genres` (new, thin wrapper over Subsonic
     `getGenres`)
   - `GET /api/library/artists?q=` (new, search)
   - `GET /api/library/albums?q=` (new, search)
3. **Cadence** controls (only when mode=force-insert). Number input
   plus unit toggle (`tracks` / `minutes`). Live preview: "≈ every 7
   tracks — actual rotation: 7.2".
4. **Pick strategy** + **DJ behaviour** dropdowns.
5. **Test** button → calls `POST /api/rules/:id/test`:
   - For exclude rules → returns count of currently-affected tracks +
     sample of 5 titles.
   - For force-insert rules → returns next 3 tracks the rule would pick.

Saving any rule POSTs to `/api/rules`, which delegates to
`settings.update({ rules: [...] })` so all the validation + Liquidsoap
restart machinery runs through the existing path.

## API surface

- `GET /api/rules` — list (admin-gated, behind `requireAdmin`)
- `POST /api/rules` — create
- `PUT /api/rules/:id` — update
- `DELETE /api/rules/:id` — delete
- `POST /api/rules/:id/test` — preview matches / picks
- `GET /api/library/{genres,artists,albums}` — autocomplete sources for
  the rule form

All admin-gated, all routed through `controller/src/routes/rules.ts` (new)
and `controller/src/routes/library.ts` (extend existing if any, else new).

## Files touched

New:

- `controller/src/routes/rules.ts` — CRUD + test
- `controller/src/broadcast/rule-engine.ts` — runtime: tick handler,
  slot allocation, weight math, scheduler integration
- `controller/src/broadcast/rule-weights.ts` — pure math, unit-testable
- `web/app/admin/rules/page.tsx` — rules list
- `web/components/admin/rules/RuleEditor.tsx` — form
- `web/components/admin/rules/RulePreview.tsx` — test results
- `docs/selection-rules-plan.md` — this doc

Modified:

- `controller/src/settings.ts` — `rules` field, validation, persistence
  side-effects (writing per-slot m3u + ratio files)
- `controller/src/music/picker.ts` — exclude filter in `buildCandidates`
- `controller/src/llm/tools.ts` — exclude args threaded through
- `controller/src/broadcast/queue.ts` — `injectRule()`, new log channel
- `controller/src/broadcast/scheduler.ts` — call `rule-engine.tick()`
- `controller/src/server.ts` — mount rules router
- `liquidsoap/radio.liq` — 6 rule slots wired into the rotate chain
- `web/components/admin/AdminNav.tsx` — add "Rules" entry

## Testing

- **Unit (controller, vitest)**
  - `rule-weights.ts` — given `{jingleRatio: 30, rules: [...]}`, expected
    Liquidsoap weights. Cover: zero rules, one rule, six rules, weight
    rounding, ratio=0 edge cases.
  - `picker.ts buildCandidates` — exclude filters drop the right tracks
    from each of the 7 candidate sources.
  - `rule-engine.ts tick()` — minute-counted rules fire at the right
    minute, jitter math stays inside bounds, multiple-due rules sort by
    weight.
- **Integration (manual on the dev stack)**
  - Track-counted rule with cadence 5 → actually fires every ~5 tracks
    across a 30-track session.
  - Minute-counted rule with cadence 10min → fires within ±jitter%.
  - Exclude rule on a genre that 30% of the library carries — pool
    builds correctly, no broken queues.
  - Exclude rule that hits all candidates — gracefully empty queue,
    Liquidsoap falls back to its `emergency` source.
- **No tests around Liquidsoap itself** beyond a smoke listen — same
  posture as the existing crossfade/ducking code.

## Migration & rollout

`settings.rules` defaults to `[]` on first load. Existing operators see
no change in behaviour until they create a rule.

`jingleRatio` stays in settings as-is. We don't migrate it into a rule
because (a) it predates this surface and works fine, (b) it has its own
admin control already, (c) it would complicate the slot-allocation math.
A future cleanup could fold it in but isn't required.

For the production deploy: the Liquidsoap change adds 6 inert playlist
sources, which means broadcast container needs a rebuild + recreate
(`docker compose up -d --build broadcast`). Document this in the
release notes alongside the controller/web rebuilds.

## Out of scope (v1)

- Per-show rules (rules are station-wide; shows still pick their own
  music inside their schedule)
- Conditional rules (day/time/listener-count gates)
- Folder-path sources (operators use playlists)
- Rule-driven exclusions of *currently-playing* tracks (skip is
  intentionally not supported by SUB/WAVE — track-end is the only
  transition)
- Multi-listener / per-listener exclusions
- Operator-side analytics ("how often did each rule fire") — `/debug`
  log entries are enough for v1; a real dashboard can come later

## Open questions for you

1. **Slot cap of 6** — is that enough, or do you want a bigger number
   pre-baked into `radio.liq`? Going wider is free at parse time but
   muddies the operator UX ("which slot does this rule live in?").
2. **`every-n-minutes` jitter default** — I'd default to `±10%`. Yes
   to default-on, or only when the operator explicitly sets it?
3. **DJ behaviour: `announce` template** — should the announce text be
   operator-authored per-rule ("Time for the sponsor break") or
   generated by the DJ persona on the fly with a hint ("introduce a
   sponsor segment")? I lean operator-authored for v1 since these are
   typically scripted moments; persona-generated is harder to control.
4. **Discussion reply** — do you want me to post a summary on #172
   now (pointing corvock at this plan + the Navidrome library-split
   workaround), or wait until the feature ships?
