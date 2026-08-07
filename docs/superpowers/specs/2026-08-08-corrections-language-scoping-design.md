# Language-scoped speech corrections — Moods → Speech tab

## Problem

`settings.tts.corrections` is a flat find-and-replace list applied to
**every** spoken line, regardless of which persona (and therefore which
language) is talking. A correction that only makes sense in one language
("Ke$ha" → "Kesha" is language-neutral, but a French pronunciation respelling
would be wrong applied to an English line, and vice versa) currently has no
way to be scoped. The admin can't tell a rule "only fire for German."

## Goal

Each correction row gets an optional language tag. Untagged (the default,
and what every existing row becomes on load) means "all languages" — today's
behavior, unchanged. A tagged row only fires when the speaking persona's
`language` matches. The Speech tab's row editor and the "Test corrections"
preview (shipped in the prior branch) both get a language selector: a
dropdown of known languages plus a "Custom…" free-text fallback.

## Non-goals

- No language selector on the Moments tab (mood/weather schedule )— confirmed
  out of scope; "moments" in the original request was a slip.
- No changes to how `persona.language` itself is set or validated — this
  reads that existing free-text field, never writes it.
- No translation of the correction's `to` text. The operator still writes
  the exact spoken form themselves, per language, as separate rows.

## Design

### Data model

`settings.tts.corrections[i]` gains a third field:

```ts
{ from: string; to: string; language: string }
```

`language: ''` = "All languages" (matches every persona). Non-empty = a
free-text language name, matched the same fuzzy way `persona.language`
already is (see Matching below). Every row that predates this feature loads
with `language: ''` — a settings.json written before this change is
byte-identical in behavior after it.

**Three edits, per this codebase's own rule for new settings fields**
(`controller/CLAUDE.md`, "A new settings field needs THREE edits"):

1. `controller/src/settings/defaults.ts` — no change needed; `corrections:
   []` stays the default, individual rows carry their own shape.
2. `controller/src/settings/vocab.ts`:
   - `normalizeTtsCorrections` (lenient, load path) — add `language: typeof
     item.language === 'string' ? item.language.trim().slice(0,
     LANGUAGE_MAX) : ''`.
   - `validateTtsCorrectionsStrict` (strict, `update()`/`PUT /settings`
     path) — same field, throwing on a non-string only if present and
     wrong-typed (mirrors how `from`/`to` are handled: coerce via
     `String(item.language ?? '')`, cap length, no lower bound since empty
     is valid).
   - New constant `TTS_CORRECTION_LANGUAGE_MAX = 80` (language names are
     short; matches the existing `from` cap for consistency, not because
     any real name is that long).
3. `controller/src/settings.ts` load composition (line ~734) — no separate
   edit needed, since `corrections: normalizeTtsCorrections(...)` already
   flows the whole object through; the new field rides inside the same call.

### Matching

New pure export in `controller/src/audio/preview-text.ts` (it already owns
`normalizeLanguage` and the ~29-language lookup table — the natural home,
no new module):

```ts
// Does a correction tagged `correctionLanguage` apply when speaking in
// `personaLanguage`? Empty `correctionLanguage` always applies (the "All
// languages" default). Otherwise compares normalized keys — the same
// diacritic/case-insensitive, name-or-code matching normalizeLanguage
// already does for persona.language. An empty personaLanguage is treated as
// "english", mirroring the persona convention (empty = English).
export function correctionAppliesToLanguage(
  correctionLanguage: string,
  personaLanguage: string,
): boolean {
  const c = correctionLanguage.trim();
  if (!c) return true;
  const target = normalizeLanguage(personaLanguage.trim() || 'english');
  return normalizeLanguage(c) === target;
}
```

`normalizeLanguage` is already exported-adjacent (module-private today) —
this task also exports it, since the new predicate needs it and so does a
future caller that wants the raw key.

### Real on-air path (`controller/src/audio/tts.ts`)

Today, `speak()` builds `speakText` (with corrections already applied) at
line 417, **before** resolving `speakingPersona` at line 438 — the persona
isn't known yet at the point corrections are applied, and jingle/default
kinds never resolve a persona at all. Fix: reorder so persona resolution
happens first, then filter corrections before normalizing.

Before (current):
```ts
const speakText = normalizeForSpeech(stripThinking(text), settings.get().tts?.corrections);
const personaTts = djPersonaTts(kind, persona);
const requested = requestedEngine(kind, personaTts);
const primarySlot = resolveEngine(kind, personaTts);
const primary = primarySlot.engine;
const primaryPersonaTts = primarySlot.personaTts ?? personaTts;
const speakingPersona = GLOBAL_VOICE_KINDS.has(kind) ? null : personaFor(persona);
```

After:
```ts
const personaTts = djPersonaTts(kind, persona);
const requested = requestedEngine(kind, personaTts);
const primarySlot = resolveEngine(kind, personaTts);
const primary = primarySlot.engine;
const primaryPersonaTts = primarySlot.personaTts ?? personaTts;
const speakingPersona = GLOBAL_VOICE_KINDS.has(kind) ? null : personaFor(persona);
const speakingLanguage = speakingPersona?.language || '';
const allCorrections = settings.get().tts?.corrections || [];
const activeCorrections = allCorrections.filter(
  c => correctionAppliesToLanguage(c.language || '', speakingLanguage),
);
const speakText = normalizeForSpeech(stripThinking(text), activeCorrections);
```

