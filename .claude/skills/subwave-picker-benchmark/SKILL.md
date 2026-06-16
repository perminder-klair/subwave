---
name: subwave-picker-benchmark
description: >-
  Benchmark and compare LLM models for the SUB/WAVE DJ picker agent using
  controller/scripts/picker-test.mjs. Use this skill whenever the user wants to
  assess, benchmark, compare, or test which LLM model to use for the picker /
  DJ agent — phrases like "which model should I use for the picker", "benchmark
  the picker", "test these models", "is <model> a good fit for the DJ agent",
  "compare the ollama models", "assess model reliability", "run picker-test", or
  is diagnosing slow / failing djAgentPick calls and suspects the model choice.
  Trigger it even if the user doesn't name the harness — any request to
  evaluate picker reliability or pick a model for SUB/WAVE belongs here. This
  skill only measures and recommends; it does NOT change the live station's
  configured model.
---

# SUB/WAVE picker model benchmark

The DJ picker agent (`djAgentPick`) runs a tool-loop: the model calls
music-discovery tools, then commits to a track. Its reliability depends on **how
well the chosen model follows the tool-calling protocol** — a model that ignores
the tools and answers with prose makes the picker fail.
`controller/scripts/picker-test.mjs` drives this exact path in isolation so you
can measure a model's fit before trusting it on air.

This skill runs that harness across candidate models and turns the raw output
into a comparison the operator can act on. It is **read-only**: the harness
overrides provider/model only inside its own short-lived process, so the live
controller's configured model is never touched.

## The two things that surprise people

Internalise these before benchmarking — they're the difference between a useful
result and a misleading one:

1. **Routing matters as much as the model.** The *same* model can pass through
   one provider and fail through another, because each `@ai-sdk/*` provider
   translates tools / structured-output differently. Real example: the same
   `deepseek-v4-flash` scored **0/4 via the `deepseek` direct provider** (its
   "responseFormat JSON schema injected into system message" mode makes the
   model emit JSON instead of calling tools) but **4/4 via `openrouter`**
   (`deepseek/deepseek-v4-flash`). So always benchmark a model **through the
   routing you'll actually deploy** — if you plan to run it via OpenRouter, test
   `openrouter <id>`, not the native provider. "Is model X good?" is the wrong
   question; "is provider+X good?" is the right one.

2. **`long` mode is where truth lives.** A toy prompt (few tools, short context)
   makes almost any model look fine. The live picker has the full DJ system
   prompt, ~13 rich discovery tools, and a ~30-turn session window. Weak models
   only fall apart under that load. Always run `long`; treat `short` as a sanity
   check, not evidence.

## When NOT to use this

- Changing the live model — that's a Settings/admin change, not this skill.
- Diagnosing the station's general runtime behaviour — that's
  `subwave-log-analysis`.
- Starting/stopping the stack — that's `subwave-control`.

## Prerequisites

The stack must be running (dev or prod) — even the host path below reads the
provider keys and the configured Ollama URL from the live container so the
benchmark matches deployed config. If it isn't up, hand off to `subwave-control`
to start it first. Check with:

```bash
docker ps --filter name=sub-wave-controller --format '{{.Names}} {{.Status}}'
```

## Where the harness runs — dev vs prod

This trips people up, so the bundled script handles it for you, but understand
why: the harness imports the controller's **TypeScript source** and must run
under `tsx` (plain `node` fails with `ERR_MODULE_NOT_FOUND` on `src/*.js`).

- **Dev stack** bind-mounts `controller/src` and runs `tsx`, so `src/` exists in
  the container → run it **inside the container**.
- **Prod stack** ships a built image with compiled `dist/` and **no `src/`** →
  an in-container run dies with `ERR_MODULE_NOT_FOUND: /app/src/settings.js`.
  There you run it **on the host** (the repo clone has the TS source), pointing
  `STATE_DIR` at `<repo>/state`, exporting the provider keys copied out of the
  container env, and translating the Ollama URL to a host-reachable address
  (`host.docker.internal` resolves only inside the container → use
  `http://localhost:11434`).

`scripts/assess-models.sh` auto-detects which case applies (it checks whether
`src/settings.js` exists in the container) and does the right thing. Prefer it.

## Quick start — the bundled script

`scripts/assess-models.sh` runs the harness for one or more models in **both**
`short` and `long` message modes, prints a comparison table, and summarises the
failure reasons it found in the event log. Derive the repo root from this
skill's own location so the script path is stable:

```bash
REPO=$(git -C "<this skill's base directory>" rev-parse --show-toplevel)
# Benchmark through the routing you'll deploy — e.g. OpenRouter:
bash "$REPO/.claude/skills/subwave-picker-benchmark/scripts/assess-models.sh" \
  openrouter 10 deepseek/deepseek-v4-flash google/gemini-3.5-flash
```

Arguments: `assess-models.sh <provider> [iterations] <model>...`

- `provider` — `ollama` | `openai-compatible` | `anthropic` | `openai` |
  `google` | `deepseek` | `openrouter` | `gateway`. **Pick the provider you'll
  actually deploy with** (see "Routing matters" above).
- `iterations` — runs per model per mode. Optional (default 10). **Use 8–10 to
  screen, 20+ to confirm a winner** — model calls are non-deterministic, so a
  small sample is noisy.
- `model...` — one or more model ids. If omitted and provider is `ollama`, the
  script discovers every model installed on the Ollama box and tests them all.

A full run can take many minutes (each iteration is a real model call). Run the
`Bash` tool with a long timeout, or in the background, and don't poll it.

## Manual invocation

The script is preferred, but to run one model by hand, match its dev/prod logic:

