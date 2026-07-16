# Beds — instrumental bed under the DJ's between-track link

**Date:** 2026-07-16
**Origin:** Discord #suggestions, "Whacky idea: Beds" (K8-Bit [SBL], skinny_dennis, Jaz666)

## Problem

Today every between-track link is talked **over the incoming song**. The DJ's
script is attached to the next track's queue item (`dj-agent.ts:498-530`,
`introKind: 'link'`) and aired at that track's start (`queue.airIntro`), riding
the light duck (`intro.txt` → `intro_queue`, `smooth_add p=0.40`). The song
plays at ~40% for the length of the script.

The consequence is a **tax on talk**: every second of DJ content costs a second
of the song it is introducing. skinny_dennis states the cost directly:

> "I'd be more inclined to work on skills with interesting content if it didn't
> mean that the DJ would talk over a big chunk of the music they are talking
> about."

That tax is rising. Skills, programmes and banter exchanges all add talk, so the
recent roadmap keeps making links more expensive. A bed decouples talk length
from music sacrificed.

## Goal

When the DJ's link would outlast the incoming song's ramp, play an instrumental
bed between the two songs, talk over the bed, and ramp the next song in under
the DJ's closing words:

```
Song A ──cross──▶ bed (DJ talks) ──ramp──▶ Song B
```

Opt-in, operator-tunable, and a no-op on installs that don't enable it.

## Approaches considered

1. **Bed inside the `dj_transition` cross callback.** Rejected. `cross` sizes
   one buffer `d` and the transition builds `fade.out(d, a) + fade.in(d, b)`
   (`radio.liq:272-290`) — the incoming track fades in across the **whole**
   canvas. A 15s bed means Song B is buried under bed+voice for 15s, which is a
   worse version of the problem the feature exists to fix. The cross buffer
   structurally couples bed length to Song B's fade-in.

2. **Loop Song A's outro as the bed** (floated first, withdrawn on inspection).
   The exit-loop effect (`radio.liq:762-847`) is a comb cascade built *inside*
   the same cross callback, so it inherits flaw (1) exactly — the loop and Song
   B's fade-in share the canvas. A true version would mean pre-rendering Song
   A's tail into a loop file and pushing it as a track, which is real work,
   fragile (needs beat phase, which the analyzer does not provide — `radio.liq:785`),
   and fails outright on `ending: 'cold'` (no tail to ride) and on vocal outros
   (moves the trampling rather than removing it). Not v1; possibly never.

3. **Bed as a cue-trimmed track in `dj_queue`** (chosen). The music must
   actually stop for the bed to exist, and only the music chain can do that. A
   bed is therefore just a track. Every mechanism needed already ships:
   - `cue_cut(music)` is already applied (`radio.liq:238`) and the controller
     already stamps `liq_cue_out` for the max-track-length cap
     (`queue.ts:980`, `subsonic.ts:734`) — so a bed can be trimmed to any length.
   - `liq_cross_duration` is already stamped per-track and already sizes that
     track's **own** exit crossfade (`subsonic.ts:754`, `radio.liq:285`) — so
     the ramp into Song B is a parameter.
   - The link's WAV is rendered at `queue.ts:947` **before** the track URI is
     written at `queue.ts:982`, and `wavDurationMs()` (`queue.ts:1939`) reads
     its exact length from the WAV header. **The bed's length is arithmetic on
     a number the controller already holds at the moment it decides.**

   Jaz666's "fundamental change to the mixer" does not hold. The mixer needs
   ~10 lines. The work is in the controller.

## Design

### 1. The bed is a track

At drain time, when a bed is wanted, the controller writes **two** handoffs
instead of one: the bed URI, then the track URI. `dj_queue` is FIFO and
`fallback(track_sensitive=true, [dj_queue, auto_playlist])` (`radio.liq:215-219`)
always prefers `dj_queue` when it has content, so nothing interleaves.

Bed URI shape — no title/artist, plus a kind marker:

