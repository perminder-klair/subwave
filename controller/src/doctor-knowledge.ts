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

## Daily token budget (settings.llm.dailyTokenCap / budgetSoftPct / exemptRequests)
- \`dailyTokenCap\` (0 = off) is a per-UTC-day token ceiling. It degrades in two tiers:
  at \`budgetSoftPct\`% of the cap ("soft") the DJ forces the cheap pool picker and
  mutes optional segments (links, station IDs, hourly, weather/news); at the cap
  ("hard") it makes NO model call and coasts on the LLM-free auto playlist — music
  never stops. Listener requests stay exempt through the hard cap unless
  \`exemptRequests\` is off.
- The report's **Tuning → token budget** finding projects today's burn rate against
  the cap ("on track to hit the cap ~15:00 UTC"). If it will exhaust early, advise:
  raise the cap, turn on **pause-when-empty** so idle hours don't spend tokens, or
  ease off reasoning / the agentic picker (both spend more per pick).
- A **soft tier of 0 or 100 disables graceful degrade** — the DJ goes from full to
  silent with no warning. Recommend ~80.

## Context window (settings.llm.numCtx, Ollama only)
- The Ollama context size. The **agentic picker** sends a system prompt + tool
  defs + candidates; too small a window truncates them, the agent can't call its
  "done" tool, and it falls back to the pool. Keep ≥8192 (16384 default) when the
  agentic picker is on, or turn the picker off. Not relevant for cloud providers.

## Max response size (settings.llm.maxOutputTokens)
- Per-call OUTPUT cap (distinct from the daily budget). 0 = strategy defaults
  (generous). A small value can truncate the agent's tool-call JSON mid-object,
  forcing a fallback. Leave at 0 unless a small-context local model needs it.

## Agent deadline vs measured latency
- Beyond the raw \`agentTimeoutMs\` value, the report compares it to the model's
  **p90 latency** (Tuning → agent deadline vs latency). If p90 crowds or exceeds the
  deadline, the agentic picker is timing out into the pool on most tracks — the
  operator is paying for session-aware picks and not getting them. Fix: raise the
  deadline, or run a faster/smaller model (or reasoning OFF).

## Broadcast stream encoders (settings.stream.* + archive)
- \`/stream.mp3\` is always on. Opus / FLAC / AAC mounts and the **hourly archive**
  are each a CONTINUOUS extra encoder = real, constant CPU. The hourly archive is
  the single biggest cost. On a small / loaded box, recommend disabling mounts the
  operator's players don't use (the web/native players only ever use MP3, optionally
  Opus). The report's **Tuning → broadcast encoders** finding weighs the count
  against host cores + load.

## Audio analysis features vs analyzer flavour (settings.audio.embeddings / vocalActivity)
- "Sounds-like" audio embeddings need the **heavy analyzer** (CLAP); vocal-range /
  talk-timing needs the heavy analyzer (Demucs). A LEAN build can't do either, so
  these toggles **silently no-op** on it. The snapshot's \`analyzer\` line states the
  measured capability: \`(heavy: CLAP yes)\`, \`(lean: no CLAP)\`, or \`(CLAP unknown)\`.
  ONLY claim the operator is on a lean build when it says \`lean\` or the report's
  Tuning section flagged it — never infer lean from \`analyzer local\` or from the
  toggles alone; \`unknown\` means the capability hasn't been probed yet, say so.
- The upgrade path depends on the deployment shape:
  - **Split stack** (\`analyzer sidecar\`): with docker compose, \`ANALYZER_HEAVY=1\`
    in .env + re-pull; on non-compose installs (Unraid, Portainer, plain
    \`docker run\`) change the analyzer container's image to
    \`ghcr.io/perminder-klair/subwave-analyzer-heavy\`. \`ANALYZER_HEAVY\` is a compose
    interpolation variable, so setting it on a container does nothing.
  - **All-in-one image** (\`analyzer local\` — the AIO bundles the analyzer
    in-process): switch the single container's image to
    \`ghcr.io/perminder-klair/subwave-aio-heavy\`. Do NOT point an AIO install at
    \`subwave-analyzer-heavy\` — that's the bare analyzer micro-service, and swapping
    the AIO container to it replaces the whole station with just an analyzer.
  - Or turn the setting off (it's costing nothing but false expectations).

## Listener-request web-resolve (settings.llm.requestWebResolve)
- Lets the request agent resolve *described* tracks ("that song from the advert")
  via web search — so it depends on Settings → Search being configured. If it's on
  while search isn't ready, the feature is dead; either configure search or turn it off.

## Where to look when things break
The admin Debug page is a live snapshot (recent AI calls + success, mixer status,
log tail) — first stop when the stream stalls, the DJ goes quiet, or a voice sounds
wrong. The 'subwave-log-analysis' skill covers behaviour over time. 'subwave-deploy'
installs/updates; 'subwave-control' just starts/stops the stack.`;
