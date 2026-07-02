# DJ transition effects rework — make sweep + washout feel like a real DJ

**Date:** 2026-07-02
**Branch:** `feat/dj-transition-fx-rework` (on top of PR #606, `feat/dj-transition-sweep`)
**Status:** design approved pending user review

## Problem

PR #606 adds two DJ-mode transition effects (filter **sweep**, echo **washout**).
They work, but they don't sound like a DJ's hands on the desk. Confirmed
symptoms from on-air listening:

1. **Sweep feels abrupt/backwards** — the muffle slams in over 0.5 s right at
   the song change instead of building slowly over the end of the outgoing
   track.
2. **New track starts muffled** — the incoming track spends its first ~5 s
   under the lowpass (the envelope's 5 s release) instead of landing clean.
3. **Washout is echo-on-top, not a dissolve** — the outgoing track keeps
   playing at full level with echo layered over it; the incoming track's
   opening also picks up baked-in echo.
4. **Effects fire at wrong moments** — the LLM's choice isn't validated
   against what the two tracks actually are, and the envelope lengths are
   hardcoded seconds with no relation to the music's tempo or the blend
   length.

## Root cause

Both effects sit on the wrong signal path:

- The sweep `filter.rc` pair is on the **whole mix after `cross`** — it can
  only shape the sum, so any muffle at the transition necessarily muffles the
  incoming track too, and the gesture can't start before the cross begins.
- The washout `comb` is on the **whole music bus before `cross`** — during the
  cross's buffer fill the incoming track's opening passes through the swollen
  feedback, so echo gets baked into the new track; meanwhile the outgoing
  track's dry level is untouched (its fade is downstream), so the wash reads
  as an overlay, not a dissolve.

A real DJ's filter/echo ride **only the outgoing channel**, build over bars,
and the incoming track lands clean. `dj_transition(a, b)` receives both
branches separately — the effects belong inside it, on `a.source`.

## Goals

- Sweep: the outgoing track sinks under a slowly closing lowpass across a
  long, bar-snapped blend; the incoming track rises clean and dry underneath.
  No muffle on the incoming track, ever.
- Washout: the outgoing track's dry signal falls away early while a
  tempo-synced echo tail self-sustains and decays across the blend into the
  incoming track.
- Lengths are musical: envelopes are sized to the transition window
  (fractions of `d`), not hardcoded seconds; the washout additionally gets a
  longer crossfade canvas snapped to whole bars of its track's BPM (the sweep
  cannot — see "cross-duration physics" below).
- Firing is justified: the LLM proposes, the data disposes — the queue
  validates the flag against analyzer BPM/key contrast and a
  frequency-ladder cooldown, stripping flags that don't earn the moment
  (mirroring the existing transition-SFX gate).

## Non-goals

- No new admin settings or toggles (effects stay gated purely on persona
  `djMode` via `settings.effectsActive()`, as in the PR).
- No voice FX (dropped in the PR, stays dropped).
- No true stereo ping-pong (native `echo` is a verified no-op in this build;
  the tail stays a centred `comb`).
- No runtime beat-grid quantisation of the *trigger* (we snap the blend length
  to bars, not the moment the cross starts).

## Approach

**A (primary): per-branch effects inside `dj_transition`.** Apply
`filter.rc` / `comb` to the outgoing `a.source` only, inside the transition
callback. The historical "Early computation of source content-type" crash was
observed with `iir_filter` / HPF on a `request.queue`-backed source; whether
`filter.rc` and `comb` share that failure is **unproven either way** — so the
first implementation step is a 5-minute harness probe against the real
`savonet/liquidsoap:v2.2.5` image (Phase 0 below). If they instantiate
cleanly:

- The whole global state machinery dies: pre-cross `comb`, post-cross
  `filter.rc` pair, `washout_watch` thread, `washout_armed`, the `on_meta`
  arming line. Timing becomes trivial — the effect fires exactly when the
  transition airs, on exactly the branch it should shape.
- The comb delay becomes **tempo-syncable per transition**: it's instantiated
  fresh inside each callback, so a fixed-at-instantiation param can come from
  track metadata.
- Both effects become race-free by construction: the sweep flag rides the
  incoming pick's own annotation (read from `b.metadata`), the washout flag
  rides the ending track's own annotation (read from `a.metadata`). A listener
  request jumping the queue can no longer land an armed effect on the wrong
  transition.

**B (fallback, only if the Phase-0 probe fails):** keep the PR's global-bus
placement but re-time the envelopes — sweep closes over the first ~60% of a
lengthened cross and snaps open in ~1 s (incoming muffled only briefly);
washout adds an input-duck so the delay line self-oscillates as a decaying
tail. Documented here so the fallback is a re-tune, not a redesign; the
controller-side changes are identical in both.

**C (rejected):** controller-driven envelope automation over telnet — breaks
the file-IPC architecture for zero audible gain.

## Cross-duration physics (constrains the whole design)

`liq_cross_duration` stamped on a track governs the crossfade at that track's
**own end**: `cross` sizes its buffer from the *outgoing* track's override,
and `dj_transition` reads `a.metadata` for the fades to keep fade == buffer
(the invariant documented in radio.liq). Therefore:

- **Washout is physics-aligned by luck of its semantics.** The flag rides the
  track that ends, so its canvas (long `crossSec`), tempo delay
  (`washoutDelay`), and the `liq_washout` flag itself can all be stamped on
  that same track at enqueue time and they govern exactly the transition the
  wash fires on.
- **Sweep cannot receive a stamped canvas.** The transition INTO the flagged
  pick is sized by the *previous* track's stamp, already sent to Liquidsoap
  when the pick happens. The sweep therefore scales its envelope to whatever
  `d` the transition gets (clash-y pairs tend to earn long adaptive blends
  anyway, and the audible floor is `CROSS_MIN_SECONDS = 6` — a `0.7·d` close
  is ≥ 4 s, against the PR's 0.5 s).
- **Found during design, CONFIRMED empirically — off-by-one in shipped
  feature 1** (develop, predates PR #606): `applyMixTransition` computes
  `crossSecondsFor(prev, item)` — including the cap to *item's* intro — but
  stamps the result on `item`, whose stamp physically governs the item→*next*
  transition, not prev→item. Verified with the harness (`xdur.liq` render): a
  track stamped `liq_cross_duration=12` against a cross default of 4 produced
  a 12 s buffer **at its own end** (output duration 78 s = 50 − 12 + 40, and
  the callback logged d=12 for a→b, d=4 for the unstamped b). Filed as a
  separate issue, not fixed in this branch (the correct fix needs a different
  signalling channel, since the pair (item, next) isn't known when `item` is
  annotated). The same render is what proves the washout canvas stamp lands on
  exactly the right transition.

## Design — Liquidsoap (`liquidsoap/radio.liq`)

### Sweep (filter-out on the outgoing track)

- **Trigger:** `b.metadata["liq_sweep"] == "true"` in `dj_transition` (the
  flag stays on the incoming pick — "sweep INTO my pick" — but the filter is
  applied to the *outgoing* branch).
- **Chain:** `a_source = filter.rc(frequency={sweep_cutoff()}, mode="low",
  wetness=1., filter.rc(... , fade.out(duration=d, initial_metadata=a.metadata,
  a.source)))` — the same 2-stage `filter.rc` as the PR, but per-transition on
  the `a` branch and at fixed `wetness=1.0`. The PR's `max_wet=0.5` (half the
  dry always passing) is what made the muffle sound half-hearted; at a 9 kHz
  open cutoff, wet=1 is still near-transparent at idle, so the cutoff does all
  the work.
- **Envelope** (implemented as a pure closure of `source.elapsed()` on the
  transition branch — see "Envelopes are audio-time closures" below):
  - Close over `T_close = 0.7·d` with a smoothstep ease
    (`depth = 3x² − 2x³`, x = e/T_close) — no audible corner at the start.
  - Cutoff mapped **exponentially** (log-frequency space):
    `cut = open · (floor/open)^depth`, `open = 9000` (stability cap stays),
    `floor = 400`. Linear cutoff ramps sound like nothing-then-everything;
    log-space is how a filter knob actually feels.
  - After `T_close`: hold at the floor while the fade finishes. **No release
    phase** — the outgoing branch ends with the cross; there is nothing to
    reopen. (This is what kills symptom 2: the incoming branch never passes
    through the filter.)
- **Deleted:** the post-cross `filter.rc` pair on the music bus, `sweep_wet`
  (wetness is fixed inside the branch). The jingle caveat (a jingle airing
  inside a ramp gets swept) disappears — the effect exists only on the
  transition branch.

### Washout (dub tail on the outgoing track)

- **Trigger:** `a.metadata["liq_washout"] == "true"` in `dj_transition` — the
  flag is on the track that *ends*, and `a` **is** that track. No
  `remaining()` watcher, no arming, no `on_meta` hook.
- **Chain:** `a_source = comb(delay=wd, feedback={washout_fb()},
  fade.out(duration=d, type="exp", initial_metadata=a.metadata, a.source))`:
  - `wd` = `float_of_string(default=0.30, a.metadata["liq_washout_delay"])` —
    tempo-synced by the controller (below). Fixed at instantiation is fine:
    the comb is built fresh per transition.
  - `type="exp"` on the fade drops the dry signal *early* in the window (an
    early drop sums below unity mid-cross — a dip, which is the dissolve feel;
    the doubling hazard only exists for fades that hold *full level* early).
  - Comb sits **after** the fade, so once the dry input falls away the
    feedback loop self-sustains — the tail keeps pulsing and decaying over the
    incoming track with no dry signal under it. That is the dissolve.
- **Envelope** (same closure pattern):
  - Swell feedback from −90 dB → **−2.5 dB** over the first `0.25·d`
    (smoothstep).
  - Hold to `0.75·d`.
  - Release back to −90 dB by `0.95·d` — the taps must decay ≥ ~30 dB before
    the transition source ends, so the tail never truncates with a click.
- **Deleted:** the pre-cross bus `comb`, `washout_watch`, `washout_armed`, the
  `on_meta` arming line, the fixed `washout_delay` constant.

### Shared: envelopes are audio-time closures (found during implementation)

The spec originally kept the PR's `thread.run.recurrent` envelopes driving
shared refs. Building the render harness exposed why that's wrong: thread
envelopes run in **wall-clock** time while audio can run on any clock — under
`sync="none"` (offline renders) the envelope never moves, and even on-air the
thread quantises to 50 ms steps and can drift. The implementation instead
computes each envelope as a **pure closure of `source.elapsed()`** on the
transition branch, evaluated per frame by the operator's getter:
sample-accurate in audio time, faithful in offline renders, and with **no
shared state at all** — no refs, no `*_firing` guards, no reset logic; the
closure dies with the transition. If both flags coincide on one transition
(washout out of `a`, sweep into `b`), both chains stack on `a.source` —
allowed; the harness renders this combo case.

## Design — Controller

### `music/mix.ts` (pure helpers, unit-tested)

- `washoutCrossSecondsFor(analysis, maxSec)` — the washout's blend canvas,
  stamped on the flagged track itself (governing its own end — see
  cross-duration physics). Target **12 s**, snapped to whole bars of that
  track's BPM when known; clamped to `[8, min(14, maxSec)]` (the admin
  crossfade ceiling still wins, matching `crossSecondsFor`). Unknown BPM →
  fixed 10 s. No incoming-intro cap: the next track isn't known when the
  flagged track is annotated — a tail decaying over the next track's opening
  vocals is an accepted (and DJ-authentic) risk.
- `washoutDelayFor(bpm)` — dotted-eighth of the flagged track:
  `0.75 · 60/bpm`, clamped `[0.18, 0.45]` s; `null`/unknown BPM → `0.30`.
- The sweep gets **no** canvas helper: its envelope scales to the `d` the
  transition already has.
- `effectAllowedFor(kind, cur, next)` — data validation:
  - `sweep`: allowed when `mixCompat(cur, next) < 0.6` — a sweep is the move
    that *hides a seam*; between tempo/key-locked tracks a tight beat-blend is
    better and the sweep reads as gratuitous. Either track un-analysed →
    allow (trust the DJ; the data can't contradict it).
  - `washout`: always allowed (it's an editorial "close the chapter" gesture,
    not a compatibility repair) — the cooldown alone rations it.

### `broadcast/queue.ts` (`applyMixTransition`)

Extend the existing feature-1/2 block — same place, same conventions:

- New counter `_transitionsSinceEffect` with its own ladder
  `effectTransitionGap()`: aggressive → 4, moderate → 8, quiet → 12 (not the
  SFX ladder's `Infinity` — the DJ explicitly chose the effect, so even a
  quiet persona gets one occasionally).
- When `item.track.sweep || item.track.washout` (both are set on the flagged
  pick itself, and everything resolves at that pick's own enqueue —
  cross-duration physics makes this the one place with both the knowledge and
  the authority):
  1. Gate on the cooldown and `effectAllowedFor(...)`. On failure, **strip the
     flag** (`delete track.sweep/washout`) and log
     (`'mix', 'sweep dropped (compat 0.8)'` / `'… (cooldown 3/8)'`) so the
     debug page shows why nothing fired.
  2. On success: reset the counter. For **sweep**: nothing more to stamp (the
     flag alone rides to `b.metadata`; the envelope scales to `d`). For
     **washout**: stamp `track.crossSec = washoutCrossSecondsFor(next-analysis
     of the item itself, maxSec)` — overriding the feature-1 value, since this
     stamp governs the item's own end, exactly where the wash fires — and
     `track.washoutDelay = washoutDelayFor(item's bpm)`.
  3. **Mutual exclusion with SFX risers:** an effect transition skips the
     `transitionSfxFor` check entirely — never a whoosh over a washout.
- Sweep validation pairs `prevTrack` (what's on-air / queued ahead) with the
  flagged item — the same `cur`/`next` resolution the function already does.

### `broadcast/dj-agent.ts`

- Keep `PICK_SCHEMA.transition` exactly as is (no schema churn).
- Rewrite `effectsGuidance()` to describe the *new* feel with concrete
  criteria:
  - `sweep`: "the track you're leaving sinks under a slowly closing filter
    across a long blend while your pick rises clean underneath — choose it for
    a real gear-change: a big jump in energy, tempo, or mood."
  - `washout`: "the track dissolves into a pulsing echo tail that rings out
    across the blend into your pick — choose it to close a chapter: the end of
    a themed run, before a talk break, or out of a dreamy track."
  - Keep "use rarely, at most one in a set"; add "the station may skip the
    effect if the transition doesn't warrant it" so the model isn't confused
    by silently-stripped flags in its session history.

### `music/subsonic.ts` (`getAnnotatedUri`)

- Keep `liq_sweep` / `liq_washout` stamps.
- Add `liq_washout_delay="<seconds, 2dp>"` when `song.washoutDelay` is set.

## Validation harness (`scripts/fx-render-test.sh`)

Checked into the repo — envelope tuning is by-ear work and will recur.

- **Phase 0 — topology probe (decides A vs B):** a minimal `.liq` that builds
  a `cross` whose transition callback instantiates `filter.rc` and `comb` on
  the outgoing branch, over two short WAVs (generated with ffmpeg: a sine
  sweep and shaped noise), rendered via the real `savonet/liquidsoap:v2.2.5`
  image (`--check` first, then an actual render — the PR proved `--check`
  alone lies about runtime behaviour). Pass → Approach A. Fail → Approach B,
  and the probe script stays as the regression record of *why*.
- **Phase 1 — A/B renders:** given two real MP3s, render four WAVs of the
  transition region: dry, sweep, washout, sweep+washout. Print an RMS-over-
  time table per render (ffmpeg `astats` per 0.5 s window) so envelope shape
  is visible in the terminal, and hand the WAVs to the operator to listen.
  Also render a two-transition sequence with distinct `liq_cross_duration`
  stamps per track to confirm the cross-duration physics (and the suspected
  feature-1 off-by-one) empirically.
- **Phase 2 — live:** flag transitions on the dev stack
  (`docker-compose.dev.yml`) and listen on-air; confirm the debug log lines
  (`mix` entries for stamps/strips, liquidsoap logs for envelope fire/skip).

## Testing

- `controller/scripts/mix-fx.test.ts` (tsx, same style as the sibling test
  scripts): pins `washoutCrossSecondsFor` (bar snap, clamps, admin ceiling,
  unknown-BPM fallback), `washoutDelayFor` (clamps, fallback), and
  `effectAllowedFor` (compat gate, un-analysed pass-through).
- `npm run lint` in `controller/` and `web/` (the CI merge gate).
- `liquidsoap --check liquidsoap/radio.liq` against the v2.2.5 image, plus the
  Phase-1 renders above.

## Risks and edge cases

- **`filter.rc`/`comb` may crash inside the callback** → Phase-0 probe first;
  Approach B is a re-tune of the existing topology, not a redesign.
- **Comb build-up:** fb_max −2.5 dB with a long hold stays below unity and the
  brick-wall limiter backs it up; the Phase-1 RMS table verifies no runaway.
- **Tail truncation at window end:** release completes by `0.95·d` by design;
  verified audibly in Phase 1.
- **Request jump-ins:** race-free by construction in Approach A (flags ride
  the tracks' own annotations; there is no armed global state).
- **Un-analysed libraries:** every tempo-derived number has a fixed fallback
  (10 s canvas, 0.30 s delay, validation passes open).
- **Emergency/jingle sources:** effects exist only on music↔music transition
  branches now; the bus is untouched at idle by construction (no idle
  transparency to reason about).

## What gets deleted from PR #606

`radio.liq`: post-cross `filter.rc` pair, pre-cross bus `comb`,
`washout_watch` + its recurrent thread, `washout_armed`, the `on_meta` arming
line, `sweep_wet`, the fixed `washout_delay` constant, and
`start_filter_sweep`/`start_washout` in their current bus-envelope form
(rewritten as per-branch envelopes). Controller code from the PR (schema,
`effectsActive`, annotate stamps, enqueue plumbing) all survives.
