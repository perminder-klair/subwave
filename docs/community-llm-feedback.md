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

## Bench validation — 2026-07-09

Controlled `llm-bench` runs (full matrix, 3 iterations/cell, post prompt-diet branch)
against the claims above. Reports in `controller/scripts/llm-bench/reports/`.

| Community claim | Bench verdict |
| --- | --- |
| Qwen3.5-9B "could handle agent picking with only one timeout" | **Mostly confirmed** (via OpenRouter): pool cells 100% at 0.6–3.5s; agent short-context 100%, long-context 67% with 2 timeouts. Agent mode is borderline — livable because the pool fallback catches every miss, which matches what operators experience. Characteristic quirks: over-long request acks (9×), occasional stage directions. |
| Gemma4:31b-cloud "regularly throws done-tool errors" | **Refuted on the current build**: 94/96 via the exact `ollama` cloud routing, ALL agent cells 100% at 1–4s. The reports likely predate the done-tool recovery fixes and the pick prompt diet. Best model tested — its one weak cell is the 3-hour programme plan (picked unoffered feature kinds 2/3 runs). |
| "Gemma is still a no" (12b local) | **Agent-mode-only verdict.** Via locca with the exact community quant (`gemma-4-12b-it-Q4_K_M`), the 12b scored **38/44 on the structured/pool kinds** — pool picks, request matching, plans, banter all fine (CPU latency excluded from the verdict). Its misses mirror the 31b: variety-trap (family trait), 3-hour plans, two "coming up next" slips. For a pool-mode station the 12b remains a fine local pick. |
| GPT-4/5 Mini as the cloud reference worth paying for | **Weaker than assumed**: 91/96 — it ignores the VARIETY criterion under same-artist pressure (0% on that cell, worse than gemma-cloud) and picked the wrong track on 2/3 exact-title requests. The quality gap driving the cost isn't there on this workload. |
| deepseek-v4-flash routing tale (0/4 direct vs 4/4 OpenRouter) | Third routing (`ollama` cloud): **82/96, mid-tier** — clean pool picks/segments but 2 hallucinated track ids (the dangerous failure), 4 stage directions, weak agent long-context (33%) and programme plans (0–33%). Fine as a fallback leg, not a primary. |
| "Agent picking is too heavy for local models" | **Needs nuance**: too heavy for ~9B models on the native path; gemma-31b-cloud on Ollama's forced-tool path is 100% across agent cells. Small-model operators get the pool-mode path (segments included) instead. |
| "Failures cluster in big structured/agent calls, not scripts" | **Confirmed across every model**: misses concentrate in `djAgentRequest`, agent long-context, and multi-hour programme plans; the free-text script kinds are near-perfect everywhere. |

### Full seven-model table (full matrix ×3 unless noted)

| Model / routing | Score | One-line verdict |
| --- | --- | --- |
| `ollama:gemma4:31b-cloud` | **94/96** | Best overall; agent mode viable again (1–4s everywhere). Weakness: 3-hour plans. |
| `openrouter:openai/gpt-5-mini` | 91/96 | Strong, but ignores VARIETY under pressure and mis-picks exact-title requests. |
| `ollama:minimax-m2.7:cloud` | 90/96 | The other agent-capable option. Glacial programme plans (2–4 min each); misses `mood` on vibe requests. |
| `ollama:deepseek-v4-flash:cloud` | 82/96 | Pool-only fallback leg — 2 hallucinated ids, stage directions, weak plans. |
| `openrouter:google/gemma-4-26b-a4b-it` | 79/96 | Pool-clean but 37.8s median pool picks as served — too slow to recommend over qwen. All throws are agent cells. |
| `ollama:kimi-k2.6:cloud` | 79/96 | Scattered flakiness (11 throws across unrelated kinds) + high latency. Avoid. |
| `openrouter:qwen/qwen3.5-9b` | 75/96 | The small floor: pool cells 100% at 0.6–3.5s. Rambles request acks; agent long-context 67%. Needs the Qwen thinking fix (in the same PR). |
| `locca:gemma-4-12b-it-Q4_K_M` | 38/44¹ | Pool-mode fine locally. ¹Structured/pool kinds only, ×2, latency excluded (CPU bench host). |

Bench-backed recommendation as of this snapshot: **`ollama:gemma4:31b-cloud` primary (agent
mode viable again)**, local fallback leg per credits; **qwen3.5-9b (or gemma-12b locally) in
pool mode** as the small floor; `minimax-m2.7:cloud` if you want agent mode without gemma;
deepseek-v4-flash as a fallback leg only; skip kimi-k2.6 and the 26b MoE for now.

Cross-model patterns the bench surfaced: the **Gemma family** shares two signatures at every
size (falls for the same-artist trap; picks unoffered feature kinds on 3-hour plans), and the
**multi-hour programme plan is the hardest call in the system** — the only kind that dented
every model tested. Reasoning axis note: all rows above measured reasoning **off**; the
`--reasoning both` axis + thinking-leak forensics landed after these runs.

### Second batch (same day, with thinking-leak forensics live)

| Model / routing | Score | Verdict |
| --- | --- | --- |
| `google:gemini-3.5-flash` | **95/96** | New overall leader; agent 18/18 at 1–2 s. |
| `google:gemini-3.1-flash-lite` | 94/96 | The value pick — 31B-class score, agent 18/18, 0.7 s picks. |
| `openrouter:openai/gpt-4o-mini` | 90/96 | Agent-capable; misses are editorial. |
| `ollama:glm-5.2:cloud` | 86/96¹ | Pool-mode; agent borderline (15/18). |
| `openrouter:anthropic/claude-haiku-4.5` | 82/96² | Agent-capable (18/18); wordy — over-length lines are most misses. |

¹ ² Both scores are POST-FIX. The forensics caught **three thinking-suppression bugs in our
own plumbing** the same day they landed: `effort:'minimal'` is a no-op for Qwen via
OpenRouter (station-observed), the whole `providerOptions.ollama` block has been dropped
since the ai-sdk-ollama v4 swap (glm measured 66/96 against that bug), and OpenRouter maps
any effort onto an Anthropic thinking *budget* — the suppression value was ENABLING thinking
on haiku (first run measured 15/96). Suppression is now `enabled:false` everywhere except
the reasoning-mandatory OpenAI/R1 families, Ollama gets construction-time `think:false`
(+ the admin `num_ctx` setting works again — it was also silently dead), and both fixes are
wire-verified.
