# CLAUDE.md — `controller/`

Express on Node: TypeScript run by `tsx`, with `.js` import specifiers. `src/server.ts` is the thin entry and everything else is grouped by domain under `src/`. Each module's header comment holds its reasoning, and the test that pins it usually restates it, so read both before changing a module. The domain reasoning is in `docs/internals/`; the cross-cutting invariants are in the root `CLAUDE.md`.

## Settings

- **A new settings field needs the THREE edits** (four for a new top-level key):
  1. its `DEFAULTS` entry (`settings/defaults.ts`);
  2. its update path: a schema in `settings/patch-registry.ts`, or a branch in `settings.ts` `prepareUpdate()`. An LLM leg field goes in `settings/vocab.ts` `applyLlmLegPatch` instead, and in `LLM_LEG_FIELDS` (`settings/llm-swap.ts`);
  3. a line in `load()`'s composition for its section;
  4. for a new top-level key, an entry in `SETTINGS_PATCH_KEYS`.

  `load()`'s section blocks compose explicitly and do not spread `DEFAULTS`, so a field missing there still validates, saves and works until the next cold load, then silently vanishes. That has bitten twice (`tts.cloud.compatParams` #1317, `llm.repeatPenalty` #1327). Pin a new field with a cold-load round trip (`setCache(null)` + `load()`, as in `scripts/llm-repeat-penalty.test.ts`); an in-process assertion passes on the broken code.
- `load()` is lenient and never throws, so a hand-edited `settings.json` cannot wedge boot. `update()` is strict, and a `validate*Strict` rethrows a plain `Error`, never a raw `ZodError`, because backup restore and `POST /settings` answer `{ error: err.message }` (`util/zod-error.ts` has the readable-message helpers).
- The custom DJ prompt template must keep `{name}`; `update()` refuses one that drops it.
- `src/schemas/` is mirrored into one flat web file, so every top-level name across `schemas/*.ts` shares one scope, module-private ones included; `gen-schemas.ts` throws on a duplicate.

## Env and secrets

- Read env through `util/env.ts` (`envInt`, `envFloat`, `envUrl`, `envEnum`, `envStr`), never `parseInt(process.env.X || …)`, whose NaN travels. A malformed value warns and falls back, never throws, and the warnings reach the booth log. A few legacy `parseInt` reads remain; don't add more.
- `state/secrets.env` has one parse (`setup/secrets.ts` `readSecretsFile`), shared by boot and `saveSecrets`' read-then-rewrite merge, and `envEscape` is its designed writer. A second parse that misreads a value destroys that secret on the next save.

## LLM layer (`llm/`)

