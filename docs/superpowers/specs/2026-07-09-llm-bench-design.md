# LLM call benchmark harness (`llm-bench`) — design

**Date:** 2026-07-09
**Status:** draft for review

## Goal

One command that answers: *"will model X run this station well?"* — across every
on-air-critical LLM call kind, in both picker modes (candidate pool / agent), with
objective pass/fail scoring, so small and big models can be compared on the same table.

Decisions taken during brainstorm:

- **Scoring:** reliability + deterministic rule checks only. No LLM judge in v1 (kept as a v2 hook).
- **Run shape:** one matrix runner — N models × kinds × scenarios × modes → comparison table + JSON report.
- **Coverage:** on-air critical path **plus** programme/banter (multi-voice JSON is exactly where small
  models struggle). Admin generators (`generatePersona/Show/Theme`), `tag-library`, `doctor:review` are v2.

## Approaches considered

1. **Family of per-kind scripts** (clone `picker-test.mjs` per kind). Quick single runs, but ~16 copies
   of the settings/report boilerplate and cross-model comparison stays manual.
2. **Unified matrix runner over per-kind modules** — one CLI, one fixture set, one report; each kind is a
   small module declaring its scenarios and checks. **Chosen.**
3. **Live-station probing** (fire real endpoints, read telemetry). Most realistic, but slow,
   non-deterministic, pollutes the live session/queue, and can't isolate scenarios.

The chosen approach is `picker-test.mjs`'s proven pattern, generalised: import **live prompt builders and
schemas from `src/`** (never copies — prompt changes flow into the bench automatically), synthetic
fixtures for everything external (library, tools, weather/news data), and an in-memory
`settings.llm` override per model under test. No live station, no Navidrome, no state writes.

## Architecture

New directory `controller/scripts/llm-bench/`, run from a clone on the host (like `picker-test.mjs`):

```
controller/scripts/llm-bench/
  cli.ts        arg parsing, matrix loop, per-model settings override, SIGINT-safe
  kinds/        one module per call kind (the KindSpec interface below)
    pick-pool.ts  pick-agent.ts  segment-pool.ts  segment-agent.ts
    request.ts  scripts.ts  banter.ts  programme.ts
  fixtures.ts   synthetic library/candidates/personas/cast/shows/context/session turns/
                segment data payloads (weather, news)/sfx catalogue
  rules.ts      shared free-text rule checks (pure — unit-pinned)
  report.ts     console tables + JSON report writer
```

`npm run llm-bench` (tsx) added to `controller/package.json`.

### KindSpec interface

```ts
interface KindSpec {
  kind: string;                       // telemetry kind it exercises, e.g. 'pickNextTrack'
  group: string;                      // CLI filter group: pick|segment|request|scripts|programme|banter
  mode: 'pool' | 'agent' | 'any';     // which picker mode this kind represents ('any' = mode-independent)
  scenarios: Scenario[];
}

interface Scenario {
  name: string;                                    // e.g. 'analysed-candidates'
  run(fx: Fixtures): Promise<unknown>;             // makes the live-barrel call with fixture inputs
  check(out: unknown, fx: Fixtures): string[];     // rule violations; empty array = pass
}
```

A run outcome is one of: `ok`, `violation` (call succeeded, checks failed — violations listed), or
`thrown` (bucketed like picker-test: `no-object-generated`, `timeout`, `unreachable`, `thrown`).

### Kinds and scenarios (v1)