`GLOBAL_VOICE_KINDS` kinds (jingle/default) resolve `speakingPersona` to
`null` → `speakingLanguage` is `''` → matches "english" per the predicate
above, so a jingle only ever gets global-or-English-tagged corrections. This
is a deliberate, documented consequence, not an oversight: jingles have no
language concept, and "English" is the reasonable default to fall back to
for a station whose fallback text is written in English.

### Preview path (`synthesizeSample()` / `POST /settings/tts/preview`)

`synthesizeSample()` already accepts a `language` param (used today only to
pick a localized sample sentence when no explicit `text` is given). This
task makes it do double duty: the SAME `language` value also scopes which
`corrections` rows apply, via the identical `correctionAppliesToLanguage`
predicate used by `speak()`. One selector, two effects — no new param name,
no new route field.

In `synthesizeSample`, where the corrections override is resolved (the spot
the prior branch's consolidation fix landed):

```ts
const activeCorrections = corrections !== undefined
  ? settings.normalizeTtsCorrections(corrections).filter(
      c => correctionAppliesToLanguage(c.language, language || ''),
    )
  : settings.get().tts?.corrections?.filter(
      c => correctionAppliesToLanguage(c.language || '', language || ''),
    );
```

No change to the route (`routes/settings/tts.ts`) — it already forwards
`language` and `corrections` independently; this is entirely inside
`synthesizeSample`.

### Web: shared language options

New export from a small shared web module — **not** duplicated per
component. `GET /settings` gains `tts.speechLanguages: string[]` (English
display names, one per `preview-text.ts` `ENTRIES` row, e.g. `["Spanish",
"French", "German", …, "English"]`), added in `routes/settings/core.ts`
alongside the existing `kokoroVoices`/`piperVoices`/etc. list block. The web
side reads this off the same `/settings` payload `MoodsPanel.tsx` already
fetches — no new request.

### Web: row-level language selector

Each correction row (`MoodsPanel.tsx`, Speech tab) gains a third control. A
plain Radix `<Select>` (already imported in this file), matching the
existing `NONE` sentinel pattern used for the weather-mood "no steer" option
in the same file — **not** the heavier `VoicePicker` (that component's
cmdk-dialog-plus-per-row-audio-preview machinery is built for long voice
lists with audition, which a ~30-item, no-audio language list doesn't need).

- Options: "All languages" (sentinel, maps to `''`), each name from
  `tts.speechLanguages`, and "Custom…" (sentinel, reveals a free-text
  `Input` below the select, `maxLength={80}`, matching
  `TTS_CORRECTION_LANGUAGE_MAX`).
- A row whose stored `language` isn't in `speechLanguages` and isn't empty
  (a prior "Custom…" entry) shows the select on "Custom…" with the text box
  populated from the stored value — the same "unknown value stays visible,
  flagged" pattern `EngineVoiceFields.tsx` already uses for a missing voice.
- New rows (via "Add correction") default to `language: ''` (All
  languages), unchanged from today.

Row layout: the existing grid (`from` / "reads as" / `to` / delete) gains a
new line for the language control. Mobile and desktop breakpoints follow the
same `grid-cols` pattern already used for the from/to wrap — full design
left to the implementer to fit alongside the existing row, matching its
visual density.

### Web: Test-corrections preview language

The "Test corrections" block (prior branch) gains the same dropdown
(reusing whatever shared piece the row picker above uses — a single
component, two call sites), defaulting to "All languages". Passed as both
`language` (existing prop, now double-duty) — no new prop needed. The
field-hint copy gets one clause added: "…spoken by the station's default
voice, filtered to rules matching **{selected language, or "all
languages"}**."

## Testing

- `correctionAppliesToLanguage` (new pure function in `preview-text.ts`):
  unit tests alongside the existing `preview-text.test.ts` — empty
  correction language always matches; case/diacritic-insensitive match
  ("Turkish" vs "Türkçe"); no match across different languages; empty
  persona language treated as English; a "Custom…" value that doesn't
  resolve to any known key only matches an identical custom persona value.
- `normalizeTtsCorrections`/`validateTtsCorrectionsStrict` `language` field:
  extend whatever existing test coverage they have (check first — the prior
  branch's final review noted no dedicated test file was found for
  `normalizeTtsCorrections`; if true, this is the moment to add one, since
  we're changing its shape).
- `tts.ts`'s reordered `speak()`: this is the highest-risk change in the
  set (a reorder in a function with heavy existing behavior) — needs either
  a targeted unit test around the new filter step if one is feasible without
  standing up real engines, or explicit manual verification (a persona with
  `language: 'German'`, a correction tagged German, a correction tagged
  French, confirm only the German one fires; a jingle/default kind, confirm
  only global + English-tagged rows fire).
- Manual: row editor round-trip (add a tagged row, save, reload, confirm the
  tag persisted and the select shows the right value, including the
  "Custom…" case for an unlisted language).