```bash
# DEV (src in container):
docker exec sub-wave-controller npx tsx scripts/picker-test.mjs <provider> <model> [iterations] [short|long]

# PROD (run on host; keys from the container, STATE_DIR + OLLAMA_URL set):
DS=$(docker exec sub-wave-controller printenv DEEPSEEK_API_KEY)
OR=$(docker exec sub-wave-controller printenv OPENROUTER_API_KEY)
( cd "$REPO/controller" && \
  STATE_DIR="$REPO/state" OLLAMA_URL=http://localhost:11434 \
  DEEPSEEK_API_KEY="$DS" OPENROUTER_API_KEY="$OR" \
  npx tsx scripts/picker-test.mjs <provider> <model> [iterations] [short|long] )
```

`short` = 3 clean turns (sterile baseline). `long` = a realistic session window.
Run **both** — `long` catches long-context regressions that `short` hides — and
treat `long` as the verdict.

## Reading the results

The harness prints per-iteration `OK`/`FAIL` lines and a summary:

```
=== summary ===
  success: 19/20 (95%)
  modes:   ok=19  thrown=1
  ms (ok): median=1824 p95=3641
  ms (fail): median=2741
  median tool calls per ok: 2
```

Judge models in this order:

1. **Success rate — the deciding metric.** The picker must reliably return a
   valid track. Below ~90% the model is a poor fit. There is a stateless pool
   picker behind every failure, so a failed pick degrades rather than breaks —
   but a model that fails often isn't doing the job it was chosen for.
2. **Latency.** A pick only has to finish before the current track ends
   (~3 min), so even ~20 s is functional — but faster is better, and a healthy
   model is usually well under 10 s. Compare `ms (ok)` medians; watch `p95` for
   models that are usually fast but occasionally stall.
3. **Failure modes.** A model can hit the same success rate for very different
   reasons — see the glossary below. The script pulls the actual error strings
   from the event log so you can tell a bad-fit model from a provider outage.
4. **`short` vs `long` parity.** A model that does well on `short` but drops on
   `long` is sensitive to session-context length — note it.

## Failure mode glossary

The harness `modes` line buckets failures; the real error strings come from the
event log (`kind: pickerTest`, `ok: false`). What each means:

- **`agent did not call the done tool before stopping`** (or native path
  "produced no usable pick — explored=false") — the model emitted an answer
  *without ever calling a discovery tool*. Usually a **model-fit problem** (the
  model ignores the tool-calling protocol) — BUT before concluding "bad model,"
  check whether it's actually a **routing problem**: if the same model fails this
  way through one provider but works through another, it's the provider's
  translation, not the model. The canonical case: `deepseek-v4-flash` fails
  0/4 via `deepseek` direct (always `tools=0`) but is 4/4 via `openrouter`.
  Re-test through OpenRouter before rejecting the model.
- **Every failure lands at ~the same `ms` (≈ `agentTimeoutMs`, default 45000)** —
  e.g. all runs show `45004ms thrown` with `tools=0`. This is a **latency
  failure, not incapability**: the model exceeded the deadline mid-loop and was
  aborted (`withDeadline`). The model *can* do the task, it's just too slow for a
  live picker (observed on `kimi-k2.6:cloud` + long context). Raising
  `settings.llm.agentTimeoutMs` would "fix" the score but a >45 s picker is a bad
  trade — prefer a faster model.
- **`Failed after N attempts. Last error: Internal Server Error`** — the
  provider returned HTTP 5xx. A **provider-side outage**, transient — not the
  model's fault. Re-run later; don't reject a model on this alone.
- **`hallucinated-id` / `no-object-generated`** — the model returned an id not
  in any tool result, or output the SDK couldn't parse into the pick schema.
  Both indicate weak structured-output / instruction-following.

### Cross-check against the LIVE picker via `/admin/debug`

The harness reports a `mode` (`ok` / `thrown`); the live controller additionally
records a `via` on each `djAgentPick` call in `/admin/debug` → `llm.recentCalls`.
After the native-first picker change, `via` tells you *which* path produced the
result, which is useful when confirming a benchmark matches live behaviour:

- `ai-sdk:agent:native` — native `Output.object` path (auto tool_choice). The
  preferred path on non-Ollama providers; if you see this with `ok:true`, the
  model is doing the job cleanly.
- `ai-sdk:agent` / `ai-sdk:agent:recovery` — fell back to the forced done-tool
  path (Ollama always uses this; non-Ollama only on a native miss).
- A `djAgentPick` that ends in a thrown error → the caller drops to the stateless
  **pool picker** (the station never goes silent; you just lose the agentic pick).

## Producing the recommendation

After the runs, give the operator a compact comparison and a clear call:

1. A table — one row per **provider+model** (and per mode), with success rate,
   median latency, p95, and the dominant failure mode.
2. A one-line recommendation naming the best **provider + model** (routing is
   part of the answer — see "Routing matters"), with the reason ("highest
   success at lowest latency", "only option above 95% on `long`").
3. Call out anything disqualifying — a model that 500s throughout (re-test
   later, verdict deferred), one that's reliable but markedly slow, or one that
   only fails via its native provider but works via OpenRouter (recommend the
   working routing).

Do **not** apply the change. Tell the operator to set `llm.provider` +
`llm.model` via the admin Settings UI (both matter — routing is part of the
choice). Note these are **global**, so they change every DJ generation, not just
the picker — that's the operator's call to make.

## Notes

- The harness uses the **live** `pickSystem` prompt and `PICK_SCHEMA` imported
  from `dj-agent.js`, with synthetic discovery tools — so it tests the real
  prompt and schema, but not real Subsonic network latency.
- Each harness run appends `kind: pickerTest` rows to the controller's event
  log (`state/logs/events-*.jsonl`). Harmless and filterable, but worth knowing
  if you later analyse that log.
