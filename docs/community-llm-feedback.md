# Community LLM feedback — Discord snapshot

_Last updated: 2026-07-09. Sources: SUB/WAVE Discord `#general` (incl. model-testing threads), `#setup-help`, and the `#support` forum._

A periodic snapshot of which LLM models the community actually runs SUB/WAVE on, how they behave, and the recurring LLM-layer issues reported. Useful as ground truth when tuning prompts, picking llm-bench targets, and writing model recommendations.

## Models in use

Local via Ollama dominates; several operators are actively migrating off OpenAI on cost.

| Model | Route | Verdict from the field |
| --- | --- | --- |
| Qwen3.5:9B | `ollama` | Current community favourite for small local. On 0.38.1 it "could actually handle agent picking with only one timeout" — the best small-model result reported so far. |
| Qwen3-14B GGUF (bartowski, Q5_K_M) | `openai-compatible` (llama.cpp) | "Runs the station great, did well with tool calling, but not creative really." Personas outside an upbeat register come out bland; one intro slipped into Mandarin (TTS survived it). |
| Gemma4:12b (`-it-q4_K_M`) | `ollama` | Widely tried, widely struggling: 90s on a programme plan and still nothing valid; "Gemma is still a no" for agent picking. Kept around mainly as a fallback leg. |
| Gemma4:31b-cloud | Ollama cloud (free credits) | Usable as a primary with a local 12b fallback for when credits run out. Regularly throws "agent did not call the done tool before stopping" and produces trailing-off scripts. |
| GPT-4 Mini | `openai` | The cloud reference point people are leaving. ~$1/day at ~8h/day of airtime; cost is the stated reason for going local. |
| bonsai 8b 1-bit | — | Floated as a chatty low-impact option (~1GB) but ruled out: not good at tool calling / agentic use. |

### Settings advice circulating in the community

- Chain of thought: **off**.
- Agent picker: **off** for small models (with it off, picks complete in seconds).
- Ollama context length bumped to **64K** (fixed one operator's DJ Doctor report errors on qwen3.5:9b).
- Cloud-primary + local-fallback legs (e.g. gemma4:31b-cloud primary, gemma4:12b fallback) to ride free credits.
- `OLLAMA_NUM_PARALLEL=2` reduced errors for one GPU operator (but did not fix latency creep).

## Recurring issues, roughly by heat

1. **Agent picking is too heavy for local models.** A day of A/B testing across backends showed "a lot of the DJ functions falling down or timing out, even on the recommended Gemma and Qwen models"; with agent picking off, picks are fast. This is the central pain point and lines up with the prompt-slimming + llm-bench work.
2. **Prompt bloat.** Two confirmed cases: the programme-plan prompt carried every skill's full brief (fixed — cut to one line per skill, PR up), and the **curiosity skill** stuffs the full text of the last 8 curiosity segments into its prompt (unfixed at time of writing; one operator disabled the skill because of it).
3. **Latency creeps up over time regardless of model** — same behaviour on GPU and CPU, not explained by VRAM offload. Smells like session/context growth rather than provider config.
4. **LLM "flow information" leaking into DJ output** instead of scripts. Multiple operators hit it; flagged as a bug to fix and/or make the debug surface configurable.
5. **DJ hallucinating on air** — claiming it skipped a track it didn't, plus general "utter lies"; same-artist-twice-in-a-row keeps being reported despite explicit persona instructions (expected-ish behaviour, but a persistent complaint).
6. **Token accounting under-reports ~2×.** Measured provider-side usage of 66K while stats reported 29.8K, still 2× two hours later. Related confusion from UTC vs local-time display ("usage at 9am when the PC was off"). The daily-token-budget stats should match provider reality.
7. **Programme creation failing → silent DJ blocks.** A failed producer-plan call degrades the episode; the prompt-size fix above came out of this thread.
8. **Show era/brief filters not respected.** A 2020s-era show with an explicit "2020 or later only" brief plays older tracks "at least half the time", strict filter seemingly doing nothing. The Strict-genre help text also contradicts the field-optional copy ("Needs a genre lean set above" vs "leave blank to let the topic and mood drive selection").

### Adjacent gripes (not model-choice, but LLM-output adjacent)

- TTS speaks markup literally: "asterisk dreams asterisk", "chinese character chinese character" for CJK titles.
- Station IDs fire too frequently with no off switch.
- Request for failed listener requests (track not in library) to be queryable via API.

## Takeaway

The community's model recommendation is converging on **Qwen3.5:9B as the small-local floor**, and the consistent failure mode is the **big structured/agent calls** — agent picking and programme plans — not the free-text script calls. Bench and trim those first.
