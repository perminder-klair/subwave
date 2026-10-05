# Jev tagging benchmark findings

Run on 2026-09-18. This experiment does not justify replacing the production
metadata tagger. Jev was faster and more repeatable, but assigned far fewer mood
tags at the fixed 0.75 threshold. Neither model's accuracy was measured.

## Setup

- 200 real library tracks, 150 artists, 171 albums, 37 distinct genre labels.
- Requested 500 random songs through the read-only Subsonic API, deduplicated
  them, ranked IDs by SHA-256 with seed `subwave-jev-200-v1:`, and selected 200.
  Every fourth selected track went to tuning: 50 tuning, 150 held-out evaluation.
  This was a random sample, not a genre-stratified or language-balanced sample.
- Three passes per model, ten tracks per batch, alternating model order.
- Both models received title, artist, album, year and genres. Neither heard audio.
  All sampled tracks had year and genre metadata; missing-metadata behavior is
  not covered by this run. No human-reviewed reference labels were supplied.
- Used SUB/WAVE's default 17 moods, not the remote station's settings. Jev had
  one Boolean question per mood and one energy question per track. At most three
  moods above the fixed threshold were retained. No threshold tuning was done.
- OpenRouter routed both models: `typesafe/jev-1.13`, resolving to
  `typesafe/jev-1.13-20260917`, and `openai/gpt-5.6-luna`.
- Baseline used the real `tagBatch` prompt and recovery strategy, pinned to the
  primary model with no cross-model fallback. Jev had no retries.

Frozen sample SHA-256:
`0f46b5f78af5eedf446a17777c81c98456af25d391704260b82c6600dc34068b`

## Results

| Metric | Jev 1.13 | GPT-5.6-luna |
| --- | ---: | ---: |
| Successful batches | 59/60 | 60/60 |
| Successful track evaluations | 590/600 | 600/600 |
| Median batch time | 487 ms | 4,501 ms |
| p95 batch time | 932 ms | 5,832 ms |
| Assigned at least one mood, successful evaluations | 24.75% | 83.67% |
| Assigned energy, successful evaluations | 90.85% | 100% |
| Identical mood set and energy across all three passes | 165/190 tracks, 86.84% | 92/200 tracks, 46.00% |
| Reported input tokens | 965,150 | 47,646 |
| Reported output tokens | 220,837 | 16,790 |
| Estimated cost across all three passes | $0.04054 | $0.02968 |

Jev's one failure was `AI_InvalidResponseDataError` on batch 2 of pass 2.
Its ten tracks are excluded from three-pass consistency. Empty mood sets count
as identical; greater repeatability does not imply more useful or accurate tags.

All 60 Luna batches used `ai-sdk:recovery:pinned`. The 9.24x median latency ratio
therefore compares these application paths, not isolated model inference speeds.
The baseline cost may omit the failed first attempt's tokens. Jev's failed
batch also lacks reported usage. Costs are estimates, not billing totals, using
$0.042/M input tokens for Jev and $0.20/M input plus $1.20/M output for Luna.
This setup does not establish which model is cheaper after all attempts are billed.

### Agreement on held-out tracks

There were 442 successful paired evaluations out of 450 possible. Across those
pairs, exact mood-set agreement was 21.27%, energy agreement was 66.97%, and
agreement on both was 10.63%. Jev assigned 0.38 moods per track on average;
Luna assigned 1.43. These are agreement measurements, not accuracy scores.
Repeated evaluations are not independent samples.

Jev can abstain on energy with `null`; the baseline prompt requests `medium`
when it cannot tell. That difference affects both coverage and agreement.

## Recommendation

Keep the existing tagger. Human-label the 50 tuning tracks before choosing a
Jev threshold, then freeze that threshold and evaluate against human labels for
the 150 held-out tracks. Do not treat Luna's answers as ground truth.

A narrower follow-up could test Jev as a fast check of a few proposed moods,
rather than asking all 17 questions for every track. That is a hypothesis, not
a benefit established by this run. First investigate Luna's consistent recovery
path and improve failed-attempt usage accounting before comparing costs again.

## Reproduction and privacy

See [benchmark instructions](jev-tag-bench.md) for the input format and isolation
rules. Given the private frozen sample, the command was:

```bash
npm run jev-tag-bench -- --input sample.json \
  --baseline openrouter:openai/gpt-5.6-luna --iterations 3 \
  --baseline-input-price 0.2 --baseline-output-price 1.2
```

Raw reports, the frozen sample and server credentials are not committed.
They remain local under the ignored `scripts/llm-bench/reports/` directory.
The included three-track example is only a smoke-test fixture, not the dataset
behind these findings. A new random sample will not reproduce these exact numbers.
No live library tags, queue files or station settings were changed.
