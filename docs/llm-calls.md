# LLM call inventory

Every model call in the controller goes through one of three primitives in `llm/sdk.js`
(`llm/internal/strategy/**`): `djAgent` (tool-loop agent), `djObject` (Zod-validated
structured output), or `djText` (free text). Each call carries a `kind` string — that is
what shows up in the telemetry ring buffer (`/admin/debug` → recent calls) and the durable
events log (`state/logs/events-*.jsonl`), and what the daily token budget tallies against.

This page lists every `kind`, grouped by primitive.

To benchmark how a given model handles these calls (small vs big, pool vs agent), use the
matrix harness: `cd controller && npm run llm-bench -- --models provider:model[,provider:model…]`
(`controller/scripts/llm-bench/` — reliability + rule checks per kind/scenario, console table +
JSON report; see the header of `cli.ts` for flags).

## Tool-loop agent calls (`djAgent` — multi-turn, with tools)

None of these fire when the admin UI's **Agentic picker** is set to **Candidate pool**
(`settings.llm.pickerAgent` off): the picks fall back to their one-call `djObject`
counterparts below, and the segment director swaps to the single-call `generateSegment`
path (code fetches the skill's data directly and inlines it).

| Kind | Where | What it does |
|---|---|---|
| `djAgentPick` | `broadcast/dj-agent.ts` | Session DJ on track-end: picks the next track + optionally writes a link, using the library tools (`llm/tools.js`) over `session.windowMessages()` |
| `djAgentRequest` | `broadcast/dj-agent.ts` | Handles a listener request inside the session (find the track, write the intro) |
| `djAgentSegment` | `skills/_agent.ts` | The segment director — runs skills (weather, news, traffic, curiosity, album-anniversary, library-deep-cut, web-search, operator skills) with the real-world data tools (`llm/segment-tools.js`) |

## Structured output (`djObject` — one call, Zod-validated)

| Kind | Where | What it does |
|---|---|---|
| `djAgentRepick` | `broadcast/dj-agent.ts` | Cheap repick when the agent's pick is unusable — one call constrained to the run's already-gathered candidate ids |
| `pickNextTrack` | `llm/internal/prompts/picker.ts` | The stateless pool picker (`music/picker.js`, dj-agent's fallback path) — one pick from the ≤18-candidate balanced pool |
| `matchRequest` | `llm/internal/prompts/request.ts` | Match a listener request against library candidates |
| `identifyRequest` | `llm/internal/prompts/request.ts` | Identify a vague request (web-resolve path) before matching |
| `generateSegment` | `skills/_agent.ts` | Pool-mode replacement for `djAgentSegment`: code picks the capability and fetches its data (`fetchSegmentData`), one call decides air-or-silence and writes the line (forced runs use it too when the picker is in pool mode) |
| `generateBanter` | `llm/internal/prompts/banter.ts` | Whole multi-voice banter exchange for guest shows, in one call |
| `generateProgrammePlan` | `llm/internal/prompts/programme.ts` | Per-episode producer plan (angle, per-hour feature topics, intro/outro notes) |
| `generateProgrammeIntroExchange` / `generateProgrammeOutroExchange` | `llm/internal/prompts/programme.ts` | Multi-voice programme open/close for guest shows |
| `generatePersona` / `generateShow` / `generateTheme` | `llm/internal/prompts/generate.ts` | Admin-UI generators (persona, show, theme drafts) |
| `tag-library` / `tag-library-batch` | `music/tagger-core.ts` | The mood tagger (single-track and batched) |
| `doctor:review` | `doctor.ts` | The doctor's LLM review of collected health checks |

## Free text (`djText` — one call, plain script out)

| Kind | Where | What it does |
|---|---|---|
| `generateIntro` | `llm/internal/prompts/scripts.ts` | Track intro |
| `generateLink` | `llm/internal/prompts/scripts.ts` | Between-track link (also the fallback when the pick agent is off or fails) |
| `generateStationId` | `llm/internal/prompts/scripts.ts` | Station ident |
| `generateHourlyTime` | `llm/internal/prompts/scripts.ts` | Top-of-hour time check |
| `generateSignoff` | `llm/internal/prompts/scripts.ts` | Session sign-off |
| `generateHandoffGreeting` | `llm/internal/prompts/scripts.ts` | Persona-change handoff greeting (doubles as the programme intro on a boundary) |
| `generateAdLib` | `llm/internal/prompts/scripts.ts` | Ad-lib segment |
| `generateProgrammeIntro` / `generateProgrammeOutro` / `generateProgrammeFeature` | `llm/internal/prompts/programme.ts` | Solo-host programme beats (feature is the fallback when the segment director can't run) |

## Not LLM calls (easy to confuse)

- `segment` and `doctor` in `broadcast/scheduler.ts` are `withTrace` span kinds wrapping
  the real calls above, not model calls themselves.
- `kind: 'link' | 'hourly' | 'request' | …` values in queue/announce code are announcement
  kinds — they decide which IPC file the WAV goes to (`say.txt` vs `intro.txt`) — not model calls.
- Embeddings (CLAP text/audio, `searchBySound`, audio moods) hit the analyzer service, not
  the LLM provider, and don't appear in this list.
