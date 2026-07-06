# Programmes — produced show episodes

**Date:** 2026-07-06
**Status:** Draft — awaiting operator review

## What this is

Today a scheduled show is a *filter + vibe*: it pins a persona, steers the
music (mood/genre/era/energy/playlists), and its `topic` brief leans the picker
and the between-track patter. But nothing marks the show as an **event**. There
is no opening, no deliberately placed feature, no sign-off — the hour sounds
like the autonomous station wearing a costume.

A **programme** is a show the AI DJ *produces* as a coherent episode:

```
intro → music block → feature segment → music block → outro
```

Think: a morning news roundup, a weekly themed music focus ("focus on French
chanson this week"), a Friday evening wind-down — each driven by the show's
topic brief, with guest co-hosts woven in where the show has them.

## Approaches considered

**A. Operator-authored rundown** — `shows[].rundown` as an ordered slot list
(`intro`, `music ×3`, `segment(news)`, …). Maximum control, but it needs a new
rundown editor in the admin UI, and "3 tracks then talk" is fragile against
the track-end-only transition model (crossfades, requests, and track lengths
make counts drift). Heavy config surface for v1.

**B. Fixed canonical arc + per-episode plan** *(chosen)* — one `programme`
toggle on the show. The structure is canonical and **time-based** (derived
from the show's scheduled span): intro at the top, one feature beat mid-hour,
outro in the final minutes. At session start a single structured "producer"
LLM call turns the topic brief + the moment (date, weather, festival, guests)
into an **episode plan** — today's angle, what the intro teases, what each
feature covers, how the outro wraps. Every beat's script references the plan,
which is what makes the hour *coherent* rather than three unrelated talk
breaks. Weekly variation comes free: each episode gets a fresh plan from the
same brief.

**C. Milestone beats, no plan** — add intro/feature/outro beats that each
independently read the raw topic brief. Cheapest, but each beat is generated
blind: the intro can't tease the feature, the outro can't call back. Kept as
the **degrade path** when the producer call fails, not as the design.

## Design (Option B)

### Settings schema

Two additions to the show object (`settings.ts` → `validateShowsStrict`):

- `shows[].programme: boolean` — default `false`. Opt-in, like `banter`.
- `shows[].segmentSkill: string` — optional; pins the feature beat to one
  segment capability kind (e.g. `news` for a morning roundup, `web-search`
  for an artist-focus show). Empty = the plan/director chooses freely from
  the brief. Shape-checked only (≤64 chars); resolved against the live skill
  catalog at run time so a stale/misspelled kind degrades to "director's
  choice" instead of erroring (same tolerance as `playlistIds`).

No schedule-grid changes — the existing 7×24 grid already gives the show's
span (consecutive hours of the same id), which is all the arc needs.

### The episode runner — `broadcast/programme.ts` (new)

A small module owning plan generation and beat firing. **All episode state
lives on the session object** (`session.programme = { plan, beats }`,
via new `session.ts` accessors mirroring `handoffAired`): it persists across
controller restarts, dies at the show boundary with the session, and a
non-contiguous schedule (same show at 08:00 and 20:00) naturally gets two
sessions → two independent episodes.

**`ensurePlan(ctx)`** — called when a programme show's session starts (same
call sites that drive `runPersonaHandoff`: the hourly roll at :00 and the
first track event past a boundary). One `djObject` call (Zod-validated):

```
in:  topic brief, show name, span hours, host + guests, date/weather/festival,
     pinned segmentSkill (if any), previous episode's angle (if archived)
out: { angle,                     // today's editorial line, ≤200 chars
       introNote,                 // what the opening establishes/teases
       features: [{ topic }],     // one per scheduled hour
       outroNote }                // how the sign-off wraps / calls back
```

On failure (LLM down, hard budget): mark the plan `fallback` — beats still
air, each generated from the raw brief (approach C as the floor). The plan is
one extra LLM call **per episode**, not per beat.

### Beats

| Beat | When | How it airs |
|---|---|---|
| **Intro** | Show's first hour, at :00 | Replaces the generic hourly time-check for that hour (avoids the issue-#310 stack at minute 0). If a persona handoff is pending, the intro **is** the incoming half of the mic-pass — the handoff prompt already carries a "you're kicking off <show>" clause; it gains the episode angle. Solo persona-stable starts air a standalone intro via `queue.announce`. |
| **Feature** | Each hour at :35 (a new cron slot no other talker owns) | Runs **through the segment director** (`forcedDirectorAgent` path): the plan's feature topic is injected as the brief, and the pinned `segmentSkill` (when set) forces that capability — so a news roundup gets real headlines through the existing news/feed/web-search data tools, not hallucinated ones. |
| **Outro** | Final hour at :55 | Standalone sign-off referencing the plan (callback to the feature, optionally teasing the next scheduled show). Airs via `queue.announce`; sets the talk-break clock so banter/segments keep their distance. |

Beat firing is driven by minute-of-hour + minutes-into-show/span — pure,
unit-testable due-ness helpers (`scripts/` test style, like `auto-pool`).
Each beat is marked `aired` on the persisted session **before** generation
(the `markHandoffAired` pattern), so a restart or mid-beat failure can't
double-air.

**Guests:** when the show has co-hosts, intro and outro become short
multi-voice exchanges (a `generateBanter`-shaped structured call, aired
all-or-nothing via `queue.announceExchange`). The feature beat's speaker
rotates via `settings.pickOnAirSpeaker()` — the existing rule that standalone
segments rotate while picks stay with the host. Banter at :20/:50 continues
unchanged.

### Collision policy while a programme is on air

- The generic **segment tick stands down** for hours that have a planned
  feature beat — the episode owns its talk moments; no competing
  weather/news spots landing at :25 next to the feature at :35.
- **Station idents** keep firing (:15/:45 per frequency) — short, brand-level,
  and they don't fight the arc. Aggressive's :30 slot is 5 min clear of :35.
- **Hourly check** is replaced by the intro in hour one, normal afterwards.
- All beats respect the existing gates: `djCallsAllowed()` (nobody listening →
  silence, music coasts) and `optionalSegmentsAllowed()` (soft budget mutes
  them, hard budget also skips the producer call). Manual triggers bypass
  gates as everywhere else.

### Prompts — `llm/internal/prompts/programme.ts` (new)

- **Producer plan** (system + Zod schema above). Concrete, brief-grounded:
  "name the angle, the feature topic per hour, what the intro promises."
- **Intro / outro scripts** — free-text `djText` calls shaped like
  `generateStationId` (persona soul, opener anti-repeat via
  `queue.getRecentOpeners()`, recap, context lines) plus the plan excerpt.
- The feature beat needs **no new script prompt** — the segment director's
  existing prompt does the talking; it just receives the plan topic (and the
  forced capability) instead of free choice.

The picker needs no change: the show brief already flows into it
(`prompts/picker.ts` show line), and the session context line ("On now: …
stay loosely on its theme") already covers links. Optionally the plan's
`angle` is appended to that context line — one-line change in
`prompts/context.ts` — so mid-show links breathe the same episode.

### Surfaces

- **Admin shows editor** (`/admin/settings` shows section): "Programme"
  toggle + a segment-skill dropdown populated from `skillCatalog()`. Two
  small controls in the existing show form — no new page.
- **Manual overrides**: the `/dj/segment` command route gains
  `programme-intro` / `programme-feature` / `programme-outro`, wired to
  gate-free runners (operator button always fires, consistent with
  `runStationId` / `runBanter`).
- **Debug**: `/debug` exposes the live episode plan (the operator can see
  what the producer decided). No web-player changes in v1.

### Failure modes

| Failure | Behaviour |
|---|---|
| Producer call fails / hard budget | Plan marked `fallback`; beats generate from the raw brief (approach C floor). |
| A beat's LLM/TTS call fails | Beat already marked aired → logged, skipped; music never stops. TTS engine failures use the existing piper fallback chain. |
| Controller restart mid-episode | Session recovery restores plan + beat flags; nothing re-airs. |
| `segmentSkill` names an unknown kind | Director's-choice fallback, logged. |
| Show scheduled a single hour | Intro (:00), feature (:35), outro (:55) all land in that hour — the exact structure requested. |

### Example configurations

- **Morning news roundup** — show 07:00–09:00 weekdays, `programme: true`,
  `segmentSkill: news`, topic: "brisk breakfast show; headlines with a light
  touch; upbeat music". Intro at 07:00, headline features 07:35 + 08:35,
  sign-off 08:55.
- **Weekly themed music focus** — Sunday 20:00–22:00, `programme: true`,
  topic: "focus on French chanson this week — Piaf to Christine and the
  Queens", genre lean set on the show. The producer picks tonight's angle;
  features dig into the theme via web-search.
- **Friday wind-down** — Friday 21:00–23:00, `programme: true`, energy `low`,
  guests + banter on. Intro/outro as two-voice exchanges; mellow features.

### Out of scope (v1)

- Operator-authored rundowns (approach A) — revisit if the canonical arc
  proves too rigid.
- Episode-to-episode memory beyond the previous angle (a full "last week we
  covered X" thread needs archived-session mining — natural v2).
- Web/native player "programme" badges or episode pages.
- Any Liquidsoap change — the arc is entirely controller-side talk placement.

### Testing

- Pure due-ness helpers (beat scheduling from minute/span/flags) + the plan
  Zod schema: unit tests alongside the existing `scripts/*.test.ts` seams.
- `npm run lint` in `controller/` and `web/` as the merge gate (no test
  runner in this repo).
- Manual: dev stack, schedule a programme show over the current hour, watch
  `queue.log` + `/admin/debug` for plan + beats; force beats via the new
  `/dj/segment` commands.
