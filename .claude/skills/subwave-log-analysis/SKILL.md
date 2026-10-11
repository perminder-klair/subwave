---
name: subwave-log-analysis
description: >-
  Analyse the SUB/WAVE radio station's unified event log (state/logs/events-*.jsonl)
  and give the operator a diagnostic report on how the station is behaving — Navidrome/
  Subsonic API call patterns, the DJ picker's behaviour and music-library coverage, and
  runtime health anomalies. Use this skill whenever the user wants to understand or get
  feedback on what the radio is doing under the hood: how Navidrome calls are being made
  and how often, why the picker keeps choosing certain tracks or artists, whether the
  library pool is too narrow, whether traces are failing or running slow, or asks things
  like "analyse the subwave logs", "check the radio's behaviour", "what is the picker
  doing", "why does it keep playing the same artists", "is the station healthy", "how
  are the navidrome calls looking", "give me feedback on the event log". Trigger this
  skill even if the user does not name the log file or the script — any request to
  diagnose, audit, review, or get feedback on SUB/WAVE's runtime behaviour from its logs
  belongs here.
---

# SUB/WAVE log analysis

## What this is

The SUB/WAVE controller writes a unified, append-only event log to
`state/logs/events-YYYY-MM-DD.jsonl` — one JSON object per line. It is the
station's flight recorder: every LLM call, every agent tool call, every
Navidrome/Subsonic API call, plus track plays and session boundaries. Events
made inside one DJ decision share a `traceId`, so a decision and the calls it
triggered read back as a single trace.

This skill turns that raw stream into a written diagnostic report for the
operator, covering three lenses: **Navidrome usage**, **picker/DJ quality**, and
**health & anomalies**. The job is to *diagnose and recommend* — describe what
the logs show, then suggest concrete changes with reasoning.

A bundled script does the aggregation; your job is interpretation. Do not
re-derive numbers by hand or eyeball the JSONL — run the script and reason
about its output.

## Step 1 — Run the analysis script

```bash
python3 scripts/analyze_events.py [--state-dir DIR] [--since 24h] [--day YYYY-MM-DD]
```

- `--state-dir` — path to the SUB/WAVE `state/` directory. Omit it and the
  script auto-detects `./state` or `../state`, so from the subwave repo root it
  usually needs no argument. Pass it explicitly if the repo is elsewhere.
- `--since` — narrow to a recent window: `6h`, `24h`, `3d`, `1w`. Use this when
  the user asks about "today", "the last few hours", "this week". Omit it to
  analyse everything on disk.
- `--day` — pin to a single day's file.

The script prints a sectioned digest. Read all of it before writing anything.

**If the script reports no events files:** the unified log is written by the
controller, and it is a recent addition — it only exists once the controller
has been rebuilt with `observability/events.js` and has run. A controller
*restart* is not enough; its source is baked in at build time. Tell the
operator this rather than guessing. If the file exists but is nearly empty, the
station simply hasn't been on air long — say so and analyse what little there is.

## Step 2 — Interpret the digest

The digest is descriptive; the value you add is judgement. For each lens, here
is what healthy looks like and why deviations matter.

### Navidrome usage

The picker memoises most Subsonic calls for 30 minutes, so call volume is
naturally bursty around decisions and quiet between them.

- **Error rate.** Anything above ~0 warrants a look. A cluster of errors on one
  endpoint — especially `upstream 522` — almost always means the controller's
  `NAVIDROME_URL` points at a Cloudflare-fronted public origin rather than the
  internal/Tailscale address. Liquidsoap works around this with a `curl`-based
  `subhttp:` protocol, but the controller's Subsonic API client does not — it
  should talk to Navidrome directly.
- **Latency.** `getSimilarSongs2` is the slowest Subsonic call by nature and is
  *not* memoised (it is per-track). If it dominates `avg`/`p95` ms, that is
  expected — but if it also dominates *decision latency* (see picker section),
  the agent may be leaning on the `similarSongs` tool too hard.
- **Pool breadth.** "Most-returned songs" is the key signal. A long, flat tail
  means the picker sees a wide slice of the library. A short, steep head — a
  handful of songs returned hundreds of times — means the candidate pool is
  narrow, which is the root cause of audible repetition.
- **Repeated identical calls.** Within a 30-minute window these are cache
  misses or non-memoised calls (`getSimilarSongs`), which is normal. The same
  `search3` with *identical params* fired many times in a short burst is
  different — it means the agent keeps re-searching the same terms within one
  decision, a sign of a confused tool loop.
- **Inside-a-trace ratio.** A few untraced calls at the start are boot/context
  warm-up — expected. Ongoing untraced calls mean something outside a DJ
  decision is hitting Navidrome.

### Picker / DJ quality

- **Navidrome & tool calls per decision.** Two to five tool calls per pick is
  the designed range. Far more suggests the agent is thrashing; far fewer (and
  a high fallback rate) suggests it is not really exploring.
- **Decision latency.** A pick fires when a track starts and must land before
  that track ends (~3–4 min). Sub-second to a few seconds is healthy. p95 or
  max creeping toward a minute is a dead-air risk — usually a slow LLM provider
  or slow Navidrome.
