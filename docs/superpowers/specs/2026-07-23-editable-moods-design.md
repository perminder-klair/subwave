# Editable Moods — Design

**Date:** 2026-07-23
**Status:** Draft for review
**Scope:** Make SUB/WAVE's mood system operator-editable, and give it (plus the festival calendar and the TTS speech-corrections dictionary) a **brand-new top-level admin page** in the sidebar — pulling all three out of Settings. Genres are already dynamic (pulled live from Navidrome) — no change there.

> **Page name — open decision.** The page anchors on **Moods** but also holds Festivals and Speech corrections. Proposed sidebar label: **"Moods"** (route `/admin/moods`), matching how we've been referring to it. Since it now also owns the festival calendar and the pronunciation dictionary, a broader label ("DJ", "Programming", "Voice") may read better — it's a one-line change in `NAV_SECTIONS`. Flagging for the review pass.

---

## 1. Goal

Today the mood system is hardcoded in source. `SHOW_MOODS` (17 entries, `controller/src/settings.ts:593`) is the single vocabulary, and three hardcoded maps derive an autonomous mood: the CLAP sound-prompt per mood (`MOOD_PROMPTS`, `music/audio-moods.ts:30`), the time-of-day → mood table (`context.ts:12`), and the weather → mood table (`context.ts:112`).

Make all four editable in the admin UI:

1. **The mood vocabulary** — add / remove / rename any mood (no protected built-ins), each with its CLAP sound-prompt.
2. **The CLAP prompt per mood** — the sound description used for zero-shot audio tagging.
3. **The time-of-day → mood map** — which mood each of the 8 fixed day-periods leans toward.
4. **The weather → mood map** — which mood each of the 6 fixed weather conditions leans toward.

All of this lives on **one new admin page** in the sidebar, which also absorbs the existing **Festivals** editor (festivals reference a mood, so the vocabulary and the calendar belong together) and the **Speech corrections** editor currently buried in the TTS voice tab. All three move *out* of Settings.

---

## 2. Design principles / constraints

- **Mirror the Festivals "seeded-but-editable" pattern exactly** — it's the established convention for an operator-editable list: a `*_DEFAULTS` constant, an `Array.isArray(stored.x) ? stored.x : DEFAULTS` seed guard in `load()`, a `validate*Strict()` that rebuilds and strips unknown keys, a `if ('x' in patch)` branch in `update()`, whole-object persistence, no Liquidsoap restart (mood selection is controller-side only, read live per context build).
- **Self-healing derived data.** Two hashes already fold the vocabulary + prompts into their cache keys: `moodVocabHash()` (audio moods, `audio-moods.ts`) and `promptVocabHash()` (LLM tags, `embeddings.ts:488`). Routing them through the settings-backed vocabulary means an edit auto-invalidates stale tags — audio moods re-score on the next analysis pass; LLM tags re-tag on the next `npm run tag --upgrade`. We reuse this machinery rather than build new invalidation.
- **Move static bindings to call-time reads.** Several consumers bind the vocabulary at module load (a Zod enum, tagger system-prompt strings, a `Set`). Those become call-time reads of a new settings accessor so edits take effect without a process restart.
- **YAGNI:** energy bands (`SHOW_ENERGY`) stay hardcoded — out of scope. No per-mood colour/icon metadata. No rename-with-cascade UI (see §6).

---

## 3. Data model (settings.json)

Three new top-level settings keys, all seeded-but-editable.

### 3.1 `settings.moods` — the vocabulary

```ts
// One entry per mood. `name` is the id used everywhere (shows, festivals,
// tagger, maps). `clapPrompt` is the audio sound-description; empty falls back
// to `${name} music` (the existing moodPrompt fallback).
type MoodEntry = { name: string; clapPrompt: string };
settings.moods: MoodEntry[]
```

Seeded from a new `MOOD_DEFAULTS` constant that merges the current `SHOW_MOODS` names with their `MOOD_PROMPTS` descriptions (moods with no prompt today — `festival`, `cultural`, etc. — seed with `clapPrompt: ''` and use the fallback).

**Empty is invalid** (unlike festivals, where empty = calendar off). The vocabulary must have ≥1 entry, because shows, festivals, the tagger, and the maps all draw from it. Validation enforces `1 ≤ length ≤ 40`.

### 3.2 `settings.moodSchedule` — time-of-day → mood

