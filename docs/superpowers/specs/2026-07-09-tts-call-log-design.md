# TTS call log in admin/debug — design

**Date:** 2026-07-09
**Ask:** the admin `/admin/debug` page has a "TTS routing" section; show a log of TTS calls with details there.

## Context

Every spoken segment already goes through `tts.speak()` (`controller/src/audio/tts.ts`),
which records one entry per call into the in-memory ring buffer `ttsCalls`
(`controller/src/stats.ts`, last 120 entries, lost on restart by design):

```
{ kind, engine, requested, fellBack, ok, ms, chars, error?, t }
```

Today that ring only feeds the Stats page **aggregates** (`summarizeTts`). The raw
entries are never exposed anywhere — the debug panel's TTS routing card shows only the
*prospective* routing snapshot (`describeRouting()`), not what actually aired.

## Approaches considered

- **A — expose the existing ring (chosen).** Enrich the recorded entries with the
  spoken text + persona, attach the ring to `/debug`, render it in the TTS routing
  card. Mirrors exactly how the LLM ring (`llm/log.ts` → `out.llm.recentCalls` →
  `LlmCalls`) and the Subsonic ring already work. No new state, no new endpoint.
- **B — durable `tts` events in events.jsonl.** Survives restarts, but heavier and
  inconsistent with the debug panel's other call lists, which are all since-boot rings.
  The durable timeline already gets TTS failures via console + can be added later.
- **C — point the operator at the Stats page.** Already exists, but it's aggregates
  only; the ask is per-call detail (what text, which engine, why it fell back).

## Design (approach A)

### 1. Controller — enrich the ring entries (`audio/tts.ts`)

`speak()` builds one shared `base` object used by all four `recordTts()` call sites
(success, fallback-unavailable failure, fallback success, fallback failure):

- `text` — the normalized spoken text, capped at 240 chars (ring is polled every 2s
  by the debug panel; keep the payload bounded).
- `persona` — the voicing persona's name for persona-voiced kinds, `null` for the
  global kinds (`jingle`, `default`). Uses the same `personaFor(persona)` override
  path as the rest of `speak()`, so handoff clips attribute correctly.

Additive fields only — `summarizeTts()` and the Stats page are untouched.

### 2. Controller — expose the ring (`routes/debug.ts`)

Section 6c becomes:

```ts
out.tts = { ...tts.describeRouting(), recentCalls: ttsCalls };
```

(`ttsCalls` imported from `../stats.js`.) Payload cost ≈ 120 × ~350 B ≈ 40 KB on a
snapshot that already carries the ~170 KB session — acceptable, and the existing
1 s single-flight cache bounds the assembly rate.

### 3. Web — render in the TTS routing card (`DebugPanel.tsx`)

- `DebugTts` gains `recentCalls?: TtsCall[]`; new `TtsCall` interface mirrors the
  ring shape.
- Card sub becomes `who voices the next spoken segment · N recent calls`.
- Below the existing routing row, a `TtsCallList`:
  - **Filter chips by kind** (all / dj-speak / link / station-id / …), same
    `FilterChip` component as the LLM list.
  - **Row** (collapsed `<details>` summary, same grid as Subsonic rows):
    ✓/✗ · kind · engine (with `↳ requested X` in danger tone when `fellBack`) ·
    chars · ms · time.
  - **Expanded:** spoken text, persona, error (via the shared `CallSection`).
  - Scrollable (`max-h`), empty state "no spoken segments yet".

### Error handling

- Ring exposure is inside the existing try/catch for `out.tts` — a failure degrades
  to `{ error }` like today.
- Old entries recorded before a controller update simply lack `text`/`persona`;
  the UI renders those fields only when present.

### Testing

- `npm run lint` in `controller/` and `web/` (the repo's merge gate; no test runner).
- Manual: covered by the entries the running station generates; the UI degrades
  gracefully with zero calls.

## Out of scope

- Durable/persistent TTS log across restarts.
- Recording the resolved voice id per call (voice resolution happens per-engine
  inside `speakWith()`; engine + requested + fellBack covers the routing question).
