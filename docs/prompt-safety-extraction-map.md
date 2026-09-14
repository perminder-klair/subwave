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

## Handoff status — 2026-09-07

### Extended Sleeve Notes reservation

`settings.djBehaviour.extendedSleeveNotes` is persisted and defaults to `false`.
The DJ Behaviour panel deliberately presents it only as a Coming Soon card.
It is reserved for the future API-backed feature and does not yet affect the
prompt. The default link path now carries up to two deterministic supplemental
Sleeve Notes, in priority order, so a trusted album and release year can travel
together without admitting show steering or other editorial context.

Release-year mentions are independently configurable under DJ Behaviour → Link
Style. The year remains a verified library fact; `occasional` and `rare` use a
deterministic per-link gate to omit it from the writer packet on most links,
without permitting the model to invent it.

### Natural show-close and TTS cue safety follow-up

Final-quarter-hour context now says that the current show is approaching its
scheduled close and names the following show. It explicitly forbids remaining
minutes and fractional-progress phrasing, while retaining a natural optional
handover acknowledgement. The TTS sanitation regression set also rejects
gerund production cues such as `[pausing briefly]` and malformed leading-hyphen
cues such as `[-whispering]`; ordinary delivery cues remain allowed.

This branch is rebased on upstream `develop` at `dbcf8a0a` and is ready for
continued live observation.

- The draft prompt-safety / Verified Facts PR is
  [perminder-klair/subwave#1633](https://github.com/perminder-klair/subwave/pull/1633),
  from `Jaz666:feat/prompt-safety-verified-facts`. It remains a draft while
  live speech logs are assessed.
- Branch HEAD is `744fae45` (`fix(tts): normalize unsafe punctuation and
  production cues`). It adds a conservative controller-side replacement for
  the former Fish proxy sanitation: invisible characters, Markdown links and
  HTML are cleaned; malformed, closing, trailing and production-style bracket
  cues are removed; numeric dash ranges speak as “to”; ordinary sentence
  dashes and ellipses are preserved for natural Fish pacing.
- The deployed live-station checkout is `/home/jaz666/Docker/subwave`, on
  `test-station/active-branches-v1.13`, at `6adc8045`. It was rebased onto the
  same upstream `develop`, preserving the Track Shortlisting and debug-feature
  integrations, then rebuilt. The controller health endpoint reports `on-air`.
- Do not reset, clean, or overwrite the live checkout: it deliberately retains
  an unrelated modified `.dockerignore`.
- The live station uses `Four Acres FM Prompt v6 — safety test` plus tightened
  House Rules. The full factual-grounding rule is in both places because the
  scripted path receives the System Prompt while agent-written speech receives
  House Rules. No restart was required for that settings update.

### Validation completed

- `speech-text`, `verified-facts`, `agent-say-boundary`, `link-style`, and
  `persona-engine-seams` tests pass.
- The live integration also passed `shortlist-runner`,
  `shortlist-presentation`, `shortlist-context-window`, `stats-debug`,
  `dj-speech-log`, and TypeScript type checking after the rebase.

### What to observe next

1. Review ordinary DJ links, IDs, hourly checks, handoffs and banter only.
   Ignore paused segment/skill content (sponsor spots, mailbag, deep cuts and
   programme features).
2. The DJ Speech log uses UTC. The Prompt v6 / first House Rules change took
   effect at 15:12 BST, recorded as 14:12 UTC on 2026-09-07. The later House
   Rules expansion and controller sanitation deployment should each be treated
   as separate comparison boundaries.
3. On the TTS test interface, confirm that valid delivery cues such as
   `[softly]` remain, while production directions such as `[fade out vocals]`,
   `[0s]` and malformed brackets are removed. Confirm em dashes still create
   the desired natural pause.
4. Once the live outputs are satisfactory, push any final branch commits to
   the fork, update draft PR #1633, and mark it ready for review. Keep native
   Track Shortlisting, debug features and segment/skill work outside this PR.
