# On-air persona handoff at show boundaries

**Date:** 2026-07-03
**Status:** Implemented on this branch (PR #762)

## The idea

When a show ends and a different persona takes over, the outgoing DJ signs off
on air and passes the mic; the incoming DJ acknowledges and opens their shift.

> "This is Johnny Fever signing off for now — passing the mic over to Cool
> Hand Luke for your Afternoon Drive."
>
> "Cheers Johnny. Luke here — let's ease into the afternoon…"

Two distinct voices, back to back, heavy-ducked over whatever's playing.

## Why it's feasible today

Everything needed already exists except one primitive:

- **Boundary detection** — `session.maybeRoll()` (broadcast/session.ts) already
  hard-rolls the session at show boundaries and builds a *text* handoff
  (`buildHandoff`) carried into the new session. Nothing is spoken today.
- **Two voices in sequence** — `airVoice()`'s `_voiceChain` lock (queue.ts)
  already serializes every spoken clip across both duck channels, holding until
  each clip finishes. Two `announce()` calls play cleanly in order.
- **Per-persona voices** — each persona carries its own `tts` block (engine,
  voice, gain, speed) plus `language`/`soul`.
- **The one gap** — `tts.speak()` resolves the persona *internally* via
  `settings.getEffectivePersona()`, which is clock-driven. The moment the hour
  flips, the outgoing persona is no longer "effective", so their sign-off would
  render in the *new* persona's voice. Fix: a persona override option threaded
  through `speak()`/`announce()`.

## Approaches considered

**A. On-air handoff at the hard roll (recommended).** When the session
hard-rolls and the effective persona actually changed, generate a sign-off (as
the outgoing persona) and a greeting (as the incoming persona, fed the sign-off
text so it can genuinely respond), voice each with its own persona's TTS, and
air both through `say.txt`. One trigger point, both halves paired atomically,
the greeting can reference the sign-off.

**B. Pre-boundary sign-off (e.g. :57 cron) + post-boundary greeting.** The
sign-off airs while the outgoing persona is still effective (no TTS override
needed), the greeting rides the new session's first segment. Rejected: two
loosely-coupled halves (a restart between them orphans the pair), a new cron
path, and the acknowledgment can't quote a sign-off that hasn't aired when the
new session's first segment is generated independently.

**C. Prompt-only.** Enrich the existing text handoff so the incoming persona's
*first* scripted segment acknowledges the predecessor. Cheapest, but no
guaranteed sign-off moment, one voice only — doesn't deliver the two-voice
mic-pass.

## Design (Approach A)

### Trigger

`maybeRoll()`'s hard-roll branch stamps roll metadata onto the *fresh* session:

```js
_session.rolledFrom = prevPersonaChanged ? {
  personaId, personaName,        // outgoing persona
  showName,                      // show that just ended (or null for auto block)
} : null;
_session.handoffAired = false;
```

Persona change is judged by comparing `prev.persona?.id` against the fresh
session's `persona?.id` — same persona across a show boundary (e.g. Marlowe's
show ends, Marlowe stays on as the active persona) means **no** on-air handoff;
the existing text handoff already covers continuity.

Because the flag lives *on the persisted session*, a controller restart between
roll and airing can't double-fire, and either `maybeRoll()` call site (hourly
cron at :00, or the first track-start after the boundary) can trigger the
handoff — whichever runs first. Session.ts itself stays free of queue/TTS
imports (no cycle): the *callers* check `session.rolledFrom && !handoffAired`
and invoke the runner.

### Runner — `runPersonaHandoff(queue, ctx)` in broadcast/dj-agent.ts

Gate order (all existing helpers):
1. `session.rolledFrom` present and `handoffAired` false, else no-op.
2. `djCallsAllowed()` — nobody listening → mark aired, skip (don't stack a
   stale handoff for later; the moment has passed).
3. Budget: treated as an **optional segment** — skipped at both `soft` and
   `hard` tiers (policy stays in broadcast/dj-budget.ts like every other gate).
   Mark aired either way. Cheap to loosen later; a handoff fires at most ~once
   an hour.

Then, marking `handoffAired = true` up front (a failed attempt must not retry
into the middle of the new show):

1. **Sign-off** — `dj.generateSignoff({ personaOut, personaIn, showIn, context })`
   (new free-text generator in llm/internal/prompts/scripts.ts, patterned on
   `generateStationId`). System prompt rendered with the *outgoing* persona's
   soul/language; brief: 1–2 sentences, sign off by name, hand to the incoming
   host (and show name when there is one). Reuses the existing random-angle +
   opener-anti-repeat machinery.
2. **Greeting** — `dj.generateHandoffGreeting({ personaIn, personaOut,
   signoffText, showIn, context })`. System prompt rendered with the *incoming*
   persona; the sign-off text is in the user prompt so the reply can actually
   acknowledge it ("Cheers Johnny…"). 1–2 sentences, tee up the shift.
3. **Air both** — `queue.announce(signoff, 'handoff', { persona: personaOut })`
   then `queue.announce(greeting, 'handoff', { persona: personaIn })`.
   `_voiceChain` plays them in order on the heavy-duck channel.

Failure handling: each half is independent. Sign-off LLM/TTS failure → still
attempt the greeting (it stands alone: "taking over from Johnny…"). Greeting
failure → the sign-off alone still airs. Any failure logs via `queue.log` and
never blocks the roll — the existing text handoff is the floor.

### TTS persona override

- `tts.speak(text, { kind, persona })` — when `opts.persona` is provided,
  `djPersonaTts()`, the `language`/`soul` ride-alongs, and the persona speed
  term all resolve from it instead of `getEffectivePersona()`. Absent, behaviour
  is byte-identical to today.
- `queue.announce(text, kind, { persona })` grows the same optional third
  argument and forwards it. All existing call sites unchanged.

### Session + telemetry bookkeeping

- The previous session is already archived by the time the runner fires, so
  both turns append to the **new** session as
  `role: 'segment', kind: 'handoff'` (the sign-off tagged
  `meta: { personaId, personaName }` of the outgoing persona), so the incoming
  DJ's window opens with the mic-pass it just took part in. Handoff turns are
  real on-air speech and belong in the window, but the sign-off was spoken by
  a *different* persona — `windowMessages()` uses the meta tag to prefix it
  with the real speaker's name (mirroring the pick-note marker) so the
  incoming DJ never reads the predecessor's words as its own.
- `kind: 'handoff'` is registered in the queue's recap `VOICE_KINDS`, so both
  lines feed `getDjRecap()` / `getRecentOpeners()` and later segments don't
  echo the greeting's opener.
- `webhooks.notify('dj.say', { text, kind: 'handoff' })` per line, matching
  other spoken segments.
- `logEvent('dj.handoff', { from, to, show })` on the unified timeline.

### Scope

- **In:** hard rolls where the effective persona changes — show starts, show
  ends (back to the active persona), show→show, and the 4h age-cap roll if the
  persona happens to differ.
- **Out (follow-ups):** a manual persona flip in the admin UI mid-block (it
  doesn't roll the session today, so there's no boundary to hook); a handoff
  jingle/sweeper between the two lines; per-show custom sign-off briefs.

### Testing

No test runner in this repo — verification is `npm run lint` in controller/
plus a live smoke test: schedule two adjacent one-hour shows with different
personas in the dev stack, watch the :00 boundary, confirm two voices air in
order and `state/sessions/` + the event log carry the handoff turns.
