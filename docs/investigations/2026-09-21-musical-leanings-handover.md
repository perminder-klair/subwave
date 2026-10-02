# Musical Leanings handover — 21 September 2026

## Purpose and current status

Musical Leanings remains an optional, separate presenter field for private
music-selection guidance. It is a soft editorial preference only: it must not
create candidates or override flow, show rules, rotation, safety, requests, or
the existing artist/album guards.

The station work now establishes two controller-resolved route contracts:

- **Track Shortlist** retains its `usedMusicalLeanings` diagnostic and the
  `LEANINGS` Debug badge.
- **Agentic Tools** can show the same badge only when a separate, compact
  review changes the blind preliminary choice and the controller can verify
  the exact Musical Leanings phrase used, the selected track's support for
  that phrase, and an acceptably close ordinary-flow comparison.

Agentic does not trust a model-reported provenance boolean. The model proposes
a challenger and quotes one of a closed list of exact preference phrases; the
controller independently decides whether that proposal is badge-worthy.

The compact review has passed focused tests, offline local-model replay and an
extended station run. The first 55 live reviews produced eight verified badges
with a median review time of about 4.6 seconds on the local 8B model.

## Agentic false-flag investigation

The original Agentic contract asked the model to return:

- `usedMusicalLeanings: boolean`; and
- `leaningsTieBreak: string | null`.

That was not reliable on the local Meta Llama 3.1 8B Instruct Q5_K_M model.
Observed failures included:

1. **Schema-example copying.** The example phrase `warm vocal and melodic
   hook` appeared in output even when it was not grounded in the candidate or
   presenter.
2. **Generic-flow relabelling.** Terms such as energy, mood, pace, and
   reflective/club feeling were returned as Leanings evidence. These overlap
   with show tags and normal selection context, rather than proving a
   presenter-preference tie-break.
3. **Profile echoing.** The model paraphrased the supplied Leanings in the
   private reason without making a reliable causal distinction.
4. **Unreliable omissions.** A model can select in the direction of a
   preference but return `usedMusicalLeanings: false`; conversely it can claim
   a tie-break where no grounded evidence exists.
5. **Candidate-order bias.** When the editorial pass was asked to select from
   every discovered candidate, it behaved like another general reranker. In a
   25-review live sample it chose the first supplied candidate 17 times and
   never retained the preliminary choice. Twelve reviews changed the track,
   but none produced controller-valid Leanings evidence.

The problem was amplified because Agentic saw Leanings more than once: in the
system prompt, in the newest pick event, and in a fresh diagnostic reminder.
The repeated text improved salience but made the model more likely to echo the
instruction and schema than to give factual provenance.

## Replay evidence

`controller/scripts/agentic-leanings-replay.ts` replays a saved Agentic turn
against the recorded discovery results. It neither queues music nor calls
Navidrome. The two checked fixtures are:

- `scripts/fixtures/agentic-leanings/maria-marcella-detroit.json`
- `scripts/fixtures/agentic-leanings/dante-porcupine-tree.json`

Important findings:

- The original Agentic diagnostic produced false Leanings claims for Dante
  (typically 5/5), and copied the schema example in some runs.
- Removing only `leaningsTieBreak` removed the copied wording but did not stop
  false boolean claims.
- A frozen candidate-final-selection experiment retained valid IDs and
  eliminated Dante's false Leanings claims by removing the diagnostic fields.
- In matched 20-call samples, Maria's Leanings-enabled final selection chose
  Phil Collins 13/20 times versus 7/20 in the no-Leanings control. Dante's
  result was essentially unchanged: R.E.M. was selected 17/20 in both arms.
  This is consistent with Leanings softly affecting a genuine choice in one
  fixture without overriding a stronger flow case in the other.
- The final model's boolean remained unusable: Maria reported the expected
  provenance only 2/20 times despite the measurable selection shift.

These experiments support placing Leanings beside an already discovered
candidate set, but show why unconstrained model self-report cannot justify a
live badge. The newer contract below narrows the claim to facts the controller
can verify.

## Current Agentic architecture

When the presenter has a non-blank Musical Leanings field:

```text
djAgentPick → djAgentLeaningsReview → artist/album guards → queue
```

1. `djAgentPick` performs discovery and makes the blind preliminary choice. It
   sees the ordinary presenter Soul, but receives no separate Musical
   Leanings prompt and has no Leanings diagnostic fields in its schema.
2. The controller extracts a closed list of exact preference phrases from the
   resolved host/optional guest Leanings.
3. The controller creates a small, deterministic review set: the preliminary
   choice first, three close ordinary-flow alternatives, and at most two
   metadata-grounded preference matches. Candidate insertion order cannot
   change this set.
4. `djAgentLeaningsReview` receives a minimal system prompt, the compact
   candidates, and the exact allowed phrases. It may propose one challenger
   and must return one exact phrase, or retain the preliminary choice with
   `NO_LEANINGS_INFLUENCE`.
5. The controller accepts a Leanings-led replacement only when all of the
   following are true:

   - the selected ID belongs to the compact review set and differs from the
     preliminary choice;
   - the quoted phrase exactly matches the active Musical Leanings;
   - the selected candidate's library metadata supports that phrase;
   - its ordinary-flow comparison is `close` or `possible`; and
   - the musical reason is sufficiently specific.

6. For an accepted replacement, the controller writes the public reason so it
   names the DJ, track and exact verified preference wording. Existing artist
   and album guards can still override it before queueing; an overridden or
   unqueued choice does not keep the badge.

If the Musical Leanings field is blank, `djAgentLeaningsReview` is not called.
Agentic follows its ordinary one-step discovery-and-pick behaviour and still
sees any musical preferences the operator deliberately left in the presenter
Soul.