```
annotate:subwave_kind="bed",liq_cue_out="14.2",liq_cross_duration="6":/var/sub-wave/beds/warm-pad.mp3
```

Arbitrary annotate fields reach `on_metadata` (`subsonic_id` already does —
`radio.liq:1348`), so `subwave_kind` is readable in the hook.

Beds live under `state/beds/` — on the shared `/var/sub-wave` mount, so the
broadcast container can open the path the controller wrote.

### 2. Timing math

Reuse `speechDurationMs(wavPath, text)` (`queue.ts:1923`), which already folds
in `VOICE_LEADIN_MS` (800) + `VOICE_TAIL_MS` (700).

```
bedSec = BED_HEAD_SEC + voiceSec + BED_TAIL_SEC
```

- `BED_HEAD_SEC = 2.5` — bed alone before the voice lands. This is **latency,
  not a setting**: the voice fires when the controller sees the bed start (up to
  1.5s watcher tick) and Liquidsoap polls `intro.txt` (up to 0.5s). 2.5s covers
  the worst case. If the voice lands late anyway, the tail spills into Song B —
  i.e. it degrades to exactly today's behaviour.
- `BED_TAIL_SEC = 2.0` — bed+Song B blend after the DJ stops.

The bed's own `liq_cross_duration` (default 6s) means Song B begins fading in at
`bedSec - 6`, which lands **~4s before the DJ finishes** — the ramp. That is
skinny_dennis's "chatter with Song" stage, and it is a parameter, not an
architecture.

Guard: the ramp must not start before the bed does. `bedSec - crossSec` reduces
to `voiceSec - 1.5`, so `crossSec` is clamped to `min(crossSec, bedSec - 1)` —
only reachable if a bed ever fires on a sub-2s script, which the trigger
prevents, but the clamp keeps the arithmetic total rather than relying on the
policy to stay honest.

The cross **into** the bed is governed by Song A's existing ending-aware exit
canvas (`applyMixTransition` → `mix.endingCrossSecondsFor`) and needs no change.

Bed files must be longer than the longest link. Candidates shorter than `bedSec`
are filtered out of the pool; empty pool → no bed → today's behaviour. **Because
beds are only ever cut shorter, no looping is needed** — a 60s file covers
everything.

### 3. Trigger policy

A pure function, `bedWanted(voiceMs, rampBudgetMs, opts)`, in a new
`broadcast/bed-policy.ts` — policy separate from mechanism, mirroring
`broadcast/dj-budget.ts`, and pinned by a test script like
`scripts/programme.test.ts`.

`rampBudgetMs(track)` reads the **three-state** vocal semantics already encoded
at `library-db.ts:252`:

| `vocal_ranges_json` | meaning | ramp budget |
|---|---|---|
| non-empty | vocals — `intro_ms` **is** the vocal onset (`analyze_worker.py:862-869`) | `introMs` |
| `'[]'` | instrumental — nothing to trample | `Infinity` → never bed |
| `null` | not computed | `null` → fall back to threshold |

Then:

- ramp budget known → bed iff `voiceMs > rampBudget`
- ramp budget unknown → bed iff `voiceMs > thresholdSec` (default 12s)

**Explicitly not** `intro_ms` on its own. skinny_dennis's refinement ("TTS.wav >
scanned Vocal Inactivity") is the right instinct against the wrong column. On a
default install `intro_ms` is a pure energy heuristic whose own docstring says
*"NOT true vocal-onset detection... a soft budget, never a gate"*
(`analyze_worker.py:186-208`) — vocal onset needs the heavy analyzer image plus
`ANALYZE_VOCAL_ACTIVITY=1`, which defaults empty (`docker-compose.yml:347`).
Worse, for this purpose the heuristic measures the wrong thing: a track opening
full-band with vocals at 0:15 reads `intro_ms ≈ 0`, firing a bed exactly where
the ramp is longest. Hence: threshold by default, vocal onset as an automatic
upgrade wherever the data exists.

### 4. The one mixer change