| Kind | Mode | Scenarios | Checks beyond schema validity |
|---|---|---|---|
| `pickNextTrack` | pool | baseline-10; analysed-candidates (bpm/key/pace present); same-artist-trap (9 of 10 same artist); big-pool-18 | picked `id` ∈ candidates; `transition` ∈ enum ∪ null; same-artist-trap: picked artist ≠ trap artist |
| `djAgentPick` | agent | short-context; long-context (ports `picker-test.mjs`'s two message modes) | `id` ∈ tool-surfaced songs (`seen`); not hallucinated; tool/step counts recorded |
| `generateSegment` | pool | fresh-weather; dull-data (unchanged weather — `air:false` is a pass); news-payload; sfx-offered | `air:true` ⇒ non-empty `text` passing text rules; `sfx` ∈ offered catalogue ∪ null |
| `djAgentSegment` | agent | autonomous (silence allowed); forced (text mandatory) | segment `kind` ∈ offered caps; forced ⇒ non-empty text; sfx validity |
| `matchRequest` | any | exact-hit; fuzzy-hit ("play that snoop song"); no-match (must not force a pick) | returned id ∈ candidates or an honest no-match; no hallucinated id |
| `djAgentRequest` | agent | exact-hit; fuzzy-hit | same as above via tools; ack text passes text rules |
| `generateIntro` | any | normal; with-recap-and-openers | text rules; opener differs from every `recentOpeners` entry |
| `generateLink` | any | normal; with-recap-and-openers | same |
| `generateStationId` | any | normal | text rules |
| `generateHourlyTime` | any | afternoon; just-past-hour | text rules; **no digits / 24-hour forms** in the spoken line |
| `generateBanter` | any | host+2-guests | every `speaker` ∈ cast ids; ≥ 2 distinct speakers; line count within MIN/MAX_EXCHANGE_LINES; each line passes text rules |
| `generateProgrammePlan` | any | 2-hour show; 3-hour show | one feature topic per hour; non-empty angle/topics |
| `generateProgrammeIntro` / `Outro` / `Feature` | any | with-plan | text rules |
| `generateProgrammeExchange` | any | intro-beat; outro-beat | cast validity + line bounds (same as banter) |

Mode semantics: `--modes pool,agent` filters which kinds run. `any` kinds run once regardless of the
modes flag (they behave identically in both) — they are *not* run twice.

### Shared text rules (`rules.ts`)

Derived from the hard rules in `djSystem` and the schema descriptions — all deterministic:

- non-empty after trim
- banned tells: "and now", "next up", "coming up next" (case-insensitive)
- no stage directions/markup: `*asterisks*`, `[bracketed actions]` (except chatterbox tags — not
  applicable here since the bench never sets engine chatterbox), no surrounding quotes, no emoji
- sentence budget: ≤ 4 sentences at default `scriptLength` (bounds read from `lengthMode()` so a
  persona fixture change flows through)
- hourly only: no `\d` digits, no `HH:MM` forms
- opener anti-repeat: first 4 words must not match any provided recent opener (case-folded)

Rule identifiers (e.g. `banned-phrase:next up`, `opener-repeat`, `digits-in-hourly`) appear in the
report so a model's characteristic failures are visible, not just counted.

### Scoring & report

Per run record: `{model, mode, kind, scenario, iteration, outcome, violations[], ms, tokens, error?}`.
Tokens and provider-reported latency are read from `recentCalls()` (`llm/log.js`) after each call —
the same telemetry the live station records, no new plumbing.

- **Console:** one table per group — models as columns, `kind/scenario` as rows, cells `pass% (p50 s)`;
  then a violations summary per model (top rule failures with counts) and a thrown-error summary.
- **JSON:** every run record, written incrementally (SIGINT-safe) to `--out`
  (default `controller/scripts/llm-bench/reports/<iso-timestamp>.json`, directory gitignored).
  Reports are diffable across runs for regression tracking.

### CLI

```
npm run llm-bench -- \
  --models ollama:qwen3:8b,openrouter:google/gemma-4-31b-it \
  --kinds pick,segment,scripts \        # groups or exact kind names; default: all v1 kinds
  --modes pool,agent \                  # default: both
  --iterations 3 \                      # per scenario; default 3
  --out my-report.json
```

- Model spec is `provider:model`, split on the **first** colon (ollama tags like `qwen3:8b` keep theirs).
- Provider API keys resolve exactly as live: `state/secrets.env` / settings / env. `OLLAMA_URL` env
  override honoured (picker-test precedent).
- A model whose provider is unreachable fails fast: its remaining cells are marked `skipped` and the
  matrix continues with the other models.
- Rough cost: v1 full matrix ≈ 30 scenario-cells × 3 iterations ≈ **90–100 calls per model**; most are
  small (< 1k tokens in, < 200 out).

### Touch points in `src/` (all additive, no behaviour change)

- `skills/_agent.ts`: export `simpleSystem`, `simpleSegmentSchema`, `dataBlock`, `buildSituation` for
  the bench — same precedent as `dj-agent.ts` exporting `pickSystem`/`pickSchema` for `picker-test.mjs`.
- `broadcast/programme.ts` constants (`MIN/MAX_EXCHANGE_LINES`) exported if not already reachable.
- `controller/package.json`: `"llm-bench": "tsx scripts/llm-bench/cli.ts"`.

### Error handling

- Per-call ceilings = live defaults (`agentTimeoutMs` for agent kinds; `djObject`'s built-in
  retry/deadline for the rest) so bench numbers reflect what the station would experience.
- A thrown call never aborts the matrix; it becomes a `thrown` record with its bucket.
- Settings are loaded once, mutated in-memory per model — never persisted (no `settings.update()`).

### Testing

- `rules.ts` is pure → pinned by `scripts/llm-bench-rules.test.ts`, registered in `run-tests.ts`.
- Fixture/schema drift is caught by the harness itself importing live builders — if a prompt module's
  signature changes, `tsc --noEmit` (the lint gate) fails the bench file.

## Non-goals (v1)

- LLM-judged quality scoring — v2 hook: a `judge.ts` stage over the JSON report, so it can even be run
  retroactively on old reports.
- Admin generators, `tag-library`, `doctor:review` kinds.
- TTS, audio, live-station integration.
- Replacing `picker-test.mjs` — it stays untouched (the `subwave-llm-bench` skill covers both harnesses);
  retire it later only once `djAgentPick` bench results prove equivalent.

## Relationship to existing tooling

- `picker-test.mjs`: pattern donor (settings override, synthetic tools, failure buckets). Its two
  message modes become `djAgentPick`'s two scenarios.
- `run-tests.ts` suite: unchanged; only gains the pure rules test.
- `docs/llm-calls.md`: gains a line pointing to the bench once it lands.