- DJ model calls go through the AI SDK primitives in `llm/sdk` (`djText`, `djObject`, `djAgent`), which carry retry, failover and deadlines. The per-leg connection tests (`routes/settings/llm.ts`) and embeddings call the SDK directly, since a credential test must exercise exactly one leg. Outside `llm/`, import only the barrels (`llm/{sdk,provider,dj,agent,tools,segment-tools,speech,log}`), never `llm/internal/**`. Six older imports break this; don't add a seventh.
- Per-provider behaviour is a capability descriptor in `llm/internal/provider/capabilities.ts`, a pure function of the leg's cfg, and strategy code never branches on `provider ===`. Which providers exist, their labels, keys and embedding defaults, is the catalogue in `schemas/providers.ts`; a fixed-endpoint OpenAI-compatible gateway is one entry there (`docs/internals/music.md` → Adding an LLM provider).
- Each leg keeps its own settings: the primary's `geminiSafety` must never reach the fallback. Anything captured at client construction (custom headers, `repeat_penalty`, `num_ctx`) belongs in the client cache signature, or an edit reads as ignored until restart and the fallback reuses the primary's client.
- Gemini safety rides per-call `providerOptions`, because construction options never reach the request. The mapping is binary on purpose: the operator decides whether a category can be blocked at all, not a per-category threshold.
- The agent loop makes exactly one forced-`done` attempt per run at any budget (`gatedMaxStepsFor` derives the step cap). The discovery budget is opt-in per agent (`providerDiscoveryBudget`), and a prompt may promise only `legs.promptDiscoverySteps()`, the minimum across legs. The headers of `capabilities.ts`, `strategy/plan.ts` and `core/failover.ts` explain the cascade and the failover windows.
- Picker tools: one file per tool under `internal/tools/picker/tools/`. A tool that needs a backing index declares an `available` gate, so it is never offered without one. Every pick constraint travels as one `PickerScope` (`picker/scope.ts`), never unpacked into per-field lists. An empty answer is `emptyResult`, never a bare `[]`, which is what makes a model fabricate an id. A tool deadline is real only through `withToolDeadline`, because ai@7 never races `execute()`.
- AI SDK tool definitions carry no `outputSchema`: ai@7 neither sends nor validates it. `mcp/tools.ts` keeps its output schemas because there they are the published contract.
- Pick ids are `z.string()`, never `z.enum(ids)` (#939): an enum turns a two-character slip into a Zod reject before `nearestId` can repair it.
- `llm/instructions/*.md` are source, not operator config. They ship in the image and are never read from `state/`, because the picker prompt is coupled to the harness (`finding-candidates` must agree with `discoverySteps`) and a broken one breaks the core loop. The operator's prompt surfaces stay separate: persona souls, `djHouseRules`, SKILL.md briefs.

## Picking and requests

- `broadcast/dj-agent.ts` picks through `llm.trackSelection` (`agentic` or `shortlist`). Both routes run inside `pickViaSelectionRoute`, sharing the guards, the breaker and pool recovery, and `music/picker.ts` is the stateless pool fallback. `trackSelection` is the only route switch (`pickerAgent` is derived for old clients). The Musical Leanings review is one pass for both routes (`dj-agent/leanings-pass.ts`). See `docs/internals/music.md` → Track Shortlist discovery parity, and → Direct listener requests.
- Listener-request safety is `util/request-guard.ts`, and whether an ack or intro names the queued track is `util/request-claim.ts`. Both serve `routes/request.ts` and the agent's request path; inline neither.
- A per-client limiter map is a `util/bounded-key-map.ts`, never a hand-rolled `Map` with its own cleanup.

## Broadcast

- `broadcast/queue.ts` (helpers in `queue/`) owns the five polled handoff files (`next.txt`, `jingle-now.txt`, `say.txt`, `intro.txt`, `sfx.txt`). `auto.m3u` is `broadcast/scheduler.ts`'s, `jingles.m3u` is `broadcast/jingles.ts`'s, and `liquidsoap_*.txt` are `settings/liquidsoap.ts`'s. Tracks go through `queue.push()`, scheduled speech through `queue.announce()`/`announceExchange()`. `djLog` is operator diagnostics behind `requireAdmin`; the public `GET /state` and `GET /session` reads are explicit allowlists in `util/public-feed.ts`, never a spread of `snapshot()` or of turn `meta`.
- `broadcast/scheduler.ts` runs node-cron. All scheduled talk is the one `talkTick` over `broadcast/talk-scheduler.ts`. Every auto-playlist rebuild trigger lives here (the timer, an active-show change through `rollSessionNow`, a coast handover through `broadcast/coast-handover.ts`, settings and episode-preparation changes): add a new one beside them, never as a second cron.
- Jingles: `broadcast/jingles.ts` `rewritePlaylist` is the one write of `jingles.m3u`, and it schedules the debounced `jingles.reload` itself. Never gate that reload on the controller's own `jingleRatio`/`jingleRotate`: the mixer built its rotate from the ratio it read at startup. `scripts/generate-jingles.sh` writes no `jingles.json`, so its list lasts only until the controller's next rebuild. A repeated press is de-duplicated (409 while pending), never rate-limited, and pending entries expire on their own, so a mixer restart can never wedge the button.
- Over-music IDs (`jinglePlacement: over | both`, default `between`): `broadcast/jingle-overlay.ts` decides, and `queue.maybeAirJingleOverlay()`, driven by the now-playing watcher, writes the ID to `intro.txt` through the shared `airVoice` lock. It is the one automatic talker outside the slot table, so it stands down to any speech, including speech still being written (`queue.whileTalkInFlight`). In `both` it rides the rotate's own count and can never share a song with it. It publishes no `voice.*`/`dj.say` webhook. Both opt-ins force controller ownership without overwriting the saved `jingleRotate`. See `docs/internals/broadcast.md` and `scripts/jingle-overlay.test.ts`.
- `context.ts` `getFullContext()`: `dominantMood` is show > festival > weather > time. Open-Meteo is cached and a failure backs off, because `/now-playing` reaches it on every listener poll.

## TTS (`audio/`)

- `audio/tts.ts` dispatches every voice, and callers use `tts.speak(text, {kind})`. A persona slot may name `inherit` (`PERSONA_TTS_INHERIT`, deliberately not in `TTS_ENGINES`): resolve it once where the slot is read (`resolvePersonaVoiceSlot`). The lenient load path repairs a bad engine to `piper`, never to `inherit`. The per-engine voice rules live once, in `schemas/persona.ts`.
- Chatterbox and PocketTTS run in the `tts-heavy` sidecar (`--profile tts-heavy`) when `TTS_HEAVY_URL` is set, else as local Python workers; both paths must keep working.
- The clone-reference folder (`audio/voice-library.ts`) has no JSON sidecar on purpose: operators drop files into it by hand, and a sidecar would hold no entry for those. Bracket cues (`[laugh]`) are offered to the model only for an engine that renders them, judged on the resolved slot.

## Skills (`skills/`)

- Every skill is a directory, `state/skills/<slug>/` (`SKILL.md` plus an optional `tool.mjs`). The seven built-ins are seeded once from `src/skills/builtins/`, and the operator's file wins after that. A skill with a `feed:` and no `tool.mjs` gets a generated feed tool (`skills/feed.ts`); news ships that way.
- `writeSkillFile` rewrites SKILL.md from typed fields. It must carry through every key it doesn't own (`preservedFrontmatter`) and quote only what would not round-trip, because operators hand-edit these files.
- A forced run that gets `{ available: false }` stands down (`skills/abstain-policy.ts`). "Empty" is the tool's knowledge: a drained feed returns `{ available: false, reason }`, never `{ headlines: [] }`. Don't teach `unusableDataReason` one tool's output shape.
- Code that arrives by zip import or backup restore lands as `tool.mjs.pending`. It goes live only through `POST /dj/skills/:slug/tool/trust` with the SHA-256 of the source the operator was shown, because the loader imports every `tool.mjs` on every scan, enabled or not.

## Backup and personas

- `backup/zip.ts` is the one archive assembly. Retention may only name the anchored `subwave-auto-backup-…` grammar (`backup/pure.ts`), because `GET /backup/restorable` lists every `*.zip` in the state dir. Restore routes sidecars through their owners (`jingles.restoreMeta`, `sfx.restoreMeta`, `skills/install.ts`).
- `personas/install.ts` is the one path for a community install and a bundle import (the admin roster still adds through `settings.update()`). A bundle import reserves its filenames and dry-runs validation before writing a byte. A clashing audio filename is suffixed and the persona re-pointed at it, never overwritten.

## HTTP

- `middleware/http.ts` sets helmet with three deliberate choices: CORP `cross-origin` (artwork, avatars and previews load cross-origin), CSP off (no documents are served here) and HSTS off (TLS belongs to the edge).
- With `NODE_ENV=production` the admin gate is mandatory: the controller exits on boot without `ADMIN_USER`/`ADMIN_PASS`.
- Keep the station archive (`state/archive`) out of the Navidrome library. `subsonic.isStationArchive` is only the second guard.
