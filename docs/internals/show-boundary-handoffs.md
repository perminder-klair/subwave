# Show-boundary handoffs

## Why this needs a boundary model

Show changes are audible editorial boundaries, not merely a different prompt
context for the next picker run. A listener should hear one coherent final
outgoing-show track, a natural handoff during that track, then the incoming
show. Preparing the next track ahead of time must not make the incoming show
or its host appear on air early.

The controller's playback queue, session identity, presenter roster, and
spoken-segment scheduling therefore need an explicit distinction between a
**planned** boundary and an **on-air** boundary.

## Observed failure modes

### Early handoff

The picker uses a look-ahead time to decide which show's constraints apply to
a future pick. When that same look-ahead immediately rolls the live session,
the outgoing presenter can sign off several minutes before the scheduled
change. The new host and show then become the active identity while the final
outgoing-show track is still playing.

### Cross-boundary speech

Track-linked speech is rendered and queued ahead of playback. If it survives
an early identity roll, an outgoing presenter can speak after the handoff, or
an incoming presenter can describe the outgoing programme as though they
already host it. A handoff must be the outgoing presenter's final ordinary
spoken contribution.

### Host/guest inversion

Two adjacent shows may deliberately reverse the same presenters' roles. For
example, presenter A may host the outgoing show with presenter B as a guest,
while B hosts the incoming show with A as the guest. Applying the incoming
roster while the outgoing show is still on air produces contradictory IDs,
links, and banter even when each generated line follows its prompt correctly.

### Repeated schedule mentions

This is not a vanilla SUB/WAVE behaviour. It applies only when an optional
context integration supplies next-show or remaining-show facts to every speech
request. In that configuration, the facts invite repetition unless the
integration has a cadence policy. They are useful near a boundary, but are
programme beats rather than default material for every link, ident, segment,
or co-host exchange.

## Required on-air sequence

1. Identify and queue the final track that still belongs to the outgoing show.
2. Let that track's linked intro play, when one exists.
3. Prepare one atomic outgoing-sign-off/incoming-greeting pair without rolling
   the live session early.
4. With normal talk placement, air that pair during the final track. With
   **Talk only between tracks**, render it during the final track but hold it
   for the first real track seam at or after the scheduled boundary.
5. After the handoff is claimed, suppress ordinary outgoing-presenter speech.
6. At the real changeover, activate the incoming session and roster; its first
   track then starts under the new show's identity. There is no mandatory
   spacer track between the two halves of a handoff.

Pair-drain discovers the incoming pick while the track before the final one is
still live. That look-ahead may arm the record and prepare the incoming episode,
but it cannot publish speech. The record carries the final outgoing track's
identity; only the corresponding `now-playing.json` transition authorises the
pair. `airIntro()` is awaited to the handoff-write boundary first, which puts the
final track's own line ahead of the handoff on the shared voice serialiser.

The boundary must be driven by confirmed playback state where possible. A
queued URI is only handed to Liquidsoap, not proof that a listener has reached
the corresponding on-air moment.

## Design constraints

- Keep look-ahead selection: it is needed to choose music appropriate for the
  upcoming show.
- Do not use look-ahead selection as permission to roll the live session,
  switch the on-air roster, or speak a handoff.
- Preserve listener-request handling and manual operator actions.
- Keep the outgoing sign-off and incoming greeting as the only intentional
  cross-persona handoff speech.
- A top-of-hour check postponed by between-tracks placement must be generated
  under the incoming identity and current clock once the handoff has cleared.
- A pair rendered for a future seam is **queued**, not aired. That state is
  persisted with the session so a controller restart regenerates lost WAVs;
  only the final line's stream-edge marker settles the complete pair as aired.
- If the wall-clock session roll wins the race with the final-track marker, the
  armed record transfers to the incoming session and generic roll/drain hooks
  still leave it for the confirmed-track runner.
- The outgoing half reads the still-live outgoing session; the incoming half
  starts with clean prompt memory. If the incoming show is a programme, its plan
  is prepared onto the boundary record and transferred at the real roll so the
  greeting carries the incoming angle and durably replaces the standalone intro.
- Handoff suppression applies only inside the scheduled-talk scope. Manual
  operator speech remains immediate, and listener-request intros remain governed
  by their request/session rules rather than by the handoff lifecycle.
- Treat a missing/unknown duration conservatively: never invent an exact
  boundary time or delay music waiting for one.

## Optional schedule-fact cadence

Optional context integrations that supply schedule facts should use a dedicated
cadence policy shared by all automatic speech paths. This branch neither adds
nor changes such an integration. Where those facts are available, the policy
should allow only a small number of mentions in the final part of a show (for
example, one general final-half-hour mention and one nearer the handoff), while
leaving the handoff itself to name the incoming show naturally. It must not
depend on model self-restraint.

## Regression coverage

Tests should cover at least:

- a normal show transition with an outgoing linked intro;
- a handoff that would previously have fired early due to look-ahead;
- no outgoing ordinary speech after the handoff;
- a host/guest role reversal between adjacent shows;
- no schedule-fact repetition outside an optional integration's cadence allowance;

## Resolved live finding — 8 September 2026

An ordinary link was generated under the outgoing presenter immediately before
the clock boundary, survived the session roll, and aired under that outgoing
voice on a later incoming-show track. Live evidence: Carol's `generateLink`
completed at 22:59:40 BST; the station changed to Dante's Inferno at 23:00;
the Carol-authored link aired at 23:05:35.

Track-linked speech is now stamped with the editorial session key that created
it. At air time, a link whose key differs from the live session is vetoed
before rendering or playback. This is deliberately session-based, rather than
persona-based, so it also prevents context leaking between two adjacent shows
hosted by the same DJ (for example Lucy's Dawn Chorus → Get up and Go!).
Request acknowledgements and old queue items without a session stamp retain
their existing behaviour. The regression coverage pins Carol → Dante, Lucy →
Lucy, same-session links, and request/legacy compatibility.
