---
name: subwave-llm-bench
description: >-
  Benchmark and compare LLM models for SUB/WAVE's on-air calls — track picks,
  segments, listener requests, DJ scripts, banter, and programme beats — in
  both candidate-pool and agent modes, using controller/scripts/llm-bench (the
  matrix harness) or the legacy picker-only controller/scripts/picker-test.mjs.
  Use this skill whenever the user wants to assess, benchmark, compare, or test
  which LLM model to run the station on — phrases like "which model should I
  use", "benchmark the picker / the DJ / this model", "test these models", "is
  <model> good enough for the radio", "compare the ollama models", "will a
  small model work", "run llm-bench", "run picker-test", or when diagnosing
  slow/failing djAgentPick / djAgentSegment / generate* calls and the model
  choice is suspect. Trigger it even if the user doesn't name a harness — any
  request to evaluate model reliability or choose a model for SUB/WAVE belongs
  here. This skill only measures and recommends; it does NOT change the live
  station's configured model.
---

# SUB/WAVE LLM model benchmark

Two harnesses, one job: measure how well a **provider + model** handles the
station's real LLM calls before trusting it on air.

- **`llm-bench`** (`controller/scripts/llm-bench/`, `npm run llm-bench`) — the
  primary harness. A matrix runner over **every on-air call kind**: pool picks
  (`pickNextTrack`), agent picks (`djAgentPick`), pool + agent segments
  (`generateSegment` / `djAgentSegment`), request matching (`matchRequest` /
  `djAgentRequest`), the free-text scripts (intro, link, station ID, hourly),
  banter, and the programme family (plan, beats, exchanges). Scores
  reliability + deterministic rule checks, prints a per-model comparison
  table, writes a diffable JSON report.
- **`picker-test.mjs`** — the legacy picker-only deep-dive. Still useful for
  high-iteration picker runs comparable with historical results, and it has a
  bundled orchestration script (see the legacy section at the end).

Both import the **live prompts and schemas from `src/`** (never copies), fake
everything external (library, tools, weather/news data), and override
provider/model **only inside their own short-lived process** — the live
controller's configured model is never touched.

## The two things that surprise people

1. **Routing matters as much as the model.** The *same* model can pass through
   one provider and fail through another, because each `@ai-sdk/*` provider
   translates tools / structured output differently. Canonical case:
   `deepseek-v4-flash` scored **0/4 via the `deepseek` direct provider** but
   **4/4 via `openrouter`**. Always benchmark through the routing you'll
   actually deploy — "is model X good?" is the wrong question; "is
   provider+X good?" is the right one.
2. **The stress scenarios are where truth lives.** Easy cells make every model
   look fine. The verdict cells are: `djAgentPick/long-context` (full prompt +
   tool loop), `generateSegment/dull-weather` (the model must *decline* to air
   — small models botch the silence encoding; a huge wall-clock here means the
   structured-output retry rescued a failed first attempt), and the
   multi-voice JSON kinds (`generateBanter`, `generateProgrammeExchange`).

## When NOT to use this

- Changing the live model — that's an admin Settings change, not this skill.
- Diagnosing general runtime behaviour — `subwave-log-analysis`.
- Starting/stopping the stack — `subwave-control`.

## Running llm-bench

Runs on the **host from a repo clone** (it imports TS source via `tsx`; prod
containers ship only compiled `dist/`). The running stack is not required —
keys resolve from `state/secrets.env` and `controller/.env` automatically
(existing env vars win). If a key exists only inside a prod container's env,
copy it out first: `export OPENROUTER_API_KEY=$(docker exec sub-wave-controller printenv OPENROUTER_API_KEY)`.

```bash
cd <repo>/controller
npm run llm-bench -- \
  --models openrouter:google/gemma-4-31b-it,ollama:qwen3:8b \
  --iterations 3
```

Flags:

- `--models` (required) — comma list of `provider:model`, split on the FIRST
  colon, so Ollama tags keep theirs (`ollama:qwen3:8b`). Providers: ollama |
  openai-compatible | anthropic | openai | google | deepseek | openrouter |
  requesty | gateway.
- `--kinds` — groups (`pick,segment,request,scripts,banter,programme`) or
  exact kind names. Default: all.
- `--modes` — `pool,agent` (default both). Mode-independent kinds run once
  either way. **If the operator runs pool mode live (Agentic picker off),
  `--modes pool` is the honest benchmark** — agent cells they'll never use
  just add noise and cost.
- `--iterations` — per scenario. 1 to smoke, 3 to screen (default), 5+ to
  confirm a winner. Full matrix ≈ 32 scenario cells, so ~100 calls per model
  at 3 iterations.