```ts
// Keyed by the 8 fixed period ids from context.ts getTimeContext.
// Only the mood is editable; hour-ranges, `vibe`, and `show` names stay in code
// (they feed spoken-segment prompts and show resolution — out of scope).
type Period = 'early-morning'|'morning'|'midday'|'afternoon'|'drive-time'|'evening'|'late-evening'|'after-hours';
settings.moodSchedule: Record<Period, string>  // value ∈ mood names
```

Seeded from `PERIOD_MOOD_DEFAULTS` (the current mapping): `early-morning→morning, morning→morning, midday→energetic, afternoon→focus, drive-time→driving, evening→evening, late-evening→night, after-hours→reflective`.

### 3.3 `settings.weatherMoods` — weather → mood

```ts
// Keyed by the 6 fixed condition ids from context.ts mapWeatherCode.
// '' means "no mood steer for this condition" (today's `default: null`).
type Condition = 'clear'|'cloudy'|'foggy'|'rainy'|'snowy'|'stormy';
settings.weatherMoods: Record<Condition, string>  // value ∈ mood names OR ''
```

Seeded from `WEATHER_MOOD_DEFAULTS`: `clear→sunny, cloudy→'', foggy→rainy, rainy→rainy, snowy→reflective, stormy→rainy`.

---

## 4. Server changes

### 4.1 `settings.ts`

- **Constants:** add `MOOD_DEFAULTS`, `PERIOD_MOOD_DEFAULTS`, `WEATHER_MOOD_DEFAULTS` beside `FESTIVAL_DEFAULTS` (~line 619). Register the three keys on `DEFAULTS` (~line 1236).
- **Keep `SHOW_MOODS`** as a derived export `= MOOD_DEFAULTS.map(m => m.name)` for any code that still wants the compile-time default names (and to avoid churn in tests). It is no longer the live source of truth.
- **New accessors (the migration seam):**
  - `moodVocab(): string[]` — current mood names from `getSettings().moods`.
  - `moodEntries(): MoodEntry[]` — full entries (for prompts + hashing).
  - `moodPromptFor(name): string` — the clapPrompt or `${name} music` fallback.
  - `moodScheduleFor(period): string` and `weatherMoodFor(condition): string` — map reads with default fallback.
- **Seeding in `load()`** (~line 2195): three `Array.isArray(stored.x) ? stored.x : X_DEFAULTS` guards. For `moods`, additionally fall back to `MOOD_DEFAULTS` when the stored array is empty (empty vocab is unusable).
- **Validation:** `validateMoodsStrict`, `validateMoodScheduleStrict`, `validateWeatherMoodsStrict` modelled on `validateFestivalsStrict` (`settings.ts:3181`). Rules:
  - moods: 1–40 entries; each `name` 1–40 chars, lowercased + trimmed, `[a-z0-9-]` normalised, **unique**; `clapPrompt` optional string ≤200 chars. Rebuild each object (strip unknown keys).
  - moodSchedule: exactly the 8 known period keys; each value ∈ the vocabulary being saved.
  - weatherMoods: exactly the 6 known condition keys; each value ∈ vocabulary **or** `''`.
- **`update()` branches** (~line 3506): `if ('moods' in patch)`, `if ('moodSchedule' in patch)`, `if ('weatherMoods' in patch)`. **No `restart = true`** (context-only). **Cross-validation across the merged `next` state** (see §6): reject removing a mood still referenced by a festival, a show, a schedule slot, or a weather slot, naming the referrer.
- **Existing `SHOW_MOODS.includes(...)` checks** at `settings.ts:878, 2911, 3204` → `moodVocab().includes(...)` (all inside functions — safe).

### 4.2 Consumers: static → call-time

| File | Now (static, module-load) | After |
|---|---|---|
| `music/audio-moods.ts:30` | `MOOD_PROMPTS` const, `moodPrompt`, `moodVocabHash`, `scoreAudioMoods` iterate `SHOW_MOODS` | read `settings.moodEntries()` / `moodPromptFor()`; hash folds settings vocab+prompts (already the design — just re-sourced) |
| `music/embeddings.ts:494` | `promptVocabHash` folds `MOOD_VOCAB` | fold `settings.moodVocab()` |
| `music/tagger-core.ts:21,36` | `TAGGER_SYSTEM` / `TAGGER_BATCH_SYSTEM` const strings embed `MOOD_VOCAB.join()` | become `taggerSystem()` / `taggerBatchSystem()` functions reading `moodVocab()`; update callers |
| `music/seed-selector.ts:40` | `MOOD_WORDS = new Set(SHOW_MOODS…)` const | `moodWords()` function reading `moodVocab()` |
| `llm/internal/prompts/generate.ts:67,72` | show schema built at module load with `z.enum(SHOW_MOODS)` + `.catch(SHOW_MOODS[0])` | build the show schema inside a function per call, reading `moodVocab()`; line 92 "Allowed moods" already dynamic |
| `context.ts:12` (`getTimeContext`) | inline period→mood literals | look up `settings.moodScheduleFor(period)` per period |
| `context.ts:112` (`weatherToMood`) | inline switch | `settings.weatherMoodFor(condition)` |
| `routes/library.ts:81,305,753` | `settings.SHOW_MOODS` | `settings.moodVocab()` |

