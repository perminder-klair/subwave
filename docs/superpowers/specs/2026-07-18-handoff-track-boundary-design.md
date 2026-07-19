# Show handoffs on the track grid, not the wall clock

**Date:** 2026-07-18
**Source:** Discord — Gurthyy [NSTV] and Jaz666, #suggestions

## Problem

A scheduled show/persona handoff fires at wall-clock `:00` and ducks whatever song
happens to be playing. Two listeners reported it independently:

> "Subwave seems to have a deferred announcement path for station IDs that can wait
> until the next track boundary. Could show/persona handoffs use that same
> behavior? Right now a scheduled handoff can fire at the top of the hour over the
> middle of a song." — Gurthyy

> "There is definitely still room for improvement around handoff time around shows."
> — Jaz666, with a timeline from a live morning → mid-morning changeover:
>
> | time | event |
> |---|---|
> | 09:55:03 | programme-outro called |
> | 09:56:18 | outgoing DJ speaks the outro |
> | 09:57:12 | outgoing `djAgentPick` with link |
> | 09:57:31 | outgoing DJ speaks link |
> | 10:00:06 | `generateProgrammePlan` — outgoing song still playing |
> | 10:01:10 | incoming `djAgentPick` with link |
> | 10:01:20 | link generated for the incoming DJ, **spoken in the outgoing DJ's voice** |

Both observations are correct, and they are two symptoms of one root cause.

### The deferred path Gurthyy describes is real

`queue.announceAtNextTrack()` (`controller/src/broadcast/queue.ts:1081`) renders the
WAV immediately, parks it in a single `_pendingVoice` slot, and airs it from
`onTrackStarted` (`queue.ts:1195`). It has exactly **one** caller — station IDs
(`scheduler.ts:677`). The hourly check, links, banter, programme intro/feature/outro
and the persona handoff all call plain `queue.announce()`, which speaks immediately.

### The handoff has two competing call sites, and the wall-clock one usually wins

`runPersonaHandoff` (`dj-agent.ts:1109`) is reached from two places:

1. **Track-start** — `queue.onTrackStarted`'s auto-pick block (`queue.ts:1393-1411`).
   This one already lands on a boundary, and its comment already states the intent:
   *"air the mic-pass first (sign-off + greeting) so it plays before the incoming
   DJ's first pick."*
2. **The `0 * * * *` cron** — `hourlyCheck()` → `rollSessionNow()` (`scheduler.ts:441`,
   `:464`). This fires at wall-clock `:00`, mid-track.

Whichever call site rolls the session first drives the mic-pass; the other no-ops.
Site 1 calls `session.maybeRoll(ctx)` with `ctx = await getFullContext()` — the
**live** clock. At 09:58 the grid still says "morning show", so no roll happens.
The cron then wins at 10:00, mid-song. **Site 1 can essentially never win**, because
it asks about the present at a moment when the boundary is still in the future.

Meanwhile the *pick* made at 09:58 already looks ahead — `queue.ts:1429-1435`
computes `showAt = now + duration + PICK_SHOW_LOOKAHEAD_SEC` and resolves the
**incoming** show's brief. The existing comment makes the split deliberate:

```ts
// The session roll and handoff above stay on the live clock: only the pick
// looks ahead. Unknown duration → no look-ahead, today's behaviour.
```

That is the bug in one line. The pick is chosen for the new show while the mic-pass
still belongs to the old one, so the changeover track airs *before* anyone has
handed over.

### The voice mismatch is a separate, narrower defect

The persona is never carried on the queued item. `push()` (`queue.ts:495-541`) stores
`introScript` / `introKind` / `introWav` / `linkPrev` but nothing identifying who
wrote the line. So:

- `queue.ts:949` — `speak(item.introScript, { kind: item.introKind })` with no
  `persona`, so `tts.personaFor()` (`audio/tts.ts:51`) falls through to
  `settings.getEffectivePersona()` **at drain time**.
- `queue.ts:1145` — `voiceGainDb(kind)` with no persona, re-resolving **at air time**.
  This is the *only* `voiceGainDb` call site in the codebase that omits the persona;
  `:1015`, `:1049` and `:1108` all pass it.
- `queue.ts:1148` — `session.appendTurn` records no `meta.personaId`, so
  `windowMessages()`' speaker-attribution guard can't tag the turn.

Generation, WAV render, and air each resolve the persona independently. Away from a
boundary they agree by luck. Across one they don't — which is exactly Jaz's 10:01:20.

