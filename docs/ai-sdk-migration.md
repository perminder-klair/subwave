# Rebuilding SUB/WAVE's LLM Layer on the Vercel AI SDK

An assessment of what it takes to move SUB/WAVE off its hand-rolled Ollama
client and onto the [Vercel AI SDK](https://ai-sdk.dev) — so providers, models,
and tools become swappable.

Status: **implemented.** All five phases shipped — see "What shipped" below.
The rest of this document is the original assessment, kept for rationale.

---

## What shipped

Provider strategy chosen: **local default + cloud opt-in**. Scope: **full
rebuild (Phases 0–4)**.

New files (`controller/src/llm/`):

| File | Role |
|---|---|
| `provider.js` | Provider registry — resolves an AI SDK `LanguageModel` from `settings.llm` (`ollama` \| `anthropic` \| `openai` \| `gateway`). |
| `sdk.js` | `djText` (free text) + `djObject` (Zod-validated structured output via `generateText` + `Output.object`). |
| `dj.js` | The DJ prompt layer — renamed from `ollama.js`; the 7 LLM functions now route through `sdk.js`. |
| `log.js` | The `recentCalls` ring buffer (split out to break an import cycle). |
| `tools.js` | `buildPickerTools()` — AI SDK `tool()` definitions over Subsonic/library music discovery. |
| `speech.js` | The `cloud` TTS engine — AI SDK `generateSpeech` → OpenAI / ElevenLabs. |

Changed files: `picker.js` (adds the `ToolLoopAgent` path,
keeps the pool path as fallback), `tts.js` (adds the `cloud` engine),
`settings.js` (adds the `llm` block + `tts.cloud` + `getRedacted()`),
`server.js` (`/settings` exposes `llm`, masks secrets; `/debug` shows the
active provider), and the admin UI (`SettingsPanel.jsx` gains an "LLM
provider" section + cloud-voice fields; `DebugPanel.jsx` retitled).

Settings shape added:

```js
settings.llm = { provider: 'ollama', model: '', apiKey: '', pickerAgent: false }
settings.tts.cloud = { provider: 'openai', model: 'gpt-4o-mini-tts', voice: 'alloy', apiKey: '' }
```

New controller dependencies: `@ai-sdk/anthropic`, `@ai-sdk/openai`,
`@ai-sdk/elevenlabs` (the `controller` image must be rebuilt to pick them up).
API keys can be set in the admin UI or via env vars
(`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `AI_GATEWAY_API_KEY` /
`ELEVENLABS_API_KEY`); the UI never echoes a stored key back.

Default behaviour is unchanged: with `settings.llm.provider = 'ollama'` and
`pickerAgent = false`, the station runs exactly as before — the homelab box,
the candidate-pool picker, and local Piper/Kokoro TTS.

---

### Original assessment

---

## TL;DR — what's possible

| Goal | Possible? | How |
|---|---|---|
| Swap LLM providers (Ollama ↔ Anthropic ↔ OpenAI ↔ Gemini) without touching call sites | ✅ Yes | A provider registry resolved from settings/env |
| Replace `format:'json'` + regex recovery with validated structured output | ✅ Yes | `generateText` + `Output.object` + Zod schemas |
| Turn the picker into a real tool-using agent | ✅ Yes (with caveats) | `ToolLoopAgent` + Subsonic tools |
| Turn weather/news/traffic skills into first-class tools | ✅ Yes | `tool()` definitions, already half-done |
| Swap TTS engines (Piper/Kokoro ↔ ElevenLabs/OpenAI) through one interface | ⚠️ Partial | AI SDK `generateSpeech` covers cloud TTS only — Piper/Kokoro stay custom |
| Streaming DJ scripts | ✅ Yes | `streamText` — but low value for a file-based pipeline |

The headline: **everything the user asked for is achievable.** The only
partial is speech — the AI SDK's speech API does not talk to local Piper or
Kokoro, so TTS unification needs a thin custom layer either way.

---

## Where SUB/WAVE is today

The codebase already has **two** LLM paths — the migration is ~30% done.

| Path | File | Used by | Mechanism |
|---|---|---|---|
| Legacy raw client | `controller/src/ollama.js` | `server.js`, `picker.js`, `queue.js`, `scheduler.js` | Hand-rolled `fetch` → Ollama `/api/chat` |
| AI SDK wrapper | `controller/src/llm/sdk.js` | `controller/src/skills/*` only | `ai` + `ollama-ai-provider-v2` |

`ollama.js` exposes 7 LLM functions still on the legacy path:

| Function | Type | Notes |
|---|---|---|
| `matchRequest` | structured (JSON) | `format:'json'` + manual `JSON.parse` + regex fallback |
| `pickNextTrack` | structured (JSON) | same; picks from a pre-built 18-candidate pool |
| `generateIntro` | free text | DJ persona, creative |
| `generateLink` | free text | between-track link |
| `generateHourlyTime` | free text | scheduled |
| `generateWeatherSegment` | free text | scheduled |
| `generateStationId` | free text | scheduled |

Dependencies are already installed (`controller/package.json`): `ai@^6`,
`ollama-ai-provider-v2@^3.5`, `zod@^4`. **No new core dependency is required**
to finish the migration — only optional provider packages if cloud providers
are added.

TTS is entirely separate and not an LLM concern: `tts.js` dispatches to
`piper.js` / `kokoro.js`, both local CLI/worker processes.

---

## AI SDK building blocks (verified against current docs)

The AI SDK moves fast and several APIs were renamed recently. Verified current
shapes:

### Providers — the part that enables switching

```js
import { generateText } from 'ai';

// AI Gateway is the default provider — a bare string resolves through it
await generateText({ model: 'anthropic/claude-sonnet-4.5', prompt: '…' });
```

- **AI Gateway** (`AI_GATEWAY_API_KEY`) — one key, every cloud provider, model
  selected by string ID. Cloud-only.
- **Dedicated packages** — `@ai-sdk/anthropic`, `@ai-sdk/openai`,
  `@ai-sdk/google`, etc.
- **Local** — `ollama-ai-provider-v2` (already installed), LM Studio,
  OpenAI-compatible. **The Gateway cannot reach a homelab Ollama box** — local
  models always go through a local provider package.
- A **provider registry / custom provider** lets you map friendly names
  (`"fast"`, `"smart"`) to concrete `provider:model` pairs and switch them in
  one place.

### Text generation

`generateText({ model, system, prompt | messages, tools, … })` → `{ text,
finishReason, usage, toolCalls, toolResults, response }`. `streamText` is the
streaming twin.

### Structured output (replaces `format:'json'`)

`generateObject` is **deprecated**. Current pattern:

```js
import { generateText, Output } from 'ai';
import { z } from 'zod';

const { output } = await generateText({
  model,
  output: Output.object({ schema: z.object({ … }) }),
  prompt,
});
// output is a validated, typed object — no JSON.parse, no regex recovery
```

`Output.array`, `Output.choice`, `Output.json` also exist.

### Tools

```js
import { tool } from 'ai';

const searchLibrary = tool({
  description: 'Search the Navidrome library by artist, title, or genre',
  inputSchema: z.object({ query: z.string() }),   // note: inputSchema, not parameters
  execute: async ({ query }) => subsonic.search(query),
});
```

Tool results feed back into the model automatically on multi-step calls.

### Agents

`ToolLoopAgent` wraps model + system + tools and runs the call-tool → observe →
call-again loop. `stopWhen` (with a step-count condition) bounds the loop;
default cap is 20 steps.

### Speech

`generateSpeech` (exported as `experimental_generateSpeech`):

```js
const { audio } = await generateSpeech({ model: openai.speech('tts-1'),
                                         text, voice });
// audio.uint8Array / audio.base64
```

Supported speech providers: **OpenAI, ElevenLabs, LMNT, Hume**. **Not Piper,
not Kokoro** — those have no AI SDK provider.

### Renamed APIs to watch (current as of `ai@6`)

| Old | New |
|---|---|
| `parameters:` in `tool()` | `inputSchema:` |
| `generateObject()` | `generateText({ output: Output.object(…) })` |
| `maxTokens` | `maxOutputTokens` |
| `maxSteps` | `stopWhen:` with a step-count condition |

---

## What the rebuild looks like

### Phase 0 — Provider registry (the foundation)

Create `controller/src/llm/provider.js`: one place that builds the model from
settings/env.

```js
// pseudo-shape
function model(role /* 'match' | 'creative' | 'pick' */) {
  const cfg = settings.get().llm;          // { provider, model, gatewayKey, … }
  switch (cfg.provider) {
    case 'ollama':    return ollama(cfg.model);        // homelab, default
    case 'gateway':   return gateway(`${cfg.vendor}/${cfg.model}`);
    case 'anthropic': return anthropic(cfg.model);
    // …
  }
}
```

- Add an `llm` block to `settings.js` (provider, model, optional API key) so the
  operator switches providers from the **admin settings UI**, no redeploy.
- Every LLM call site asks the registry for a model — they never name a
  provider directly. This is the single change that delivers "switch providers".

### Phase 1 — Migrate the 7 `ollama.js` functions

Fold `ollama.js` and `llm/sdk.js` into one module set:

- `matchRequest` → `generateText` + `Output.object` with a Zod schema for the
  7-field request object. **Deletes** the manual `JSON.parse`, the regex
  `{…}` recovery, and the defensive "term equals mood" filter in `server.js` —
  Zod validates the shape for you.
- `pickNextTrack` → same structured-output treatment (or see Phase 3).
- `generateIntro/Link/Hourly/Weather/StationId` → `generateText` (the existing
  `djText` in `sdk.js` already does this — extend it). The persona/angle/recap
  prompt machinery (`djSystem`, `decoratePrompt`, `buildContextLines`) is
  provider-agnostic and **stays as-is**.
- Keep the `recentCalls` ring buffer for `/debug` — wire it into the SDK calls
  the way `sdk.js` already does with `record()`.

Net: `ollama.js` shrinks to prompt-building helpers; all model I/O goes through
the SDK.

### Phase 2 — Skills become real tools

`skills/weather|news|traffic|random-facts` already call `djText`. Re-express
each as an AI SDK `tool()` with an `inputSchema` and `execute`. This makes them
composable — usable standalone *and* callable by an agent (Phase 3).

### Phase 3 — The picker as an agent (optional, highest-value, highest-risk)

Today `picker.js` hand-builds a balanced pool from 7 Subsonic sources, caps and
dedupes it, and hands ≤18 candidates to the LLM. An agent could instead be
*given the tools* and decide:

```
ToolLoopAgent({
  model: model('pick'),
  system: PICKER_SYSTEM,
  tools: { searchLibrary, getSimilarSongs, getTopSongs,
           getRecentlyAdded, getPlaylists, songsByMood },
  stopWhen: <bounded step count>,
})
```

The agent searches, looks at what's recent, and returns a pick — no pre-built
pool.

**Caveats — be honest about these:**
- **Tool-calling needs a capable model.** The AI SDK docs explicitly warn weak
  models "struggle to call tools effectively." `qwen2.5:7b` on the homelab is
  borderline. This phase is the strongest argument for making a cloud provider
  selectable.
- **Latency & cost.** A multi-step agent loop is several round-trips vs today's
  one call. The picker runs between every track — keep `stopWhen` tight.
- **Determinism.** The current memoised-pool approach is predictable and cheap.
  Keep it as the fallback path; let the agent be the preferred path only when a
  capable model is configured.

### Phase 4 — TTS abstraction (partial)

The AI SDK `generateSpeech` only covers cloud voices. Recommended shape:

- Keep `tts.js` as the dispatcher it already is.
- Add an `aisdk` engine alongside `piper` / `kokoro` that calls
  `generateSpeech` with an ElevenLabs/OpenAI model.
- The operator picks the engine per kind in settings, exactly as today.

This gives "swap TTS providers through one interface" — but the interface stays
SUB/WAVE's own `tts.speak()`, because Piper/Kokoro will never be AI SDK
providers.

---

## Migration order & risk

| Phase | Effort | Risk | Payoff |
|---|---|---|---|
| 0 — Provider registry | S | Low | Unlocks all switching |
| 1 — Migrate 7 functions | M | Low | Deletes fragile JSON parsing; one code path |
| 2 — Skills as tools | S | Low | Composability |
| 3 — Picker agent | L | **Med-High** | True agentic DJ; needs a capable model |
| 4 — TTS abstraction | S | Low | Cloud voice option |

Phases 0–2 are safe, mechanical, and self-contained — they can ship without
behaviour change (still pointed at the same Ollama box). Phase 3 is the
ambitious one and is where a provider decision actually matters.

Throughout: the **file-based IPC** (`next.txt`, `say.txt`, `intro.txt`,
`now-playing.json`), Liquidsoap, Icecast, and the web UI are untouched. This is
a controller-internal refactor.

---

## The decision that shapes everything

**Which provider strategy?**

1. **Stay local-first (Ollama), SDK just for portability.** Keep the homelab
   box as default; the SDK makes other providers *available* but not used.
   Cheapest, fully private, but Phase 3's agent picker is constrained by 7B
   tool-calling.
2. **Local default + cloud opt-in via registry.** Operator chooses per-station
   in settings; homelab for free/private operation, a cloud model when they
   want the agentic picker. Most flexible; recommended.
3. **Cloud-first via AI Gateway.** Best model quality and tool-calling, one API
   key — but introduces cost, a network dependency, and sends listener request
   text off-box. Against SUB/WAVE's "personal homelab radio" ethos.

Recommendation: **option 2.** It's what the provider registry in Phase 0 is
built for, and it lets Phase 3 be gated on a capable model being configured.

---

## File map for the rebuild

| File | Change |
|---|---|
| `controller/src/llm/provider.js` | **new** — provider registry |
| `controller/src/llm/sdk.js` | extend — absorb all model I/O, keep `record()` |
| `controller/src/ollama.js` | shrink to prompt helpers; rename (it's no longer Ollama-specific) |
| `controller/src/picker.js` | Phase 3 — `ToolLoopAgent` + Subsonic tools, pool path kept as fallback |
| `controller/src/skills/*` | Phase 2 — re-express as `tool()` definitions |
| `controller/src/server.js` | drop the defensive `matchRequest` JSON guards |
| `controller/src/settings.js` | add `llm` settings block (provider/model/key) |
| `controller/src/tts.js` | Phase 4 — add `aisdk` engine option |
| `controller/package.json` | add provider packages only if cloud is enabled |

---

## Open questions for the operator

1. Provider strategy — option 1, 2, or 3 above?
2. If cloud is in scope: AI Gateway (one key, all vendors) or a specific
   vendor package?
3. Is the agentic picker (Phase 3) wanted, or is finishing Phases 0–2 (a clean
   provider-agnostic refactor with no behaviour change) the goal for now?
4. TTS — add cloud voices (ElevenLabs/OpenAI), or leave TTS on Piper/Kokoro?