- **Agent vs fallback.** `agent succeeded` should dominate. A high
  `agent → fallback` rate means the conversational picker keeps erroring or
  returning invalid track ids — cross-reference the failed-LLM errors in the
  health section. Frequent fallback means the agent is paying its cost without
  delivering; the model or provider may be too weak, or `settings.llm.pickerAgent`
  could be turned off to just use the reliable pool picker.
- **Tool mix.** A wildly skewed mix (one tool doing everything) hints the agent
  has a blind spot — e.g. never using `tracksByMood` may mean mood tags are
  sparse, so that tool returns nothing and the agent learned to avoid it.
- **Repetition — the audible quality signal.** "Artist repeated within 3 plays"
  and "most-aired artists" are what a listener actually notices. The agent is
  fed recent plays via the session window and is told not to repeat artists
  back-to-back, so persistent repetition is rarely the agent ignoring
  instructions — it is the *candidate pool being too narrow* to obey them.
  Trace it back to pool breadth in the Navidrome section.
- **Transitions.** Printed only when the controller keeps the seam record.
  "Seams armed" is how each track came in, as the controller armed it.
  "After jingle/bed/break" means something played between the two songs and
  owned that seam. "DJ asked for" is the model's choice before any strip.
  "Dropped" pairs each lost effect with a reason code.
  - **`pair-fit` dominating:** the model is choosing effects the measured pair
    does not support. The coaching and the data disagree.
  - **`variety` dominating:** the model is stuck on one favourite effect.
  - **`switched-off`:** the operator turned an effect off that the model still
    asks for.
  - **`jingle-seam`:** chosen effects lost to a jingle placed between the songs.
  - **Asks almost all `normal`:** effects are offered but not used.

### Health & anomalies

- **Failed traces / LLM calls.** Read the error text. `ECONNREFUSED` on the
  Ollama host means the LLM box is down or unreachable. Auth/4xx errors point
  at provider keys in `controller/.env`.
- **Structured-output recoveries.** A few are harmless — the recovery path
  salvaged malformed JSON. Many means the model is weak at structured output;
  a more capable model would cut them.
- **Slow decisions / slow Navidrome calls.** Outliers worth naming, especially
  if they correlate with the failed or near-miss traces.

If the user wants to drill into one specific decision, every event in a trace
shares a `traceId` — grep the JSONL for it to see that decision end to end.

## Step 3 — Write the report

Deliver the findings as a written report in the conversation (no files). Lead
with a short plain-language summary, then one section per lens. Under each
finding that warrants action, give a recommendation with its reasoning — the
operator wants to know *why*, not just *what*. Use this shape:

```
**SUB/WAVE log analysis — <time span, from the digest>**

<2–4 sentence summary: overall health, and the single most important thing
to address.>

### Navidrome usage
<Findings, quoting real figures from the digest.>
**Recommendation:** <concrete change + why. Omit if nothing is wrong.>

### Picker / DJ quality
<Findings.>
**Recommendation:** <...>

### Health & anomalies
<Findings, or "Nothing failing in this window.">
**Recommendation:** <...>
```

Ground every claim in the digest — quote the actual numbers. Do not invent
metrics the script did not print. If a lens looks genuinely healthy, say so
plainly rather than manufacturing a concern.

## Recommendation playbook

Map common findings to the knob that addresses them. These are starting
points — reason from the specific data, do not paste them verbatim.

| Finding | Likely cause | Recommendation |
|---|---|---|
| Errors clustered on a Navidrome endpoint (esp. `522`) | Controller's `NAVIDROME_URL` is the Cloudflare origin | Point `NAVIDROME_URL` in `controller/.env` at the internal/Tailscale Navidrome address |
| Narrow pool: short head of most-returned songs, few distinct artists | Library small, or mood tags sparse, or pool sources thin | Check library size; run the library tagger (`npm run tag`) so `tracksByMood` has data; review the 7 picker pool sources in `music/picker.js` |
| High artist repetition despite a wide library | Candidate pool narrow at decision time | Same as above — broaden the pool; verify the recently-played exclusion window isn't starving choices |
| High `agent → fallback` rate | Agent erroring or returning invalid ids | Read the failed-LLM errors; consider a stronger model/provider in `settings.llm`, or disable `settings.llm.pickerAgent` to rely on the pool picker |
| Decision latency p95 approaching track length | Slow LLM provider or slow Navidrome | Faster provider/model; or reduce tool calls per decision |
| Many `ai-sdk:recovery` events | Model weak at structured JSON output | Switch to a more capable model in `settings.llm` |
| `ECONNREFUSED` / connection errors to the LLM host | Ollama box down or wrong URL | Check the LLM host is up and `settings.llm` (provider/model/URL) is correct |
| Same `search3` params repeated within one decision | Agent re-searching the same terms — confused tool loop | Note it; if persistent, the picker prompt/tools in `llm/tools.js` may need tightening |
| Auto-playlist refresh dominating Navidrome volume | Refresh interval too aggressive | Raise `AUTO_QUEUE_REFRESH_MINUTES` in `controller/.env` (default 60) |

## Notes

- This skill only *reads* logs — it never changes the running station.
- The event log rotates daily; without `--since` or `--day` the script reads
  every `events-*.jsonl` on disk, so a long history is analysed at once. Use
  `--since` to keep a report focused on a recent window.