### 4.3 API — `routes/settings.ts`

- **GET `/settings`:** add `moods`, `moodSchedule`, `weatherMoods` to the `values:` block (~line 102). Change the controlled-vocabulary export at line 149 from `moods: settings.SHOW_MOODS` → `moods: settings.moodVocab()`, so the **existing** Festivals + Shows mood dropdowns automatically pick up custom moods with zero client change.
- **POST `/settings`:** no new route — the generic write (`settings.update(req.body)`, line 199) already accepts the three new keys via the `in patch` branches.

---

## 5. Web UI — a new `/admin/moods` page

A brand-new top-level admin page, patterned on how existing self-contained pages (e.g. `/admin/debug`) are wired. Three tiny additions, no `SettingsPanel` involvement:

- **Route:** `web/app/admin/moods/page.tsx` — a thin server component mirroring `web/app/admin/debug/page.tsx` (`metadata.title = 'Moods'`, renders `<MoodsPanel />`). The admin layout (`app/admin/layout.tsx`) already wraps every child in `AdminShell`, so the auth gate applies automatically.
- **Sidebar entry:** one `NavItem` added to `NAV_SECTIONS` in `web/components/admin/AdminShell.tsx` (the "System" group, ~line 79, alongside Settings/Debug): `{ href: '/admin/moods', id: 'moods', label: 'Moods', icon: Palette }`, plus the icon added to the `lucide-react` import. Rendering + breadcrumb pick it up with no further change.
- **Panel:** `web/components/admin/MoodsPanel.tsx` — `'use client'`, self-contained (calls `useAdminAuth()` for its own `adminFetch`, like `FestivalsSection`). It fetches `/settings` once and stacks five cards:

  1. **Vocabulary** — a table of `{ name, CLAP prompt }` rows with add / edit / remove. A one-line note: *"Changing moods or their sound descriptions re-scores audio moods on the next analysis pass and marks LLM tags stale — re-run the tagger to refresh."* Saves `{ moods: [...] }`.
  2. **Time of day → mood** — 8 fixed period rows (labelled with their hour ranges), each a mood `<Select>` from the current vocabulary. Saves `{ moodSchedule: {...} }`.
  3. **Weather → mood** — 6 fixed condition rows, each a mood `<Select>` plus a "— none —" option. Saves `{ weatherMoods: {...} }`.
  4. **Festival calendar** — the existing `FestivalsSection` **composed as-is** (it already self-fetches/saves via `adminFetch` and reads the live vocabulary for its mood dropdown). No rewrite; just render `<FestivalsSection />` as a card on this page.
  5. **Speech corrections** — the pronunciation dictionary relocated from the TTS tab (see §5.1). Saves `{ tts: { corrections: [...] } }` (partial `tts` patch; the controller merges it).

Saving keeps the Festivals convention: whole-array/object replace POSTed to `/settings`; each card saves its own slice. Client-side validation stays light (server is authoritative): non-empty unique mood names, map values drawn from the current vocabulary.

### 5.1 Moving Speech corrections out of the TTS tab

The setting (`settings.tts.corrections`), its `validateTtsCorrectionsStrict`, its on-load normalise, and its runtime consumption (`audio/speech-text.ts` applied by `audio/tts.ts` reading `settings.get().tts.corrections`) are **all UI-location-agnostic — no controller change**. This is a pure front-end relocation:

- **Cut** from `web/components/admin/settings/TtsSection.tsx`: the `<Card title="Speech corrections">` block (`TtsSection.tsx:1106-1186`), the `correctionsDirty` computation (`:504-512`) and its term in `ttsDirty` (`:531`), and the `corrections:` key in TtsSection's `save()` payload (`:422-424`).
- **Rebuild** in `MoodsPanel` as the fifth card, reading/writing its own `corrections` `useState` seeded from the panel's `/settings` fetch, POSTing `{ tts: { corrections } }` (rows with an empty `from` dropped as drafts, matching current behaviour).

### 5.2 Removing the old Festivals section from Settings

