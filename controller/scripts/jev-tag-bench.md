# Jev metadata-tagging experiment

See [200-track comparison findings](jev-tag-bench.findings.md) for the first
three-pass run against GPT-5.6-luna, including limitations and next steps.

Run from `controller/` with Node 22, matching CI. This uses the official
`@ai-sdk/typesafe-ai` evaluation provider and the existing `tagBatch()` baseline.
By default Jev runs through OpenRouter's `/api/alpha/decisions` endpoint with
`typesafe/jev-1.13`. The endpoint shares TypeSafe's question/answer format, so a
transport adapter preserves the official SDK's probability validation. It does
not use chat completions or require a direct TypeSafe account. This OpenRouter
endpoint is currently alpha.
It does not open the library DB, propagate tags, change station settings, or queue
audio. Settings and credentials are read from the active station under
`--state-dir` (defaults to `STATE_DIR`, then `controller/state`). Settings are
loaded through an isolated temporary snapshot; that copy is removed after load.
Telemetry goes to the report directory's `runtime/`, not live station logs.

```bash
# Validate input and inspect the exact Jev questions without calling either model.
npm run jev-tag-bench -- --input scripts/jev-tag-bench.sample.json --dry-run

# Set OPENROUTER_API_KEY, then compare with the station LLM.
npm run jev-tag-bench -- --input my-sample.json --state-dir ../state

# Explicit baseline; Ollama tags keep the second colon.
OLLAMA_URL=http://localhost:11434 npm run jev-tag-bench -- \
  --input my-sample.json --baseline ollama:qwen3:8b --iterations 3

# Jev only.
npm run jev-tag-bench -- --input my-sample.json --baseline none

# Direct TypeSafe access remains available with TYPESAFE_AI_API_KEY.
npm run jev-tag-bench -- --input my-sample.json --jev-provider typesafe
```

`--help` lists all options. OpenRouter defaults to `typesafe/jev-1.13`; direct
TypeSafe defaults to `jev-1.13.0`. OpenRouter uses `OPENROUTER_API_KEY`, falling back
to the station's saved OpenRouter key. Direct TypeSafe uses `TYPESAFE_AI_API_KEY`
or `TYPESAFE_API_KEY`. Provider keys can come from the environment,
`controller/.env`, or the source station's `secrets.env`. An explicit
`--baseline provider:model` changes only this process. Baseline calls are pinned
to the primary leg so another model cannot silently rescue the comparison.

## Frozen sample

The input is an object with `tracks` and an optional `moods` vocabulary. The
example file demonstrates the shape; its three tracks are a smoke test, not an
evaluation set. Supply a representative sample of about 200 tracks for a useful
comparison, including less familiar artists, different languages, and incomplete
metadata. Sampling the library is a separate step; this script only reads JSON.

Each track needs a unique `id`. Optional fields are `title`, `artist`, `album`,
`year`, and `genres` (an array of strings). All other track fields are discarded.
Both models receive only these five metadata fields. Neither hears audio.
Omitting `moods` uses the source station's normalized mood vocabulary.

You can add `split: "tune"` or `"eval"` (default) and human-reviewed labels:

```json
"expected": { "moods": ["calm", "reflective"], "energy": "low" }
```

Use `energy: null` for a human judgment of insufficient information. These labels
and splits are never sent to either model. Existing machine tags are not ground
truth; leave `expected` out until reviewed. Reference mood labels must use the
sample's vocabulary and be exhaustive within it for recall/Brier scores to make
sense. Repeated evaluations are not independent human-labeled examples.

## What the comparison measures

Jev answers one Boolean question per track/mood, plus an energy Choice with
`low`, `medium`, `high`, and `unknown`. Boolean questions map to native Noul
probabilities. Code selects at most three moods at or above `--threshold` (0.75
by default, an unvalidated starting point). An energy `unknown` becomes `null`.
The baseline imports the real prompt/schema and keeps its existing behavior,
including the `medium` fallback when it cannot tell. This asymmetry is recorded
in every report. Jev's prompt is a purpose-built set of atomic questions, not a
copy of the generative tagger prompt.

Both engines receive identical batches, defaulting to ten tracks. Execution
order alternates. Jev makes one request with retries disabled; the baseline keeps
its real structured-output recovery but does not perform the library worker's
per-track salvage after a failed batch. Failed batches remain failures. The
timeout bounds each HTTP request, including response-body reads, not the total
time for a baseline batch with multiple recovery requests.

The script saves `report.json` after every batch. It contains the frozen sample,
SHA-256 of the original input, prompts/questions, model IDs, raw Jev answers,
confidence metadata, token usage, timing, failures, predictions, and summaries.
`disagreements.json` lists successful paired evaluations with differing labels.
These files are not blinded; for blind review, label the tracks before opening
model answers. Default output lives in the gitignored `scripts/llm-bench/reports/`.
`--out` must name a new directory. Reports and runtime logs contain track metadata.

Summaries separate tuning and evaluation labels. They report micro-averaged mood
precision/recall, mood Brier score for Jev, energy accuracy including abstentions,
coverage, failed batches, and batch p50/p95 latency. Without human labels, quality
metrics are null. Brier score measures probability error; it does not alone prove
calibration. Tune thresholds only on `tune` tracks, then freeze them for `eval`.
Raw probabilities allow later threshold analysis without further paid calls.

Jev cost is an estimate from reported input usage at $0.042 per million tokens,
overridable with `--jev-input-price`. Baseline cost is unknown unless both
`--baseline-input-price` and `--baseline-output-price` are supplied. Failed and
recovered calls may have incomplete token accounting. Costs are not invoices.
A run with any failed batch exits with status 1 and retains its report.

API references:
- https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request
- https://ai-sdk.dev/providers/ai-sdk-providers/typesafe-ai
- https://docs.typesafe.ai/models

Jev probabilities are never written into SUB/WAVE's propagation confidence field;
that field measures neighbour similarity and coverage, a different quantity.
