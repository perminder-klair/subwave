# Musical Leanings investigation: explicit, auditable editorial control

Status: active investigation; the Agentic contract and guest safe-off policy
are deployed to the development station. This document records both the
completed evidence and the remaining Track Shortlist parity work.

## Decision

SUB/WAVE should retain **Musical Leanings** as a separate, optional Persona
field for private track-selection guidance.

A DJ Soul remains valuable: it establishes the presenter’s character, voice,
and broad editorial identity. However, any musical effect of prose embedded in
Soul is implicit, invisible to the operator, and cannot be attributed honestly
to one sampled pick. Editing Soul also changes the presenter’s voice and
character, making it the wrong control surface for an operator who merely wants
to tune musical preference.

Musical Leanings is the bounded alternative. It is a soft tie-breaker only
between tracks that are already eligible under the current flow, show rules,
rotation, requests, safety, and library guards. It never creates candidates,
changes listener-facing speech, or overrides those protections.

The `LEANINGS` marker is a **model-reported, controller-validated diagnostic**.
It means the picker supplied an accepted concrete tie-break trait while
Leanings were present. It does **not** prove that the selected ID would have
been different without the field.

## Questions investigated

1. Can a vanilla, natural-language DJ Soul influence final musical choices?
2. Can that influence be detected reliably enough for a per-pick operator
   indicator?
3. Does the answer differ between Agentic Tools and Track Shortlist?
4. What product role remains for a separate Musical Leanings field?

The representative input was Bob: a warm, knowledgeable presenter whose Soul
mentions classic/alternative/indie/post-punk, melodic guitars, basslines,
distinctive production, musicianship, deep cuts and overlooked discoveries,
while avoiding manufactured pop and novelty records.

## Method and safety

All offline evaluators use a fresh temporary `STATE_DIR`, disable fallback in
memory, and never import the broadcast queue, alter station settings, queue
tracks, create speech, scrobble, or run Docker. Real-library experiments only
perform read-only Navidrome discovery.

The important methodological correction was **A/A null calibration**. The
production sampling temperature is `0.5`, so a changed control-versus-Soul
choice alone is not causal evidence: the same prompt can legitimately produce
a different pick. Each calibrated iteration therefore makes four calls from
the same frozen candidate snapshot:

- `control-a` and `control-b` — the null A/A comparison;
- `soul-a` and `soul-b` — the A/B Soul comparison.

An observable Soul effect requires the A/B change rate to materially exceed the
A/A rate. This is an offline aggregate experiment, not a viable per-song live
test; a live counterfactual would require expensive shadow runs and would still
be subject to sampling variation.

## Soul-only selection findings

### Early frozen and real-library work

The first frozen-candidate Agentic run on `gpt-5.4-mini` had 5/24 paired
control/Soul changes, all toward the treatment preference in one useful
post-punk close-call fixture. A real-library confirmation with identical
candidate snapshots produced 4/12 changed choices. A local eight-candidate
Agentic confirmation produced 5/12 changes; the corresponding local Shortlist
confirmation produced 6/12.

Those results established that the full production paths, fixed snapshots, and
representative Souls could be exercised. They were encouraging observations,
but they were **not causal results**, because they predated A/A calibration.

The original, unrestricted real-library Agentic run is explicitly exploratory:
its two arms used stochastic discovery and could receive different candidate
sets. It must never be cited as evidence that Soul alone caused its 11/12
selection differences.

### Calibrated local results

The station’s local model is Meta Llama 3.1 8B Instruct Q5_K_M, served through
llama.cpp. It has historically struggled with Agentic tool loops and context
capacity; that operational history was the original motivation for controller
native discovery plus one bounded Shortlist choice.

| Route | Completed calls | A/A null changes | Soul A/B changes | Result |
| --- | ---: | ---: | ---: | --- |
| Track Shortlist | 48/48 | 9/24 | 9/24 | No detectable Soul effect above sampling variation |
| Agentic Tools | 48/48 | 14/24 | 12/24 | No detectable Soul effect above sampling variation |