- Remove the `festivals` entry from the `SECTIONS` registry in `SettingsPanel.tsx` (~line 41) and its self-contained render line (~line 607). `FestivalsSection.tsx` itself is **kept** (now imported by `MoodsPanel` instead).
- Existing deep-links to `/admin/settings?section=festivals` no longer resolve to a section; `SettingsPanel`'s `?section=` validator falls back to its default section (soft, no 404). Optional nicety: a `web/app/admin/archives`-style redirect isn't possible for a query-param section, so we accept the soft fallback (or add a small note in release copy).

No other web change needed — the first audit found only cosmetic mock data in `observatory/data.ts` (an empty-library preview), which stays as-is.

---

## 6. Edge cases & policy decisions

- **Removing / renaming an in-use mood (the one real rough edge).** A save is validated as declarative desired-state against the merged `next`. If a mood name disappears while a **festival**, **show**, **schedule slot**, or **weather slot** still references it, `update()` **rejects** with an error naming the referrer (e.g. *"can't remove 'driving' — used by the drive-time schedule slot and 1 show"*). This is consistent with the codebase's strict-validation philosophy and avoids silent misconfiguration. Because each card saves its own slice (the Festivals convention), the operator repoints references first, then removes the old mood — so a **rename is a two-step** (add the new name, repoint every referrer, remove the old). The reject error names exactly what to repoint. *Alternative considered:* auto-cascade (drop from shows, reset slots to a default) and/or an explicit "rename" affordance that repoints in one action. Rejected for v1 as more surprising and more code; can be added later.
- **Orphaned track tags.** Removing a mood leaves the string on already-tagged tracks (`tracks.moods`, `tracks.audio_moods`). Harmless — the value simply no longer matches anything in the vocabulary and drops out of `songsByMood`. No migration needed.
- **Adding a mood** does not retroactively LLM-tag the library; it takes effect for new tags and, via the vocab-hash bump, on the next `--upgrade` tagger run. Audio moods (heavy analyzer) re-score automatically next pass. The UI note in §5 surfaces this.
- **Prod vs dev.** Pure controller settings — persists to `settings.json`, read live per context build. No Liquidsoap restart, no rebuild in dev; prod picks it up on the running controller (settings are read at call time).

---

## 7. Testing

- **Unit (Node, `npm run test:llm` style / existing `scripts/*.test.ts`):** pin `validateMoodsStrict` / `validateMoodScheduleStrict` / `validateWeatherMoodsStrict` (valid + each rejection path, including in-use removal). Pin `moodVocabHash` / `promptVocabHash` change-detection when the settings vocabulary/prompts change. Extend `scripts/audio-moods.test.ts` for settings-sourced prompts.
- **Lint gate:** `controller/` and `web/` `npm run lint` (`eslint . && tsc --noEmit`) — the merge gate. Watch the `generate.ts` schema refactor for type fallout (the `z.enum` tuple type).
- **Manual smoke (dev stack):** add a custom mood → confirm it appears in the Festivals + Shows mood dropdowns; set a festival to it; change a period's mood and a weather condition's mood; confirm `getFullContext().dominantMood` reflects the edited maps; confirm a vocab edit bumps the hashes (audio re-score log line, tagger `--upgrade` re-tags).

---

## 8. Files touched (summary)

**Controller (moods only — speech corrections needs none):** `settings.ts` (constants, accessors, seeding, 3 validators, update branches), `context.ts` (2 maps → settings reads), `music/audio-moods.ts`, `music/embeddings.ts`, `music/tagger-core.ts`, `music/seed-selector.ts`, `llm/internal/prompts/generate.ts`, `routes/settings.ts` (expose 3 new keys in GET; `moods:` export → `moodVocab()`), `routes/library.ts`. Tests under `controller/scripts/`.

**Web:**
- **New:** `app/admin/moods/page.tsx`, `components/admin/MoodsPanel.tsx`.
- **Edited:** `components/admin/AdminShell.tsx` (one `NavItem` + icon import), `components/admin/settings/TtsSection.tsx` (cut the Speech-corrections card + its dirty-check/save-key), `components/admin/SettingsPanel.tsx` (drop the `festivals` section entry + render line).
- **Reused unchanged:** `components/admin/FestivalsSection.tsx` (now composed by `MoodsPanel`).

**No change:** genres (already dynamic), `SHOW_ENERGY`, the speech-corrections setting/validator/runtime (`settings.tts.corrections`, `audio/speech-text.ts`, `audio/tts.ts`), Liquidsoap / compose / `.env`, native app.
