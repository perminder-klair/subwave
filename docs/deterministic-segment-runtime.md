# Deterministic Segment Runtime

This document records the first delivery step in the Segments/Skills
reassessment. It is a compatibility and runtime-simplification change, not the
new operator-facing Segments product.

## Purpose

Remove model-directed capability selection and `tool.mjs` execution from the
Segments/Skills runtime. Keep the existing direct, single-call behaviour as the
only runtime path.

The main DJ LLM still writes the listener-facing Segment and may decide that an
optional Segment is not worth airing. Code, rather than the model, selects the
capability, fetches its data and applies grounding rules.

## Why this comes first

Before this change, the `djAgentSegment` route had two behaviours behind
`llm.pickerAgent`:

- **Agentic path:** the model sees every eligible capability, chooses one,
  chooses whether to call its `tool.mjs`, and then decides whether to air.
- **Direct path:** code chooses one eligible capability, calls its data source
  once, rejects unusable grounded data before generation, then makes one
  structured LLM call.

The agentic path makes factual grounding and tool use conditional on a model
choice. The direct path already provides the intended safety and operational
shape: deterministic capability selection, source data available before writing
and one bounded generation call.

This implementation removes the agentic route for both solo and co-hosted
Segments. The focused test coverage keeps `llm.pickerAgent` enabled to prove
that it no longer changes Segment execution.

## Target flow

```text
station and show state + on-air context
                    ↓
  native eligibility, cadence and capability selection
                    ↓
       direct source/provider fetch (once, bounded)
                    ↓
grounding and availability policy: candidate or stand-down
                    ↓
 one structured DJ LLM call: write the Segment or stay silent
                    ↓
       queue, TTS and existing broadcast placement
```

## Scope of the first PR

- Make the existing direct Segment path the sole path for automatic Segments.
- Make forced runs use the same direct-fetch model:
  - admin/manual `Run now`;
  - per-Skill cron timers;
  - programme feature runs.
- Remove the `djAgentSegment` tool-loop definitions and their model-callable
  `tool.mjs` wrappers from the Skills runtime.
- Preserve the current direct-path capability selection:
  - changed Weather first;
  - otherwise least recently aired eligible capability, random only on ties.
- Preserve existing direct-path source handling:
  - one direct fetch using default inputs;
  - bounded provider timeout;
  - grounded unavailable/error results stand down before an LLM call;
  - autonomous unavailable-source retry backoff.
- Preserve one structured generation call for a selected, usable capability.
- Preserve current queueing, TTS, sound-effect validation, cooldown, dedup and
  broadcast-placement behaviour.

## Explicit non-goals

This PR must not:

- redesign the admin Skills UI or rename it to Segments;
- change the `SKILL.md` or `tool.mjs` package contract;
- migrate or delete installed Skills or their state;
- introduce new Segment types, providers, cast/scenes, narrative context or
  external-audio support;
- remove `llm.pickerAgent` from music picking, where it remains an independent
  concern;
- alter station scheduling policy, voice placement, TTS or the audio mixer.

## Compatibility contract

Existing Skills continue to load and run unchanged from the operator's point of
view. `tool.mjs` remains supported, but it is called by the controller before
generation rather than offered to the model as a tool.

The intentional behavioural change for stations currently using
`llm.pickerAgent` is that a Segment's capability and data collection are no
longer model-directed. The direct-path policy becomes universal.

## Acceptance checks

Before submitting the PR, verify that:

1. Automatic Segments do not branch on `llm.pickerAgent`.
2. A selected `tool.mjs` is fetched directly once; the model is not given a
   capability tool loop.
3. A grounded `{ available: false }` or `{ error }` result produces a recorded
   stand-down and no LLM call.
4. An optional Segment with usable data can still return `air: false`.
5. Manual, cron and programme runs preserve their current forced/grounded
   semantics while using direct fetches.
6. `llm.pickerAgent` continues to affect music picking only.
7. Existing Skills, their frontmatter, state and public routes remain
   compatible.
8. Affected unit tests, type checks and the existing verification suite pass.

## Delivery status

Implemented on `deterministic-segment-runtime`:

- automatic, forced and co-hosted Segments now all fetch source data in code;
- `djAgentSegment` and the Segment model-tool wrappers have been removed;
- existing `tool.mjs` packages still receive the same context, state, services,
  frontmatter configuration and default input object;
- `llm.pickerAgent` remains available for music picking only.

## Follow-on work

Only after this compatibility PR is merged:

1. Collect and classify remaining advanced `tool.mjs` examples from the
   community.
2. Publish the user-facing Segments/Skills product model.
3. Define provider and migration compatibility for existing packages.
4. Implement native Segment formats incrementally, starting with simple
   Moments and source-backed Editorial Updates.

Likely later formats include running show formats (such as Hot Topic), Cast and
Scene segments, pre-produced Audio Segments, and separately scoped Show
Context/narrative seeds. They are deliberately outside this first PR.