`on_meta` (`radio.liq:1343`) currently gates on `title != "" or artist != ""`.
A bed carries neither, so it would silently write nothing — and the controller
would never learn the bed started, so the DJ would never talk. Branch **before**
the title gate, mirroring the `jingle-playing.json` precedent (#997,
`radio.liq:985-994`):

```liquidsoap
if m["subwave_kind"] == "bed" then
  file.write(atomic=true,
    data=json.stringify(compact=true, {filename = m["filename"], startedAt = time()}),
    "/var/sub-wave/bed-playing.json")
else
  # ...existing now-playing.json + ICY insert_metadata...
end
```

The bed therefore never touches `now-playing.json` and never pushes ICY
metadata. That is the whole mixer diff.

### 5. Firing the link on the bed

`startWatcher`'s 1.5s tick (`queue.ts:1655-1667`) also reads
`bed-playing.json`. On a **new** `startedAt` (dedupe on the value, as
`onTrackStarted` dedupes on track key), fire `airIntro()` for the first
`sent && bedded && !introAired` item.

Unlike `waitForJingleClear`'s on-demand deadline computation
(`queue.ts:1893-1911`), this genuinely needs to be an event — hence a read on
the existing tick rather than a new poller.

Song B's own `onTrackStarted` must not re-fire the link: `airIntro` already sets
`introAired = true` before any await (`queue.ts:1125-1126`), so the
fire-and-forget double-call is idempotent by construction. No change needed.

### 6. Settings

Follows the `sfx` three-touch-point pattern in `settings.ts` (DEFAULTS 1444,
normalize 2248, patch 3654):

```ts
beds: {
  enabled: false,      // opt-in
  thresholdSec: 12,    // used only when vocal onset is unknown
  crossSec: 6,         // ramp into the next song
}
```

**No `liquidsoap_*.txt` file, therefore no mixer restart to toggle.** The
controller decides everything; the `on_meta` branch is unconditional and
harmless when no bed is ever pushed. This is a real property worth preserving —
contrast `jingleRatio`, which costs a restart.

Default **off**, matching the Opus/FLAC/AAC opt-in pattern and respecting the
taste risk below.

### 7. Bed library and admin UI

`broadcast/beds.ts` mirrors `broadcast/sfx.ts`: `state/beds.json` maps
`name → {name, description, file, durationSec, builtin, source}`, files under
`state/beds/`, `probeDurationSec` on upload (`sfx.ts:200`), transcode to mp3
when ffmpeg is present.

Selection: random from enabled beds long enough for `bedSec`, avoiding the
last-used one (the `getRecentOpeners()` anti-repeat spirit).

`web/components/admin/settings/BedsSection.tsx` clones `SfxSection.tsx` — list +
audio preview + delete (guard `builtin`) + upload — wired into
`SettingsPanel.tsx:577`. **No generate panel**: beds can't be TTS-rendered.

### 8. Curation over key-matching

A bed in C ramping into a song in F# sounds wrong. The analyzer has key, so
Camelot-adjacency selection is *possible* — and is **YAGNI for v1**. The cheap
robust fix is curation: ship beds that are drones and textures with no strong
tonic, and the clash disappears. Documented as a rule for the shipped set, not
as code.

## Scope

**In:** between-track links only (`introKind === 'link'`). Highest frequency,
it's the thread's actual complaint, and links already ride the light duck so no
routing change is needed.

**Out (documented follow-ups):**
- **Request intros** (`introKind: 'dj-speak'`, `dj-agent.ts:1061`) are also
  pre-rendered and boundary-attached, so they're nearly free to bed later — but
  they ride the **heavy** duck by design. A bedded segment must always use the
  light duck (the bed is meant to be heard under the voice), so this needs
  `airIntro`'s `kind === 'link' ? introFile : sayFile` (`queue.ts:1141-1143`) to
  become bed-aware. Deliberately deferred to keep v1 off the heavy-duck contract.
- **Programme features and banter exchanges** — the longest segments, the best
  eventual case for beds, but they fire mid-track via `announce()`, not at a
  boundary. Bedding them means stopping a song mid-play. Separate design.