## Goal

1. The mic-pass airs at a track boundary, immediately **before** the first track of
   the incoming show — never over the middle of a song.
2. The pick's brief and the mic-pass can no longer disagree about which show is on.
3. A spoken line is voiced by the persona that wrote it, decided once.

Explicitly *not* a goal: changing ducking, crossfade, or `radio.liq`. This is a
scheduling and attribution change only.

## Approaches considered

1. **Defer the handoff with `announceAtNextTrack`** — the literal reading of the
   suggestion. Rejected: `_pendingVoice` is a single slot and a handoff is a
   two-part exchange, so it would have to become a FIFO. Worse, it puts the sign-off
   *after* the straddling track — and that track was already picked under the
   incoming show's brief, so the outgoing DJ would wave goodbye after a new-show
   song had already played.

2. **Split the exchange across the straddling track** — sign-off before, greeting
   after (Gurthyy's alternative). The most radio-like, but the exchange stops being
   atomic: two pending slots, two failure modes, and a window where neither DJ
   formally owns the air.

3. **Anticipate the roll using the lookahead the pick already computes** (chosen).
   `queue.onTrackStarted` already knows `showAt` and already resolves the incoming
   show for the pick. Reusing that same date for `maybeRoll` makes the mic-pass fall
   naturally in front of the changeover track, with no new deferral machinery. The
   two-part exchange stays atomic on the existing serialized voice chain.

Approach 3 also turns out to need *less* code than 1 or 2: the "wait for a boundary"
state already exists as `session.pendingHandoff()`, which stays non-null until
`markHandoffAired()`. We do not need to generalize `announceAtNextTrack` at all.

## Design

### Change 0 (prerequisite) — the context carries the date it was built for

**Without this, Change 1 does not merely fail — it silently suppresses the mic-pass
entirely.** This was found while reviewing the design, and it is the load-bearing
part of the whole thing.

`getFullContext(at?)` (`context.ts:288`) accepts a date and resolves `time`,
`festival`, `clock` and `activeShow` against it — but the object it returns
(`{ time, weather, festival, dominantMood, date, clock, activeShow, listeners }`)
does **not** include that date. Consumers cannot tell a look-ahead context from a
live one.

`session.start(ctx)` (`session.ts:218`) is such a consumer:

```ts
export function start(ctx: SessionContext, handoff: string | null = null): Session {
  const persona = settings.getEffectivePersona();   // ← live clock, ignores ctx
```

So a roll driven by `pickCtx` would build a session whose `show` is the **incoming**
show (from `ctx.activeShow`) but whose `persona` is the **outgoing** one (from the
live clock). `stampRolledFrom` (`session.ts:297-307`) then compares
`prev.persona.id` against `next.persona.id`, finds them **equal**, and sets
`rolledFrom = null` — no pending handoff, no mic-pass, ever. `runPersonaHandoff`'s
`personaIn` (`dj-agent.ts:1127`, reading `cur?.persona?.id`) would be wrong too.

Fix, in two parts:

- `getFullContext` returns `at: now.toISOString()` alongside the rest. (`date` is
  already taken by `getDateContext(now)`, hence `at`.) It is additive — no existing
  consumer reads it.
- `session.start` resolves the persona from that stamp:

```ts
const persona = settings.getEffectivePersona(ctx?.at ? new Date(ctx.at) : new Date());
```

Missing `at` → live clock, i.e. today's behaviour, so any context built by another
path is unaffected.

This is the single point where the design either works or inverts itself, so it is
worth verifying first: roll on a look-ahead context and assert
`session.getSession().persona.id` is the **incoming** persona before building
anything on top.

### Change 1 — the boundary sequence uses the lookahead date

In `queue.onTrackStarted`'s auto-pick block, hoist the `showAt` / `pickCtx`
computation above the roll, and drive the whole boundary sequence from it:

```ts
// before: roll on the live clock, then look ahead for the pick only
const ctx = await getFullContext();
await session.maybeRoll(ctx);
await programme.ensurePlan(ctx);
await djAgent.runPersonaHandoff(this, ctx);
await programme.onSessionSettled(this, ctx);
const durSec = Number(this.current?.track?.duration);
let pickCtx = ctx; let showAt = null;
if (Number.isFinite(durSec) && durSec > 0) { … pickCtx = await getFullContext(showAt); }
await djAgent.runTrackEvent(this, pickCtx, { wantLink, showAt });

// after: one date drives roll, plan, mic-pass, episode hook AND pick
const durSec = Number(this.current?.track?.duration);
let showAt: Date | null = null;
if (Number.isFinite(durSec) && durSec > 0) {
  showAt = new Date(Date.now() + (durSec + PICK_SHOW_LOOKAHEAD_SEC) * 1000);
}
const pickCtx = showAt ? await getFullContext(showAt) : await getFullContext();
await session.maybeRoll(pickCtx);
await programme.ensurePlan(pickCtx);
await djAgent.runPersonaHandoff(this, pickCtx);
await programme.onSessionSettled(this, pickCtx);
await djAgent.runTrackEvent(this, pickCtx, { wantLink, showAt });
```

Each step keeps its own `try/catch` — a handoff failure must never block the pick.

The invariant this buys: **the pick's brief and the mic-pass key off one date.**
Whenever a pick is made under the incoming show's rules, the mic-pass has already
aired in front of it. They cannot diverge, because there is no longer a second date
to diverge to.

Unknown duration → no `showAt` → live clock, today's behaviour, unchanged.

The existing `PICK_SHOW_LOOKAHEAD_SEC = 120` over-reach is now load-bearing for the
handoff too, and its rationale carries over unchanged: a pick starting just shy of
the boundary plays mostly inside the new show, so it should be the new show's — and
should therefore be preceded by the mic-pass. Update the comment at `queue.ts:1427`,
which currently documents the opposite.

### Change 2 — the hourly cron rolls but no longer airs

`rollSessionNow()` gains an option:

```ts
export async function rollSessionNow({ airHandoff = true } = {}) { … }
```

- `hourlyCheck()` passes **`airHandoff: false`**. It still rolls the session and
  plans the episode — that state must be right even when no track boundary is near —
  but it leaves `pendingHandoff()` set for the next boundary to air.
- The takeover routes (`routes/shows.ts:200`, `:220`) keep the default `true`. An
  operator takeover is an explicit action and should air promptly, the same
  reasoning that exempts manual `/dj/segment` runners from the budget gate.

With Change 1 in place the cron will normally find the session already rolled and
no-op. It becomes a safety net rather than the primary path.

### Change 3 — a pending handoff expires

Change 2 removes the thing that used to mark an unaired handoff aired, so a pending
mic-pass could otherwise survive indefinitely. Two ways that goes wrong: nobody is
listening at the boundary (the track-start path is skipped entirely —
`djCallsAllowed()` is false at `queue.ts:1383`) and a listener arrives hours later;
or a very long track means the next boundary is far away.

Stamp the roll and drop a stale mic-pass:

- `RolledFrom` gains `at: number` (epoch ms), set in `stampRolledFrom()`
  (`session.ts:301`). Sessions already on disk have no `at` — treat missing as
  "not stale" so an in-flight handoff across a deploy still airs.
- `runPersonaHandoff` drops and marks aired when
  `Date.now() - pending.at > HANDOFF_MAX_AGE_MS`, mirroring the existing
  `PENDING_VOICE_MAX_AGE_MS = 20 * 60_000` drop for pending idents
  (`queue.ts:1102`) — and for the same reason: a greeting carries a baked-in time
  reference, so a late one is worse than none.

Silence on a missed changeover beats a mistimed one. This is the same call
`shouldDropStaleLink` already makes for back-announces.

The decision is pure and gets a test seam:

```ts
// broadcast/session.ts
export function handoffIsStale(at: number | undefined, now: number, maxAgeMs: number): boolean {
  if (!Number.isFinite(at)) return false;   // pre-upgrade session — let it air
  return now - at! > maxAgeMs;
}
```

### Change 4 — a mic-pass supersedes a pending ident

Both a deferred station ID and a handoff can land on the same boundary:
`airPendingVoice()` fires at `queue.ts:1195`, the mic-pass from the async auto-pick
block. `airVoice` serializes, so nothing breaks audio-wise, but the listener gets
ident + sign-off + greeting stacked back to back.

In `airPendingVoice()`, drop the pending ident when `session.pendingHandoff()` is
non-null — a mic-pass names the station, the outgoing show and the incoming show, so
it *is* the station identification at that moment. Log it as a skip rather than
silently discarding, consistent with the `link-skip` log at `queue.ts:1135`.

### Change 5 — carry the persona on the queued item

`QueueItem` gains `introPersona?: Persona | null`, set at `push()` time from the
persona that actually wrote the line, then honoured at both later resolution points:

| site | today | after |
|---|---|---|
| `queue.ts:949` (drain, render) | `speak(text, { kind })` | `speak(text, { kind, persona: item.introPersona })` |
| `queue.ts:1145` (air, gain) | `voiceGainDb(kind)` | `voiceGainDb(kind, item.introPersona)` |
| `queue.ts:1148` (session turn) | no `meta` | `meta: { personaId, personaName }` |

On the generation side, the speaker is resolved **once**, from the same date as the
roll and the brief — `settings.getEffectivePersona(showAt)` — and threaded through:

- `dj-agent.ts:782` — `pickViaPool` currently calls `dj.generateLink({…})` with no
  `persona` key, so `scripts.ts:137` (`const speaker = persona || settings.getEffectivePersona()`)
  re-resolves on the live clock. Pass the resolved persona.
- `dj-agent.ts:258` — `pickSystem`'s `settings.getEffectivePersona()` (no date arg)
  takes the same resolved persona.
- `dj-agent.ts:526` — the `queue.push({ introScript: introLink, … })` call gains
  `introPersona`.
- `dj-agent.ts:1060`, `:1089` — the request-intro pushes gain it too, so a request
  intro queued near a boundary is voiced by whoever actually wrote it.

This preserves the documented rule at `settings.ts:3988` — *track picks and their
tied links stay with the host* — and starts enforcing it at render time, which it
currently is not.

### Change 6 — the handoff greeting's session turn

`dj-agent.ts:1172` airs the greeting with `{ persona: personaIn }` but no `meta`,
unlike the sign-off at `:1152`. Its session turn therefore carries no `personaId`,
so `windowMessages()`' speaker-attribution guard (`session.ts:443`) can't tag it.
Add `meta: { personaId: personaIn.id, personaName: personaIn.name }`.

## Resulting timeline

Replaying Jaz's changeover with a 5-minute track starting at 09:58:

| time | event |
|---|---|
| 09:55 | programme outro (last hour, station-minute :55 window) — unchanged |
| 09:58 | track A ends; `showAt` = 10:05 → **incoming show** |
| 09:58 | session rolls to mid-morning; episode plan built |
| 09:58 | outgoing DJ: sign-off — *at a boundary, over nothing* |
| 09:58 | incoming DJ: greeting (doubles as the programme intro) |
| 09:58 | track B starts — picked under the incoming brief, by the incoming host |
| 10:00 | hourly cron: session already rolled → no-op. **Boundary passes silently.** |
| 10:03 | track B ends; incoming DJ's link, in the incoming DJ's voice |

## Files touched

| file | change |
|---|---|
| `controller/src/context.ts` | Change 0 — return `at` on the context |
| `controller/src/broadcast/session.ts` | Changes 0, 3 — persona from `ctx.at`; `RolledFrom.at`, `handoffIsStale()` |
| `controller/src/broadcast/queue.ts` | Changes 1, 4, 5 — hoist lookahead above the roll; ident supersession; `introPersona` on `QueueItem` + `push()` + drain + air |
| `controller/src/broadcast/scheduler.ts` | Change 2 — `rollSessionNow({ airHandoff })`, `hourlyCheck` passes `false`; settle the three `pickOnAirSpeaker()` sites |
| `controller/src/broadcast/dj-agent.ts` | Changes 3, 5, 6 — staleness drop; persona threading; greeting `meta` |
| `controller/scripts/handoff-boundary.test.ts` | new — pure tests |

Note `RolledFrom.at` (Change 3) and the context's `at` (Change 0) are different
stamps — when the roll happened, versus what moment the context describes. Keep the
names distinct in code review.

`routes/shows.ts` is unchanged: it keeps the default `airHandoff: true`.

## Testing

No test runner beyond the `scripts/*.test.ts` convention (`npm test` →
`scripts/run-tests.ts`), so the testable surface is the pure decisions. New
`scripts/handoff-boundary.test.ts`, modelled on `scripts/stale-link.test.ts`:

- `handoffIsStale` — missing `at` → false; inside window → false; past window → true.
- The roll-date selection: finite duration → `now + duration + 120`; zero, negative,
  `NaN`, `undefined` duration → live clock.

Manual verification on the dev stack, which is where the real risk sits:

1. **Change 0 first, on its own.** Roll a session on a look-ahead context across a
   persona boundary and assert `session.getSession().persona.id` is the *incoming*
   persona and `pendingHandoff()` is non-null. If this fails, everything downstream
   is silently a no-op — do not proceed until it passes.
2. Paint two adjacent shows with different personas on the hour boundary.
3. Watch `state/logs/events-*.jsonl` for `dj.handoff` and confirm its timestamp
   falls within a second or two of an `onTrackStarted`, not at `:00`.
4. Confirm the track that straddles `:00` was picked *after* the handoff event.
5. Confirm the first link after the changeover is spoken in the incoming persona's
   voice — the specific regression Jaz reported.
6. With the stack up and no listeners, confirm the pending handoff expires rather
   than firing at whatever boundary follows a listener reconnecting.

Lint is the merge gate: `npm run lint` in `controller/` (`eslint . && tsc --noEmit`).

## Risks

- **Early mic-pass.** The 120s over-reach means the changeover can be announced up to
  ~2 minutes before the grid boundary. This is intentional and matches how the pick
  already behaves, but it does mean the outgoing DJ's slot ends slightly early. If
  that reads badly on air, the knob is `PICK_SHOW_LOOKAHEAD_SEC` — and shrinking it
  moves the pick and the mic-pass together, which is the point of the design.
- **The session leads the grid by up to ~2 minutes.** This is the sharpest edge of
  the design and deserves stating plainly: between the anticipated roll and the
  actual boundary, `session.getSession().persona` is the *incoming* DJ while
  `settings.getEffectivePersona()` — called with no date, on the live clock — still
  returns the *outgoing* one. Any code reading the live persona in that window
  disagrees with the session. Change 5 is what makes this safe on the paths that
  matter, by resolving the speaker once from `showAt` and carrying it on the item
  rather than re-deriving it later. The audit is bounded: there are 22 no-argument
  `getEffectivePersona()` call sites, but most are irrelevant — signature defaults
  (`settings.ts:120`/`:135`, `system.ts:44`/`:105`), `audio/tts.ts` fallbacks that
  already receive an explicit persona from the callers Change 5 fixes, and UI reads
  (`routes/public.ts:203`/`:333`, `routes/settings.ts:55`) where the live clock is
  the correct answer. The ones that actually pick an on-air speaker are a short list:

  | site | disposition |
  |---|---|
  | `session.ts:218` | **Change 0 — mandatory**, or the design inverts |
  | `dj-agent.ts:258` (`pickSystem`), `:318` | Change 5 |
  | `scheduler.ts:420`, `:505`, `:669` — `pickOnAirSpeaker()` no-arg (hourly, link, station ID) | decide per site; these already accept a date (`settings.ts:3990`) |
  | `request.ts:88` | decide; a request landing at 09:59 arguably belongs to the incoming DJ |

  `prompts/system.ts:32` already carries a comment about this exact skew
  ("clock-driven `getEffectivePersona()` has already moved on by the time they
  run"), so the codebase has met this class of bug before. Settling these call
  sites is part of the work, not a follow-up.
- **Cron no longer airs.** If Change 1 fails to fire for a reason not anticipated
  here, the mic-pass now waits for a boundary instead of firing at `:00`, so the
  failure mode is a *missing* handoff rather than a mistimed one. The staleness drop
  bounds how long a broken one can linger; the `dj.handoff` event is the thing to
  watch after deploy.
- **`getFullContext(showAt)` is called once per track start.** It already was, for
  the pick — this change reuses that value rather than adding a call. The live-clock
  `getFullContext()` call is dropped when a duration is known, so this is one call
  fewer on the common path.

## Implementation notes

Three things changed between this design and the shipped code.

**1. Identity looks ahead; the clock does not.** The design said to drive the
whole boundary sequence off `showAt`. That is right for *identity* (which show
and persona are on) but wrong for the *clock*: `SCRIPT_CONTEXT_FIELDS` in
`llm/internal/prompts/scripts.ts` includes `clock`, so the handoff prompts would
have been handed a time up to a track-length plus the look-ahead margin ahead of
when the mic-pass actually airs — the DJ misstating the time on air, which is the
failure issue #864 fixed for links. The queue call site now passes the handoff a
merged context: `show`/`mood`/`festival` from the look-ahead (the show being
handed *to*), `date`/`clock`/`time` from the live moment. Built only when a
handoff is pending, so it costs nothing per track.

**2. `session.onAirPersona()` replaced `getEffectivePersona(showAt)`.** Threading
a date through every speaker lookup would have meant every call site
re-deriving the same answer and being able to get it wrong. Since the roll has
already happened by the time anything writes a line, the session *is* the answer:
one exported helper in `session.ts` resolves the live session's persona and falls
back to the grid. Used by `pickSystem`, `requestSystem`, the pool-pick link, and
all four `introPersona` stamps.

**3. `pickOnAirSpeaker()` call sites were left alone, deliberately.** The three
no-argument sites in `scheduler.ts` are the hourly check (`:420`), the manual link
runner (`:505`) and the station ID (`:669`). Idents fire at `:15/:30/:45` and the
hourly at `:00`, none of which fall inside the ~2-minute window where the session
leads the grid, so only the manual link route can disagree — a rare operator
action whose fallback is simply the outgoing DJ speaking once more. Adding a
session-aware speaker variant for that case is scope the fix doesn't need.

Also shipped beyond the file list: `routes/request.ts` gained `introPersona` on
its two stateless-fallback pushes (`:276`, `:559`), which have the same
render-later/air-later split as the agent path.

### Verification performed

Beyond `npm test` (37 files) and `npm run lint` (0 errors), the Change 0 chain was
exercised against the real modules with a seeded state dir — two adjacent shows
on the hour with different personas:

- **Positive:** a roll on a context stamped for `10:05`, executed at wall-clock
  `09:58`, produced a session whose persona was the *incoming* DJ and a
  `pendingHandoff()` armed from the *outgoing* one, with `at` stamped.
- **Counter-proof:** the same roll with the `at` stamp stripped rolled the *show*
  to "Mid Morning" but left the *persona* on the outgoing DJ — so
  `stampRolledFrom` saw no change and `pendingHandoff()` was `null`. This is the
  suppression this design predicted, reproduced on demand, confirming Change 0
  is load-bearing rather than defensive.

## Out of scope

- Generalizing `announceAtNextTrack` into a multi-slot queue. Not needed — the
  handoff uses `session.pendingHandoff()`, which is already a deferral mechanism.
- Moving the *session roll* off the cron entirely. The cron remains the only boundary
  detector when nobody is listening, and shows must roll whether or not anyone hears
  the changeover.
- The programme outro's grid-position scheduling (`span.index !== span.total - 1`),
  which can sign off at a station-minute that isn't the real end for a takeover
  spanning a partial hour. Real, unrelated, worth its own issue.
- Deferring the other immediate `announce()` callers (hourly check, banter, skill
  segments) to track boundaries. Same class of improvement, but each has different
  timing semantics — the hourly check in particular is *about* the wall clock.

## Review fixes (PR #1090)

Code review found three places where a consumer of session state was still on
the live clock while the roll had moved to the look-ahead date — the same
disease Change 0 fixed for `session.start()`, in three more hosts:

1. **`programme.maybeRunIntro` aired the standalone intro mid-song at `:00`.**
   The hourly cron's `airHandoff: false` leaves `handoffAired` false, but the
   intro's skip-guard required `rolledFrom && handoffAired` — so a
   persona-change boundary into a programme show fell through the guard and
   aired the intro immediately, then the deferred greeting introduced the
   episode a second time. Fix: while `session.pendingHandoff()` is armed the
   intro stays pending; the boundary tick resolves it after
   `runPersonaHandoff` (which marks `handoffAired` on every exit path).

2. **A listener request could roll the session backward.**
   `routes/request.ts` still calls `session.maybeRoll` with a live-clock
   context; inside the look-ahead window that context resolves the outgoing
   show, and `maybeRoll` had no direction guard — a request there archived the
   just-rolled session, stamped a mirrored reverse `rolledFrom`, and handed
   `onAirPersona()` back to the DJ who just signed off. Fix: sessions carry
   `ctxAt` (the moment their key/persona were resolved for) and `maybeRoll`
   refuses a roll to an older moment (`rollIsBackward`, pure, unit-pinned).
   The guard lives at the chokepoint, so every live-clock caller is covered.

3. **`programme.ensurePlan`/`onSessionSettled` silently no-oped in the window.**
   Their `now` defaulted to `new Date()`, so `activeEpisode` compared the
   incoming session key against the outgoing show and returned null — the plan
   never built at the roll tick and the greeting aired with `episodeAngle:
   null`. Fix: `now` defaults to `session.contextDate(ctx)`, so the date and
   the context can never disagree (the Change 0 principle, applied here).
