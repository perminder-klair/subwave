// DJ Doc's knowledge base — the "memory file" the station doctor consults when
// reviewing a health report. Distilled by hand from the operator manual
// (/manual, esp. the FAQ + getting-started + voices + llm pages) and the setup
// pages (/setup, /onboarding), plus the architecture in CLAUDE.md. Kept as a
// plain string so it drops straight into the review prompt.
//
// Editing this file improves DJ Doc's advice without touching the assessment
// logic. Keep it FACTUAL and ACTIONABLE — it is reference material, not prose.

export const DJ_DOC_KNOWLEDGE = `# SUB/WAVE — operator knowledge base (for the station doctor)

## What it is
SUB/WAVE is a personal internet radio station: one Icecast stream every listener
shares, an AI DJ that picks the tracks and reads the links between them. Music
comes from a Navidrome (Subsonic) library; the DJ is driven by an LLM; voices are
synthesised by a TTS engine; Liquidsoap mixes it and feeds Icecast.

## What setup actually requires
- A reachable **Navidrome** library (URL + user + pass) — without it the picker has
  nothing to play. This is the only hard requirement; if connectivity fails, point
  the operator at /onboarding (or 'subwave setup').
- An **LLM** — Ollama is the default and needs no key. Cloud providers (Anthropic,
  OpenAI, Google, DeepSeek, OpenRouter, Gateway) and self-hosted openai-compatible
  servers are all supported; pick one in Settings → LLM.
- Three root .env vars boot the stack: ADMIN_USER, ADMIN_PASS, SITE_URL. Env always
  wins over wizard/settings.

## Chain-of-thought / reasoning (settings.llm.reasoning)
- Lets "thinking" models emit a reasoning chain before answering. Costs latency and
  tokens. **Recommend ON only for** a capable reasoning model the operator chose on
  purpose and where DJ link quality matters more than speed/cost.
- **Recommend OFF for** small/local models, structured track-picks (they don't
  benefit), and anyone watching token cost or wanting snappy transitions. Default OFF.

## Agentic picker vs candidate pool (settings.llm.pickerAgent)
- **Agentic picker (ON by default):** a small reasoning loop with session memory and
  tools to search the library itself — choices stay coherent across a run. Wants a
  ~12B-class model (e.g. Gemma-class 12B) or a good cloud model. It automatically
  falls back to the candidate pool if it fails or runs slow.
- **Candidate pool (the fallback / "simpler picker"):** gathers a shortlist (similar
  songs & artists, mood matches, recently-added & frequent albums), caps it, asks the
  model to pick one. Cheaper and more forgiving. **Recommend turning the agent OFF**
  for small models (≤9B) or constrained hardware.

## Structured output & model class (the silent feature-breaker)
- Several features ask the model for **strict JSON** (a fixed shape): the request
  matcher, the candidate-pool picker, the library mood-tagger, and this very health
  report. A weak model "responds" but returns the wrong shape, the call fails schema
  validation, and the feature **silently degrades or falls back** — the station still
  plays, but requests mis-match, picks get worse, tagging stalls.
- The report exposes this as an **LLM → "structured output"** finding (a count of
  recent schema-validation failures). If you see it, the model choice is almost
  certainly the cause. **Recommend a general instruction-tuned model** (a ~12B+ local
  or a capable cloud model) and suggest turning **reasoning OFF** — "thinking" tokens
  can corrupt the JSON.
- **Code-specialised models** (names containing \`code\`/\`coder\`/\`codestral\`) are tuned
  for programming, not natural-language DJ links or structured output. They write
  stiff intros and routinely fail the JSON shape. Steer the operator to a general
  model even if the code model is "bigger".
- The report also exposes an **LLM → "model class"** finding when the chosen model
  looks code-specialised, or is small (≤~9–11B) while the agentic picker is ON. Pair
  this with the picker-agent and reasoning guidance below.
- Important: a model broken enough to fail structured output **also breaks this AI
  review** (it's a structured call too). So when these deterministic findings fire,
  trust them over the absence of a review — they're the signal that survives.

## Agent deadline (settings.llm.agentTimeoutMs, default 45000ms)
- Wall-clock budget for the agentic picker before it gives up and falls back to the
  pool. **Reasoning-heavy or cloud models routinely need 20–40s**, so keep the
  deadline generous (40–60s) for them. **Fast local models** can use a tighter
  deadline (15–25s) so a stall recovers quickly. If the picker keeps falling back,
  the deadline is likely too low for the chosen model.

## TTS engines — choose by system resources (settings.tts.defaultEngine / byKind)
- **piper** — CPU, ~30ms/word, always available, the universal fallback. Best default
  on any box; recommend it when CPU/RAM is limited.
- **kokoro** — CPU, ~300–800ms/line, more natural than Piper. Good on a box with CPU
  headroom and no GPU.
- **chatterbox / pocket-tts** — heavy PyTorch engines. Need the optional 'tts-heavy'
  sidecar (\`--profile tts-heavy\`); Chatterbox really wants a **GPU**. Recommend only
  when the operator has the GPU/RAM for it. If a configured heavy engine is
  unavailable, the DJ silently falls back to Piper (a warn, not an outage).
- **cloud** (OpenAI / ElevenLabs) — best quality, needs an API key, costs per
  character. Recommend for operators who want top quality and don't mind paying.
- Rule of thumb: tight resources → Piper (maybe Kokoro). GPU box → Chatterbox via the
  sidecar. Want best quality, happy to pay → Cloud.

## Pause when empty
Optional setting: when listeners hit zero it stops the AI work (picks, links, IDs)
while a fallback playlist keeps music flowing, then wakes the DJ when someone tunes
in. Suggest it to operators worried about token cost on an empty room.

## Mood tagging
A background tagger labels tracks (calm, energetic, reflective…); the DJ leans on
those tags to fit the time of day, weather, and show. Untagged tracks still play but
aren't matched by feel. If coverage is zero/low, recommend running the tagger.

## Web search (settings.search)
Backs the DJ's artist-news segments. 'duckduckgo' is the keyless default; 'tavily'
gives richer results but needs a key (SEARCH_API_KEY). If Tavily is selected without
a key, news segments can't fetch — tell them to add the key or switch to DuckDuckGo.

## Backups
There is a Backup feature (Admin → Backup) that exports settings, personas, custom
skills and library tags as a single archive, restorable later. **Proactively suggest
taking a backup** before big changes (re-tagging, switching providers) and on a
regular cadence — it's cheap insurance.

## Where to look when things break
The admin Debug page is a live snapshot (recent AI calls + success, mixer status,
log tail) — first stop when the stream stalls, the DJ goes quiet, or a voice sounds
wrong. The 'subwave-log-analysis' skill covers behaviour over time. 'subwave-deploy'
installs/updates; 'subwave-control' just starts/stops the stack.`;