The Shortlist fixture split was also identical: *The Killing Moon* was 2/12 in
both null and Soul comparisons; *Yellow* was 7/12 in both. The Agentic A/B rate
was slightly lower than its null baseline, not higher.

**Calibrated conclusion:** on this local model and these real-library fixtures,
neither picker provides a detectable vanilla-Soul preference signal above
ordinary sampling variation. The early 5/12 and 6/12 results are uncalibrated
observations and must not be presented as proof of causal Soul influence.

This does not say that Souls never affect selection, nor that every model or
fixture behaves the same way. It says an operator cannot truthfully receive a
per-pick badge claiming that Soul influenced this selection.

## Why a separate field remains useful

The historical Producer Routing and Shortlist design work gives three durable
reasons for a separate field:

1. **Explicit operator control.** An operator can state a music preference
   without rewriting a presenter’s character or delivery.
2. **Portable picker policy.** Both Agentic and controller-native Shortlist
   routes can honour the same bounded editorial instruction, even though their
   discovery mechanisms differ.
3. **Host/guest weighting.** A structured field can make a guest’s influence
   explicitly weaker than the on-air host’s, while preserving all hard guards.

The agentic-tool benchmark history also remains relevant: the local 8B model
was measured around 20.6 seconds at one discovery step, 27.0 seconds at three,
and 92.3 seconds at five; five-step p95 reached 196.1 seconds. That supports
the Shortlist architecture, but it is not evidence that Soul must be separated
from musical preference.

## Agentic Leanings diagnostic

### Contract

The strengthened Agentic picker requires two structured diagnostic fields:

- `usedMusicalLeanings`: required boolean;
- `leaningsTieBreak`: required nullable string.

The model defaults to `false` and `null`. It may return `true` only when two or
more already-eligible tracks are a close fit and supplied Leanings genuinely
settle the choice. The trait must describe the selected track and directly
match the Leanings. Generic flow observations such as energy, pace, key, or
club feel are not valid evidence.

The controller retains a positive result only when Leanings were actually
supplied, the model explicitly returned true, and the tie-break is meaningful.
It normalises accepted private evidence to `Leanings: <trait>` and removes
unsupported Leanings wording from queue, Booth, and session diagnostics.
Listener-facing links remain isolated from it.

Relevant deployed commits:

- `1ad554ec feat(agent): require musical leanings tie-break evidence`
- `29a93583 feat(settings): make guest leanings opt-in`

### Frozen diagnostic harness

`controller/scripts/leanings-eval.ts --experiment leanings` invokes the
production Agentic schema, system prompt, reminder, and bounded tool loop with
isolated in-memory discovery fixtures. Candidate-specific expected traits stay
outside the model’s input.

The local 48-call confirmation produced 8/16 close-call declarations, 0/8
no-tie false positives, and 6/8 fixture-specific evidence matches. This is
below the provisional 80% grounding threshold. Its recurring failure mode was
an ordinary electronic-flow candidate claimed with generic `raw club energy`,
or with a trait copied from a different fixture. The local model can produce a
useful compact diagnostic, but positive claims remain less dependable.

The identical cloud run on `gpt-5.4-mini` completed 48/48 with zero failures:

- 7/16 close-call declarations;
- 0/8 no-tie false positives;
- 7/7 accepted declarations with fixture-specific evidence;
- 6/7 declarations coincided with a changed control/Leanings choice, one did
  not.

The cloud model was conservative—an absent marker does not show Leanings were
ignored—but its positive claims meet the current grounding check. Neither
result changes the diagnostic’s meaning: it is evidence of a structured model
claim, not counterfactual proof.

## Live Agentic smoke observations

The strengthened contract is running on the development station. One-hour
samples produced the following retained badges:

| Model | Evidenced `LEANINGS` badges | Rate |
| --- | ---: | ---: |
| `gpt-5.4-mini` | 4 / 17 | 23.5% |
| Local Meta Llama 3.1 8B Q5_K_M | 6 / 15 | 40.0% |