## Files

| File | Change |
|---|---|
| `liquidsoap/radio.liq` | `on_meta` `subwave_kind` branch (~10 lines) |
| `controller/src/broadcast/bed-policy.ts` | **new** — pure `bedWanted`, `bedLengthFor`, `rampBudgetMs` |
| `controller/src/broadcast/beds.ts` | **new** — library, mirrors `sfx.ts` |
| `controller/src/routes/beds.ts` | **new** — list/upload/delete/preview |
| `controller/scripts/bed-policy.test.ts` | **new** — pins the pure functions |
| `controller/src/broadcast/queue.ts` | drain-time bed push; `bed-playing.json` read on the tick; `bedded` flag |
| `controller/src/music/subsonic.ts` | export `escAnnotate` for the bed URI builder |
| `controller/src/settings.ts` | `beds` block (3 touch points) |
| `controller/src/config.ts` | `bedPlayingFile`, `bedsDir` |
| `controller/src/server.ts` | mount route; scaffold default beds on first boot |
| `web/components/admin/settings/BedsSection.tsx` | **new** |
| `web/components/admin/SettingsPanel.tsx` | wire the section |
| `sounds/beds/` | 2–3 shipped CC0 beds, scaffold-copied to `state/beds/` |

## Testing

No test runner; follow the house pattern.

- `bed-policy.ts` is pure → `controller/scripts/bed-policy.test.ts`, run like
  `npm run test:llm` / `scripts/programme.test.ts`. Cover: all three vocal
  states, threshold fallback, `bedSec` math, pool filtering when every bed is
  too short.
- `npm run lint` in `controller/` and `web/` — the merge gate.
- Audio verification via the broadcast image as a `radio.liq` harness (use
  `--entrypoint`; the image's entrypoint ignores cmd args and boots a full
  station).
- Manual: enable beds, force a long link, confirm bed → ramp → song, and confirm
  `now-playing.json` never shows the bed.

## Risks

1. **Taste, not feasibility.** `radio.liq:1193` has `bed_enabled = false` —
   *"the looping ambient bed was audible/annoying under the DJ's voice during
   links."* A bed under voice has already been tried and disliked. That was a
   *different* thing (a continuous drone at weight 0.02 ducked along with the
   music, not a bed replacing the music for one link), so the failure doesn't
   transfer — but it is a warning. **If every link gets a bed, this is morning-zoo
   radio.** The trigger rule matters more than the mechanism; hence default-off
   and a 12s threshold rather than 5s.

2. **Auto-playlist interleave (accepted).** Bed and track are two sequential
   `writeHandoff` calls, each waiting up to ~1s for Liquidsoap's 1.0s poll. If
   `dj_queue` drained empty in that window, `fallback` would pull one full
   auto-playlist track *between* the bed and the intended track. In practice the
   picker is gated on `upcoming.length === 0` (`queue.ts:1383`) and fires at Song
   A's *start*, so both pushes land minutes before the boundary. This widens an
   existing window by ~1s and the existing `_emptyDjQueueStreak` /
   `reconcileWithDjQueue` machinery (`queue.ts:1252-1278`) already surfaces the
   desync class. Accepted; revisit only if observed.

3. **Now-playing shows Song A during the bed (cosmetic).** Since `on_meta`
   skips the bed, the UI holds the previous song. Arguably correct — Song A was
   the last real song — but the platter/tonearm skin (#1070) rides track
   progress and will run its arm past the end. v1 accepts this; a "DJ talking"
   station state is a follow-up, not a blocker.

## Open decision

**Where the shipped beds come from.** They can't be TTS-generated. Options: 2–3
CC0 ambient files committed to `sounds/beds/`; or generate purpose-made neutral
pads offline (an ElevenLabs music model) and commit those. Recommend the latter
— purpose-made tonally-neutral pads sized ≥60s, which sidesteps both the licence
question and the key-clash problem in one move. `sounds/bed.mp3` already exists
but is the asset that got the studio bed disabled; do not reuse it.