The review is therefore a proposal, not the authority. It cannot select a
hidden candidate, invent its own preference wording, or turn a generic
energy/mood explanation into a Leanings badge. The controller-resolved ID,
evidence and reason are authoritative.

### Replay observations for the constrained review

`controller/scripts/agentic-leanings-review-replay.ts` exercises the new
contract without queueing music. It rotates discovery insertion order on each
iteration and asserts that the controller's compact candidate set remains
stable.

- The replay input is about 1,900 tokens, compared with roughly 8,000–10,000
  tokens observed in the earlier full-context review.
- The Shelby fixture produced the same controller-valid replacement in 3/3
  runs: Jellybean's `Who Found Who`, grounded in the exact active phrase
  `electronic music`.
- In the Russell negative fixture, the local model proposed an unsupported
  alternative in 3/3 runs and invented `sophisticated rock`. The controller
  rejected every proposal and retained the blind preliminary choice in 3/3
  runs.

This demonstrates the intended safety property: model inconsistency can lose
a potential badge, but cannot manufacture verified Leanings evidence.

Run the focused replay with:

```sh
npm run leanings:review-replay
npm run leanings:review-replay -- scripts/fixtures/agentic-leanings-review/russell-generic-mood.json 3
```

### Earlier live smoke observations

The initial live sample completed the expected two-call sequence for every
Agentic run that surfaced usable candidates. A blank Leanings field was also
confirmed not to call `djAgentLeaningsReview`.

The two-step arrangement was faster than the old local Agentic runs in the
small sample:

- previous `djAgentPick` average: about 32.3 s;
- new discovery average: about 15.3 s;
- editorial final selection average: about 5.2 s;
- combined average: about 20.5 s.

The three observed five-minute Agentic deadlines were attributed to local GPU
pressure in the looping discovery tools, not the editorial final-selection
step.

Those timings pre-date the compact review contract and should not be used as a
performance expectation. The new replay reduces input substantially, but
local model load and generation time still vary.

## Track Shortlist status

Shortlist's natural selection wording was restored to its pre-tie-break
behaviour after the Agentic tie-break contract leaked generic energy/mood
claims into this path. It has its own single controller-resolved boolean:

- a positive Shortlist `usedMusicalLeanings` decision may retain a natural
  track-specific reason;
- there is no free-text tie-break trait;
- the Debug `LEANINGS` badge follows that boolean alone.

The latter point matters: Debug temporarily required a non-empty
`leaningsTieBreak` as well as the boolean. Since the trait is intentionally
`null` on Shortlist, that hid all valid badges even though the model was
returning positive selections. The local Debug fix restores badge display from
the resolved boolean only.

Recent live Shortlist records confirmed positive model decisions, including
The Duke Spirit, Smerz and Korn, once the badge condition was corrected.

## Soul-only result

Do not claim that vanilla Soul prose has a proven picking effect on either
route. The calibrated experiment recorded in
`2026-09-19-agentic-soul.md` found equal Track Shortlist A/A and Soul A/B
change rates (9/24 each) on the local model and fixture. Early 6/12 Shortlist
observations were uncalibrated and are not causal evidence.

Soul remains available to the normal Agentic persona prompt; the result only
means its independent musical effect is not measurable enough for a badge.

## Suggested follow-up investigations

1. **Monitor attribution edge cases without tightening yet.** In the first 55
   compact reviews, eight replacements reached the queue with a badge. Four
   had weaker causal attribution even though the review genuinely changed the
   track: in three cases the preliminary track also matched the cited phrase;
   in one, `alternative pop` was inferred across separate `Alternative Rock`
   and `Power Pop` genre tags. That frequency is not currently excessive and
   the badges are useful evidence that the feature is active. Revisit only if
   users report misleading results; possible stricter rules are to require the
   cited phrase to distinguish the replacement from the preliminary track and
   to keep multiword matching within one metadata tag.
2. **Continue fixed-candidate controls.** The replay harness can compare the
   same candidate set with and without Leanings at aggregate scale. This is
   appropriate for evaluation, not live shadow decisions.
3. **Measure false negatives.** Save rejected review proposals alongside the
   controller's rejection reason. This will show whether metadata matching or
   the ordinary-flow threshold is now too strict without weakening the badge.
4. **Consider structured Leanings alongside prose.** A future operator-facing
   preference taxonomy could make factual matching auditable while retaining
   free text for broad taste.
5. **Debug quality.** Populate verified selection on the
   `djAgentLeaningsReview` record as well as the original `djAgentPick` record;
   today the original card is refreshed to the final queued track, while the
   raw responses remain intentionally historical.

## Review / PR hand-off

PRs:

- #1678: `feat/musical-leanings` — shared policy, guest safe-off, Agentic
  implementation, Agentic replay harness, and this handover.
- #1687: `feat/intelligent-candidate-pool-alternative` — Track Shortlist
  behaviour, natural reason restoration, and the Shortlist Debug badge fix.

#1678 remains independent of #1687: its Agentic reason and validation helpers
live under the Agentic module, so the Musical Leanings PR can still merge
ahead of the Track Shortlist PR.

Suggested reviewer note:

> Agentic picking no longer trusts model-reported Musical Leanings provenance.
> The blind preliminary pick is followed by a small, deterministic review of
> close alternatives. A replacement earns the Leanings badge only when the
> controller can verify its exact active preference phrase, supporting track
> metadata, ordinary-flow proximity, final queue result and public rationale.
>
> The local model still makes imperfect proposals. Replay includes a negative
> case where it invents an unsupported preference in 3/3 runs; the controller
> rejects all three and retains the preliminary pick. With Musical Leanings
> blank, Agentic follows its existing single-pass behaviour.
