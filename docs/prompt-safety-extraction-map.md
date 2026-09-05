# Prompt safety and Verified Facts: extraction map

This branch starts from upstream `develop` and deliberately does not carry the Producer Routing or FunctionGemma architecture forward. This map identifies reusable evidence and the boundaries for a prompt-safety PR.

## Scope

The main DJ LLM remains responsible for listener-facing track links. This work improves prompt inputs and protects the handoff to TTS. It does not add a Producer model, FunctionGemma, segment/skill routing, or native shortlisting.

```text
Selection and operational context
                    ↓
  deterministic approved on-air fact plan
                    ↓
  DJ writer: persona + house rules + approved plan only
                    ↓
             validation / TTS only
```

## Source inventory

The reference range is the work after merge-base `65c840ee` on `codex/producer-routing`. It is evidence, not a cherry-pick queue.

| Source | Classification | Reuse decision |
| --- | --- | --- |
| `308a1823` / `443aeae7` — `docs/internals/verifiedContext.md` | Design evidence | Reuse the distinction between verified facts, editorial hooks and audio observations. Turn it into a concise runtime contract; do not depend on a Producer handoff. |
| `a5397626` — `controller/src/llm/internal/prompts/sleeve-notes.ts` | Prompt grounding | Reimplement/adapt. Its track album, resolved era year and station-play count are deterministic sources available after selection. |
| `7d62be95` — label sleeve notes as verified facts | Prompt grounding | Reuse the clear “Verified facts” label and explicit assertion boundary. |
| `22b41387` — vary verified sleeve notes | Prompt grounding | Consider after the basic contract works. A sparse selected fact set is preferable to a metadata dump; selection must remain deterministic/testable. |
| `a5397626` — `personaLinkPrompt` / `generatePersonaLink` | Mixed | Do not transplant. It is attached to the Producer/Persona Stage C path, new LLM kinds and Producer wiring. Rebuild the useful boundary in vanilla’s main-DJ link path. |
| `5ad7ba71` — persona handover prompts | Mixed | Do not include in the first PR. It improves prompt isolation but changes programme/handoff behaviour and can be assessed later as a separate slice. |
| `8cff67d4`, `3c3284ec`, `3cb8fe12` — evidence-backed segments | Segment/skill routing | On hold. These changes live in the skill-agent/Producer path and are outside this PR. |
| `a5397626`, `bd10ed15`, `55c22368` — Musical Leanings schema/UI | Track selection | Exclude. It is an editorial selection input, not prompt safety or Verified Facts. |
| Producer settings, agent factory, provider legs, contracts, benchmarks and routing tests | Producer Routing / FunctionGemma | Exclude. |

## First implementation slice

1. Identify vanilla’s single listener-facing link generation and its TTS enqueue point.
2. Add a small deterministic verified-facts builder beside the existing prompt code. Start with title/artist, album, resolved era year and station-play count only when available and trustworthy.
3. Feed a bounded selection to the main DJ prompt under `Verified facts`. State that no further externally verifiable claims may be inferred.
4. Keep prompt instructions and facts separate from the model’s speech field. Only validated listener-facing text may be queued to TTS.
5. Add focused tests for fact construction, absent/untrusted data, prompt shape, and the invariant that control-plane material is not passed as speech.

## Acceptance criteria

- The normal main-DJ link path receives a small verified-fact packet without a Producer or FunctionGemma call.
- Facts derive from existing controller/library state and include no model reasoning or tool transcript.
- TTS receives only the dedicated listener-facing output after validation.
- Existing behaviour remains when no verified facts are available.

## Deferred decisions

- Exact structured response schema and the output validator’s rejection or repair posture.
- Whether handovers and skill segments should adopt the same boundary later.
- Additional facts such as artist history, selection intent, audio observations, weather or programme context; each needs an explicit source and assertion policy.
- How the prompt-only PR will be extracted from any already-completed source changes; this branch favours a clean vanilla implementation.

## Implemented split: selection from listener speech

The existing link-generation function combines internal selection/operational
context with persona instructions and asks one model call to produce the final
spoken line. That is no longer an acceptable safety boundary: different models
can treat even a lightly worded mood, energy, scheduling or tool hint as
creative material and repeat or imply it on air.

Split it into two explicit stages:

1. **Approved on-air fact plan.** After a track is selected, controller code
   builds the bounded Verified Facts packet and selects the
   allowed on-air facts from it. This stage may use selection context, but produces no
   speech.
2. **DJ writer.** The existing main DJ writing call receives only the approved
   fact plan, the required length, safe anti-repeat material, and its persona
   / house rules. It must never receive selection mood, energy, tempo, key,
   journey, ranking, candidate lists, show steering, or operational context.

This prevents *prompt-context leakage*: a model cannot turn private selection
cues into a listener-facing claim if those cues are absent from its prompt. It
does not make a language model factually infallible, so validation remains
between the writer and TTS.

The session DJ agent now returns only its selected track, internal reason and
transition decision. The controller then calls the normal main-DJ link writer
with the selected track and its bounded Verified Facts packet. This adds one
writer call to an agent-picked link, so its latency and allowance use must be
measured separately.

## Handoff status — 2026-09-05

This branch is ready for continued observation and refinement.

- The prompt-safety / Verified Facts PR is
  [perminder-klair/subwave#1542](https://github.com/perminder-klair/subwave/pull/1542),
  from `feat/prompt-safety-verified-facts`.
- The deployed live-station checkout is `/home/jaz666/Docker/subwave`, on
  `test-station/vanilla-debug-handoffs-prompt-safety-live`. It contains the
  existing station-test work plus these prompt-safety commits:
  `6de45bb2` (final-quarter following-show context), `a91fcbaa` (station
  history sleeve notes), and `2a1533cd` (stale link-context cleanup).
- The controller was rebuilt and restarted after those commits, and its Docker
  health check passed. Focused verified-facts and show-handover tests plus
  TypeScript type-checking passed before deployment.
- Do not reset, clean, or overwrite the live checkout: it deliberately retains
  an unrelated modified `.dockerignore` and untracked
  `controller/scripts/functiongemma/` work from other live-station testing.

### What to observe next

1. In the final 15 minutes, confirm that a following-show cue is occasional
   rather than absent or repeated. The cue is optional model material, while
   the timing/context constraint is deterministic.
2. Confirm station-history notes are sparse: a first-ever station play may be
   mentioned only when the library index is readable, and a return is eligible
   only for one or two prior plays at least 30 days ago. They deliberately
   compete with other sleeve-note facts, so no mention on a given link is
   expected.
3. Keep the current scope separate from the parallel architecture work:
   native track shortlisting, handoff timing, and future native segment/skill
   routing. The former Producer Routing design remains reference material only;
   it is not part of the live station architecture or a porting target.