- `--out` — report path (default `scripts/llm-bench/reports/<ts>.json`,
  gitignored).

A full run takes many minutes (every call is a real model call, agent cells
can take 45 s each). Run it in the background with a long timeout and don't
poll; `OLLAMA_URL=http://localhost:11434` translates the container-internal
Ollama address for host runs.

## Reading llm-bench results

Each run is `ok`, `violation` (call succeeded, named rule checks failed), or
`thrown` (bucketed: `no-object-generated`, `timeout`, `unreachable`,
`thrown`). The summary prints pass% + p50 latency per cell, then per-model
histograms of rule failures and thrown buckets.

Judge in this order:

1. **Thrown rate** — a model that can't produce the schema at all is out.
   `no-object-generated` on structured kinds = weak structured output;
   everything landing at ~45 s = too slow for the loop, not incapable.
   `unreachable` = provider/config problem, not the model — fix and re-run.
2. **Violations** — the named rules tell you the failure *character*:
   `hallucinated-id` (invents track ids — dangerous), `banned-phrase:*` /
   `stage-direction:*` / `wrapping-quotes` (would be read aloud by TTS),
   `digits-in-spoken-time` / `clock-leak` (hourly/link discipline),
   `opener-repeat` (ignores anti-repeat lists), `unusable-exchange` /
   `single-voice` (can't hold multi-voice JSON), `variety:same-artist`
   (editorial-pressure miss — informative, not disqualifying).
3. **Latency** — p50 per cell; a pick has a whole track of slack so even 20 s
   works, but segments and links air sooner. Watch for retry-rescued cells
   (pass with 100×-median wall clock).
4. **Pool vs agent gap** — a model that's clean in pool cells but falls apart
   in agent cells is a "candidate pool" model; that's a valid deployment, just
   say so in the recommendation.

Reports are JSON with every run record — keep old ones to diff a model across
prompt changes or across model updates.

## Producing the recommendation

1. A compact table: one row per provider+model, columns for thrown rate,
   violation rate, p50 latency, and the dominant failure.
2. A clear call naming the best **provider + model + mode** ("gemma via
   OpenRouter, pool mode — clean structured output, agent cells time out").
3. Call out disqualifiers and deferrals (5xx throughout = re-test later).

Do **not** apply the change. The operator sets `llm.provider` + `llm.model`
(and the Agentic picker toggle) in admin Settings — those are global, their
call.

## Legacy: picker-test.mjs deep-dive

For picker-only, high-iteration runs comparable with historical results:

```bash
# DEV stack (src bind-mounted in container):
docker exec sub-wave-controller npx tsx scripts/picker-test.mjs <provider> <model> [iterations] [short|long]
# Host (works regardless of stack):
( cd <repo>/controller && STATE_DIR=<repo>/state OLLAMA_URL=http://localhost:11434 \
  npx tsx scripts/picker-test.mjs <provider> <model> [iterations] [short|long] )
```

`long` is the verdict mode (realistic session window); `short` is a sanity
check. The bundled `scripts/assess-models.sh` (in this skill's directory) runs
one or more models in both modes, auto-detects dev/prod, and summarises event-
log failures: `assess-models.sh <provider> [iterations] <model>...` — with
`ollama` and no models it discovers and tests everything installed.

Failure strings glossary (from the event log, `kind: pickerTest`):

- `agent did not call the done tool before stopping` — model ignored the
  tool protocol. Check routing before rejecting the model (see surprise #1).
- Every failure at ~`agentTimeoutMs` (45000) with `tools=0` — a latency
  failure, not incapability; the deadline aborted it mid-loop.
- `Failed after N attempts … Internal Server Error` — provider outage;
  re-run later, don't reject the model on this.
- `hallucinated-id` / `no-object-generated` — weak structured output.

Cross-check live behaviour in `/admin/debug` → `llm.recentCalls`: the `via`
field shows which path produced each result (`ai-sdk:agent:native` = clean
native path; `…:recovery` = rescued by the done-tool recovery; a thrown
`djAgentPick` falls back to the pool picker, so the station never goes
silent).

## Notes

- Both harnesses append telemetry rows to the controller event log
  (`state/logs/events-*.jsonl`) and, if `LLM_DEBUG_RAW` is on, raw request
  bodies to `state/logs/llm-debug.log`. Harmless, filterable.
- The docs page mapping every call kind to its code lives at
  `docs/llm-calls.md`; the harness design spec at
  `docs/superpowers/specs/2026-07-09-llm-bench-design.md`.