These are early operational diagnostic rates, not a comparison of musical
influence, quality, or model capability. They show that both configurations
can produce retained Agentic declarations in live broadcast conditions. The
cloud example selected Eurythmics — “Conditioned Soul” after a three-tool,
two-step run and retained `warm vocal and melodic hook` as the tie-break.

## Guest Leanings policy

Guest Leanings are now explicitly optional. The station-level **Guest Musical
Leanings** control belongs in **Settings → Music Selection** and defaults to
off. The runtime gate means a blank host field produces no Leanings input at
all unless an operator has opted into the weaker, occasional guest nudge.

Guests never contribute their Soul to music selection, never outrank the
on-air host, and never override flow or hard selection rules. This is a
secondary extension, not the principal justification for host Leanings.

The shared safe-off setting, persistence, and runtime gate are in #1678 at
`1bd1160e`. The Settings → Music Selection UI comes from the Shortlist-era
settings surface and is part of the companion #1687 delivery.

## Track Shortlist status and required parity work

PR #1687 now has the same operator-facing Leanings contract as the strengthened
Agentic path. It resolves host and guest context through the shared
`personaMusicLeanings()` and `guestEditorialNudge()` helpers, so the
station-level guest opt-in is honoured rather than bypassed by a local sampler.

The Shortlist response requires both `usedMusicalLeanings` and nullable
`leaningsTieBreak`. The controller accepts a positive result only when
Leanings were supplied, the model explicitly declares a close-call use, and it
provides a non-empty, non-generic tie-break trait. Generic flow claims such as
energy, pace, key, or club feel are rejected. An unaccepted result is stripped
of Leanings rhetoric before it reaches private Booth/session text.

The final-track guard applies this decision after any corrective re-pick. An
accepted trait is normalised to `Leanings: <trait>`, retained in
`shortlistResolution` telemetry, and shown with the verified selection in
Debug. The `LEANINGS` badge now requires that accepted evidence rather than a
bare boolean or raw reason-text reference.

Focused Shortlist tests cover the required structured fields, missing and
generic evidence rejection, compact-trait normalisation, and private-note
scrubbing. `shortlist-runner` and controller type checking passed for the PR
and for the live-station adaptation. The live checkout contains the parity
commit `d2e7ec97`; no Docker rebuild is implied by this record.

The Shortlist Soul harness is now committed to #1687 as
`controller/scripts/shortlist-soul-eval.ts` (`npm run shortlist-soul-eval`).
It remains useful for aggregate calibration only and must not be used to
manufacture a live “Soul changed this pick” indicator.

## Release plan

Keep the work as two reviewable PRs and release them in the same window:

- #1678 — shared Musical Leanings policy, Agentic contract, diagnostic harness,
  and guest safe-off setting;
- #1687 — Track Shortlist contract parity and the Music Selection settings UI.

Merge #1678 first, then update #1687 from `develop` using a non-destructive
merge and rerun the parity checks against the merged source. This prevents a
route-dependent operator meaning for the `LEANINGS` marker.

## Reports and reproducibility

Investigation report output is under:

`/home/jaz666/leanings-eval-reports/`

Relevant reports include:

- `bob-shortlist-soul-null-calibration-llama-3.1-8b-cap8.json`
- `bob-agentic-soul-null-calibration-llama-3.1-8b-cap8.json`
- `agentic-leanings-diagnostic-gpt-5.4-mini-v1.json`

The local host-reachable llama.cpp endpoint is `http://127.0.0.1:8087`;
the configured model is `/models/Meta-Llama-3.1-8B-Instruct-Q5_K_M.gguf`.
Use the host endpoint from a terminal outside Docker. Long model evaluations
should be run by the station operator, not by Codex.

## Final wording for operators and reviewers

Use: “Musical Leanings applied” or “Leanings tie-break: `<trait>`.”

Do not use: “Leanings changed this pick” or “Soul changed this pick.”

The first is an honest statement of the controller-accepted picker diagnostic.
The latter two imply a counterfactual that the production path does not and
cannot establish per song.
