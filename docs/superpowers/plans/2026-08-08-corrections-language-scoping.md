# Language-scoped speech corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each `settings.tts.corrections` row an optional language tag
so a correction only fires when the speaking persona's language matches;
untagged rows keep today's "always applies" behavior. Both the Speech tab's
row editor and the "Test corrections" preview (already shipped) get a
language dropdown (known list + free-text "Custom…").

**Architecture:** Extend the existing corrections shape (`{from, to}` →
`{from, to, language}`) through its two existing normalizers in
`settings/vocab.ts`. Add one pure matching predicate to
`audio/preview-text.ts` (which already owns the language-name lookup table).
Filter corrections by language at the TTS call sites (`speak()` and
`synthesizeSample()`) — `speech-text.ts` stays pure and language-unaware.
Web gets one new small shared dropdown component used in two places.

**Tech Stack:** Node.js/Express controller (TypeScript, ESM, `tsx`), Next.js
15 admin UI (TypeScript/React). No new dependencies.

## Global Constraints

- Every existing correction row (no `language` key) must normalize to
  `language: ''` ("All languages") — behavior for a pre-existing
  `settings.json` is byte-identical to before this branch.
- `speech-text.ts` (`normalizeForSpeech`/`applyCorrections`) does NOT learn
  about languages — filtering happens at the caller (`tts.ts`), confirmed
  architectural decision.
- New length cap: `TTS_CORRECTION_LANGUAGE_MAX = 80` chars, same pattern as
  the existing `from`/`to` caps.
- Matching is case/diacritic-insensitive, via the same `normalizeLanguage`
  `preview-text.ts` already uses for `persona.language`; an empty
  `personaLanguage` is treated as `"english"` for matching purposes only
  (mirrors the persona convention "empty = English").
- `GLOBAL_VOICE_KINDS` kinds (jingle/default — no persona) get `language:
  ''` in `speak()`, exactly as today's code already computes for its
  cloud-pronunciation-hint use — reuse that existing computation, don't
  duplicate it.
- `controller/` lint is `npm run lint`; tests are `npm test`
  (auto-discovers `scripts/*.test.ts`). `web/` has no test suite — verify
  with `npm run lint`.
- Known pre-existing, unrelated `npm test` failures (do not chase these):
  `airing.test.ts`, `analysis-failure.test.ts`, `embedding-dim-migrate.test.ts`,
  `observatory-scale.test.ts`, `stem-backfill.test.ts`.

---

### Task 1: Language-matching predicate + display list in `preview-text.ts`

**Files:**
- Modify: `controller/src/audio/preview-text.ts`
- Modify: `controller/scripts/preview-text.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export function normalizeLanguage(raw: string): string` (was
  module-private, now exported), `export function
  correctionAppliesToLanguage(correctionLanguage: string, personaLanguage:
  string): boolean`, `export const PREVIEW_LANGUAGES: string[]` — all three
  used by Task 3 (tts.ts) and Task 4 (routes/settings/core.ts).

- [ ] **Step 1: Write the failing tests**

Append to `controller/scripts/preview-text.test.ts`, right before the final
`process.exit(failures ? 1 : 0);` line (currently line 58), and add the new
imports to the existing import line at the top (currently line 9):

Change:
```ts
import { localizedPreviewText } from '../src/audio/preview-text.js';
```
to:
```ts
import {
  localizedPreviewText, correctionAppliesToLanguage, PREVIEW_LANGUAGES,
} from '../src/audio/preview-text.js';
```

Then add this block before `process.exit(...)`:

```ts
  console.log('correctionAppliesToLanguage:');
  await test('empty correction language always applies', () => {
    assert.equal(correctionAppliesToLanguage('', 'German'), true);
    assert.equal(correctionAppliesToLanguage('', ''), true);
    assert.equal(correctionAppliesToLanguage('   ', 'Japanese'), true);
  });
  await test('same language matches, case/diacritic-insensitive', () => {
    assert.equal(correctionAppliesToLanguage('Turkish', 'Türkçe'), true);
    assert.equal(correctionAppliesToLanguage('turkish', 'TR'), true);
  });
  await test('different languages do not match', () => {
    assert.equal(correctionAppliesToLanguage('German', 'French'), false);
    assert.equal(correctionAppliesToLanguage('Spanish', 'es-MX-not-a-real-code'), false);
  });
  await test('empty persona language is treated as English', () => {
    assert.equal(correctionAppliesToLanguage('English', ''), true);
    assert.equal(correctionAppliesToLanguage('German', ''), false);
  });
  await test('an unrecognized custom value only matches an identical custom value', () => {
    assert.equal(correctionAppliesToLanguage('Klingon', 'Klingon'), true);
    assert.equal(correctionAppliesToLanguage('Klingon', 'klingon'), true);
    assert.equal(correctionAppliesToLanguage('Klingon', 'Vulcan'), false);
  });

  console.log('PREVIEW_LANGUAGES:');
  await test('is a sorted, non-empty list of display names including English', () => {
    assert.ok(PREVIEW_LANGUAGES.length > 20);
    assert.ok(PREVIEW_LANGUAGES.includes('English'));
    assert.ok(PREVIEW_LANGUAGES.includes('Spanish'));
    const sorted = [...PREVIEW_LANGUAGES].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(PREVIEW_LANGUAGES, sorted);
  });
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `cd controller && npm test -- preview-text`
Expected: FAIL — `correctionAppliesToLanguage`/`PREVIEW_LANGUAGES` are not
exported yet (import/reference error).

- [ ] **Step 3: Implement**

In `controller/src/audio/preview-text.ts`, change the module-private
function (currently around line 82):
```ts
function normalizeLanguage(raw: string): string {
```
to:
```ts
export function normalizeLanguage(raw: string): string {
```

Then, after the existing `localizedPreviewText` function (currently ends
around line 102, right before the closing brace at line 102), append:

```ts

// Does a correction tagged `correctionLanguage` apply when speaking in
// `personaLanguage`? Empty `correctionLanguage` always applies (the "All
// languages" default). Otherwise compares normalized keys — the same
// diacritic/case-insensitive, name-or-code matching normalizeLanguage
// already does for persona.language. An empty personaLanguage is treated
// as "english", mirroring the persona convention (empty = English).
export function correctionAppliesToLanguage(
  correctionLanguage: string,
  personaLanguage: string,
): boolean {
  const c = (correctionLanguage || '').trim();
  if (!c) return true;
  const target = normalizeLanguage((personaLanguage || '').trim() || 'english');
  return normalizeLanguage(c) === target;
}

// English display name for each recognized language, for the admin
// correction-row / "Test corrections" language dropdowns
// (web/components/admin/LanguageSelect.tsx) — GET /settings surfaces this
// as tts.speechLanguages. Sorted for a stable, alphabetical dropdown.
export const PREVIEW_LANGUAGES: string[] = ENTRIES
  .map(e => {
    const k = e.keys[0];
    return k.charAt(0).toUpperCase() + k.slice(1);
  })
  .sort((a, b) => a.localeCompare(b));
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `cd controller && npm test -- preview-text`
Expected: PASS (`all passing` — well, this file uses the failures-counter
pattern, so 0 failures printed and process exits 0)

- [ ] **Step 5: Commit**

```bash
git add controller/src/audio/preview-text.ts controller/scripts/preview-text.test.ts
git commit -m "feat(controller): add correctionAppliesToLanguage matching + PREVIEW_LANGUAGES list"
```

---

### Task 2: `language` field on the corrections shape (`settings/vocab.ts`)

**Files:**
- Modify: `controller/src/settings/vocab.ts`
- Create: `controller/scripts/tts-corrections.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `normalizeTtsCorrections(raw: any): Array<{from: string; to:
  string; language: string}>` and `validateTtsCorrectionsStrict(raw: any):
  Array<{from: string; to: string; language: string}>` — both now include
  `language` in their return shape. Used by Task 3 (`tts.ts`) and already
  wired to `settings.ts`'s load/update paths (no change needed there — see
  Task 2 Step 5).

- [ ] **Step 1: Write the failing test file**

Create `controller/scripts/tts-corrections.test.ts`:

```ts
// Unit tests for the corrections normalizers (settings/vocab.ts) — the
// lenient load-path pass and the strict update()/PUT-settings pass. Both
// gained a `language` field (empty = "All languages") alongside the
// pre-existing `from`/`to`.
// Run: `npm test -- tts-corrections` (tsx scripts/tts-corrections.test.ts).

import assert from 'node:assert/strict';
import {
  normalizeTtsCorrections, validateTtsCorrectionsStrict, TTS_CORRECTIONS_LIMIT,
} from '../src/settings/vocab.js';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

async function main() {
  console.log('normalizeTtsCorrections (lenient load path):');
  await test('non-array input returns an empty list', () => {
    assert.deepEqual(normalizeTtsCorrections(undefined), []);
    assert.deepEqual(normalizeTtsCorrections(null), []);
    assert.deepEqual(normalizeTtsCorrections('nope'), []);
  });
  await test('a row with no language key defaults to empty string', () => {
    assert.deepEqual(
      normalizeTtsCorrections([{ from: 'GHz', to: 'gigahertz' }]),
      [{ from: 'GHz', to: 'gigahertz', language: '' }],
    );
  });
  await test('a row with a language string keeps it, trimmed', () => {
    assert.deepEqual(
      normalizeTtsCorrections([{ from: 'Ke$ha', to: 'Kesha', language: '  German  ' }]),
      [{ from: 'Ke$ha', to: 'Kesha', language: 'German' }],
    );
  });
  await test('a non-string language becomes empty string, not dropped', () => {
    assert.deepEqual(
      normalizeTtsCorrections([{ from: 'x', to: 'y', language: 42 }]),
      [{ from: 'x', to: 'y', language: '' }],
    );
  });
  await test('language is truncated at 80 chars', () => {
    const longLang = 'a'.repeat(90);
    const result = normalizeTtsCorrections([{ from: 'x', to: 'y', language: longLang }]);
    assert.equal(result[0].language.length, 80);
  });

  console.log('validateTtsCorrectionsStrict (strict update() path):');
  await test('throws on non-array', () => {
    assert.throws(() => validateTtsCorrectionsStrict('nope'), /must be an array/);
  });
  await test('throws over the entry cap', () => {
    const rows = Array.from({ length: TTS_CORRECTIONS_LIMIT + 1 }, (_, i) => ({ from: `w${i}`, to: `x${i}` }));
    assert.throws(() => validateTtsCorrectionsStrict(rows), /at most/);
  });
  await test('a row with no language key strict-validates to empty string', () => {
    assert.deepEqual(
      validateTtsCorrectionsStrict([{ from: 'GHz', to: 'gigahertz' }]),
      [{ from: 'GHz', to: 'gigahertz', language: '' }],
    );
  });
  await test('a valid language rides through, trimmed', () => {
    assert.deepEqual(
      validateTtsCorrectionsStrict([{ from: 'x', to: 'y', language: '  Spanish  ' }]),
      [{ from: 'x', to: 'y', language: 'Spanish' }],
    );
  });
  await test('throws when language exceeds the cap', () => {
    const longLang = 'a'.repeat(81);
    assert.throws(
      () => validateTtsCorrectionsStrict([{ from: 'x', to: 'y', language: longLang }]),
      /language must be at most/,
    );
  });
  await test('a non-string language coerces via String(), does not throw for a short value', () => {
    assert.deepEqual(
      validateTtsCorrectionsStrict([{ from: 'x', to: 'y', language: 42 }]),
      [{ from: 'x', to: 'y', language: '42' }],
    );
  });

  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exit(failures ? 1 : 0);
}

main();
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `cd controller && npm test -- tts-corrections`
Expected: FAIL — every row-shape assertion fails because `language` isn't
in the output yet (the pre-existing functions return `{from, to}` only).

- [ ] **Step 3: Implement**

In `controller/src/settings/vocab.ts`, the current block (starting around
line 182) reads:

```ts
export const TTS_CORRECTIONS_LIMIT = 100;
const TTS_CORRECTION_FROM_MAX = 80;
const TTS_CORRECTION_TO_MAX = 160;

// Lenient on-load pass: never throws, drops malformed entries so a
// hand-edited settings.json can't wedge boot.
export function normalizeTtsCorrections(raw: any): Array<{ from: string; to: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ from: string; to: string }> = [];
  for (const item of raw) {
    if (out.length >= TTS_CORRECTIONS_LIMIT) break;
    if (!item || typeof item !== 'object') continue;
    const from = typeof item.from === 'string'
      ? item.from.trim().slice(0, TTS_CORRECTION_FROM_MAX)
      : '';
    if (!from) continue;
    const to = typeof item.to === 'string'
      ? item.to.trim().slice(0, TTS_CORRECTION_TO_MAX)
      : '';
    out.push({ from, to });
  }
  return out;
}

// Strict update() validator — whole-array replace, indexed throws, rebuilt
// objects so unknown keys are stripped (the validateFestivalsStrict shape).
export function validateTtsCorrectionsStrict(raw: any): Array<{ from: string; to: string }> {
  if (!Array.isArray(raw)) throw new Error('tts.corrections must be an array');
  if (raw.length > TTS_CORRECTIONS_LIMIT) {
    throw new Error(`tts.corrections must be at most ${TTS_CORRECTIONS_LIMIT} entries`);
  }
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`tts.corrections[${i}] must be an object`);
    }
    const from = String(item.from ?? '').trim();
    if (from.length < 1 || from.length > TTS_CORRECTION_FROM_MAX) {
      throw new Error(`tts.corrections[${i}].from must be 1-${TTS_CORRECTION_FROM_MAX} chars`);
    }
    const to = String(item.to ?? '').trim();
    if (to.length > TTS_CORRECTION_TO_MAX) {
      throw new Error(`tts.corrections[${i}].to must be at most ${TTS_CORRECTION_TO_MAX} chars`);
    }
    return { from, to };
  });
}
```

Replace the whole block with:

```ts
export const TTS_CORRECTIONS_LIMIT = 100;
const TTS_CORRECTION_FROM_MAX = 80;
const TTS_CORRECTION_TO_MAX = 160;
const TTS_CORRECTION_LANGUAGE_MAX = 80;

// Lenient on-load pass: never throws, drops malformed entries so a
// hand-edited settings.json can't wedge boot. `language`: '' = "All
// languages" (matches every persona) — every pre-existing row (no
// `language` key) normalizes to '', so a settings.json written before this
// field existed is byte-identical in behavior.
export function normalizeTtsCorrections(raw: any): Array<{ from: string; to: string; language: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ from: string; to: string; language: string }> = [];
  for (const item of raw) {
    if (out.length >= TTS_CORRECTIONS_LIMIT) break;
    if (!item || typeof item !== 'object') continue;
    const from = typeof item.from === 'string'
      ? item.from.trim().slice(0, TTS_CORRECTION_FROM_MAX)
      : '';
    if (!from) continue;
    const to = typeof item.to === 'string'
      ? item.to.trim().slice(0, TTS_CORRECTION_TO_MAX)
      : '';
    const language = typeof item.language === 'string'
      ? item.language.trim().slice(0, TTS_CORRECTION_LANGUAGE_MAX)
      : '';
    out.push({ from, to, language });
  }
  return out;
}

// Strict update() validator — whole-array replace, indexed throws, rebuilt
// objects so unknown keys are stripped (the validateFestivalsStrict shape).
export function validateTtsCorrectionsStrict(raw: any): Array<{ from: string; to: string; language: string }> {
  if (!Array.isArray(raw)) throw new Error('tts.corrections must be an array');
  if (raw.length > TTS_CORRECTIONS_LIMIT) {
    throw new Error(`tts.corrections must be at most ${TTS_CORRECTIONS_LIMIT} entries`);
  }
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`tts.corrections[${i}] must be an object`);
    }
    const from = String(item.from ?? '').trim();
    if (from.length < 1 || from.length > TTS_CORRECTION_FROM_MAX) {
      throw new Error(`tts.corrections[${i}].from must be 1-${TTS_CORRECTION_FROM_MAX} chars`);
    }
    const to = String(item.to ?? '').trim();
    if (to.length > TTS_CORRECTION_TO_MAX) {
      throw new Error(`tts.corrections[${i}].to must be at most ${TTS_CORRECTION_TO_MAX} chars`);
    }
    const language = String(item.language ?? '').trim();
    if (language.length > TTS_CORRECTION_LANGUAGE_MAX) {
      throw new Error(`tts.corrections[${i}].language must be at most ${TTS_CORRECTION_LANGUAGE_MAX} chars`);
    }
    return { from, to, language };
  });
}
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `cd controller && npm test -- tts-corrections`
Expected: PASS (`all passing`)

- [ ] **Step 5: Confirm the call sites need no change, and typecheck**

`controller/src/settings.ts` calls `normalizeTtsCorrections(stored.tts?.corrections)`
(load path) and `validateTtsCorrectionsStrict(t.corrections)` (update path)
with no destructuring of the return shape — both just assign the whole
array — so they need NO edit. Confirm this by reading
`controller/src/settings.ts` around its two call sites (search
`normalizeTtsCorrections` and `validateTtsCorrectionsStrict` in that file)
and checking neither one names `from`/`to` individually.

Run: `cd controller && npm run lint`
Expected: PASS, no new `tsc`/`eslint` errors (this confirms nothing
downstream that destructured the old 2-field shape broke — if `tsc` finds
one, note it and fix it as part of this task, it means the plan missed a
call site).

- [ ] **Step 6: Commit**

```bash
git add controller/src/settings/vocab.ts controller/scripts/tts-corrections.test.ts
git commit -m "feat(controller): add language field to tts.corrections normalizers"
```

---

### Task 3: Filter corrections by language at the TTS call sites (`tts.ts`)

**Files:**
- Modify: `controller/src/audio/tts.ts`

**Interfaces:**
- Consumes: `correctionAppliesToLanguage` from Task 1
  (`./preview-text.js`); the `language` field on corrections rows from
  Task 2.
- Produces: `speak()` and `synthesizeSample()` both filter corrections by
  language before calling `normalizeForSpeech` — no new exported symbols,
  this is purely internal behavior.

- [ ] **Step 1: Add the import**

In `controller/src/audio/tts.ts`, change the existing import (currently
line 18):
```ts
import { localizedPreviewText } from './preview-text.js';
```
to:
```ts
import { localizedPreviewText, correctionAppliesToLanguage } from './preview-text.js';
```

- [ ] **Step 2: Filter in `synthesizeSample()`**

Currently (around lines 349-353):
```ts
  const raw = (typeof text === 'string' && text.trim())
    ? text.trim()
    : (localizedPreviewText(language) ?? DEFAULT_PREVIEW_TEXT);
  const activeCorrections = corrections !== undefined
    ? settings.normalizeTtsCorrections(corrections)
    : settings.get().tts?.corrections;
  const sample = normalizeForSpeech(raw.slice(0, PREVIEW_TEXT_MAX), activeCorrections);
```

Change to:
```ts
  const raw = (typeof text === 'string' && text.trim())
    ? text.trim()
    : (localizedPreviewText(language) ?? DEFAULT_PREVIEW_TEXT);
  // Same `language` value that picks the localized sample sentence above
  // also scopes which corrections apply — one selector, two effects (see
  // docs/superpowers/specs/2026-08-08-corrections-language-scoping-design.md).
  const previewLanguage = language || '';
  const activeCorrections = (corrections !== undefined
    ? settings.normalizeTtsCorrections(corrections)
    : settings.get().tts?.corrections || []
  ).filter(c => correctionAppliesToLanguage(c.language || '', previewLanguage));
  const sample = normalizeForSpeech(raw.slice(0, PREVIEW_TEXT_MAX), activeCorrections);
```

- [ ] **Step 3: Reorder + filter in `speak()`**

Currently (around lines 404-452), the function body starts:
```ts
export async function speak(
  text: string,
  { kind = 'default', outPath, speedScale, persona }: { kind?: string; outPath?: string; speedScale?: number; persona?: any } = {},
) {
  // Belt-and-suspenders scrub of any leaked reasoning at the single point every
  // booth-bound string converges (follow-up to #949). The free-text generators
  // already stripThinking their output, but a reasoning model that leaks a
  // <think>/harmony token INTO a structured say/intro field (djObject/djAgent
  // native path) reaches TTS unscrubbed otherwise. No-op on clean text — those
  // literals never appear in a real script — so every non-LLM caller (jingles,
  // idents, request intros) is unaffected. Operator speech corrections
  // (settings.tts.corrections) ride along — read live, so a saved rule
  // applies to the very next spoken line, no restart.
  const speakText = normalizeForSpeech(stripThinking(text), settings.get().tts?.corrections);
  // `persona` overrides the clock-driven effective persona so the persona-handoff
  // mic-pass can voice the outgoing DJ (engine, voice, language, soul, speed)
  // after the hour has flipped. Absent → getEffectivePersona(), i.e. today.
  const personaTts = djPersonaTts(kind, persona);
```
...(continues through `primaryText` around line 443)...
```ts
  const primaryText = requested === primary ? speakText : rescueText;
  // Persona on-air language (e.g. "French") rides along to the cloud engine as a
  // pronunciation hint so a non-English script isn't read with English phonetics
  // (issue #558). DJ-voiced kinds only — never jingles — and '' (ignored) for
  // the default English persona. Local engines ignore the field; only
  // cloud-speech.ts reads it (the voice model carries the language for piper /
  // kokoro / pocket-tts).
  const language = GLOBAL_VOICE_KINDS.has(kind)
    ? ''
    : String(personaFor(persona)?.language || '').trim();
```

The fix moves the `language` computation (and its comment) to BEFORE
`speakText` is built, and uses it to filter corrections. The corrections
comment changes from "ride along" to "scoped to `language`" since that's no
longer literally true otherwise. There is only ONE `language` const in the
function after this change — the later site is deleted, not duplicated.

Replace the opening of the function (from `export async function speak`
through the `const speakText = ...` line) with:

```ts
export async function speak(
  text: string,
  { kind = 'default', outPath, speedScale, persona }: { kind?: string; outPath?: string; speedScale?: number; persona?: any } = {},
) {
  // Persona on-air language (e.g. "French") — resolved FIRST because it now
  // also scopes which operator corrections apply below, in addition to its
  // original job as a pronunciation hint the cloud engine reads later in
  // this function (issue #558). DJ-voiced kinds only — never jingles — and
  // '' for the default English persona.
  const language = GLOBAL_VOICE_KINDS.has(kind)
    ? ''
    : String(personaFor(persona)?.language || '').trim();
  // Belt-and-suspenders scrub of any leaked reasoning at the single point every
  // booth-bound string converges (follow-up to #949). The free-text generators
  // already stripThinking their output, but a reasoning model that leaks a
  // <think>/harmony token INTO a structured say/intro field (djObject/djAgent
  // native path) reaches TTS unscrubbed otherwise. No-op on clean text — those
  // literals never appear in a real script — so every non-LLM caller (jingles,
  // idents, request intros) is unaffected. Operator speech corrections
  // (settings.tts.corrections) ride along — read live, so a saved rule
  // applies to the very next spoken line, no restart — filtered to rows
  // whose `language` matches this call's `language` (or is untagged).
  const activeCorrections = (settings.get().tts?.corrections || []).filter(
    c => correctionAppliesToLanguage(c.language || '', language),
  );
  const speakText = normalizeForSpeech(stripThinking(text), activeCorrections);
  // `persona` overrides the clock-driven effective persona so the persona-handoff
  // mic-pass can voice the outgoing DJ (engine, voice, language, soul, speed)
  // after the hour has flipped. Absent → getEffectivePersona(), i.e. today.
  const personaTts = djPersonaTts(kind, persona);
```

Then, further down, delete the NOW-DUPLICATE later block (the one that
used to compute `language` right after `primaryText`):

```ts
  const primaryText = requested === primary ? speakText : rescueText;
  // Persona on-air language (e.g. "French") rides along to the cloud engine as a
  // pronunciation hint so a non-English script isn't read with English phonetics
  // (issue #558). DJ-voiced kinds only — never jingles — and '' (ignored) for
  // the default English persona. Local engines ignore the field; only
  // cloud-speech.ts reads it (the voice model carries the language for piper /
  // kokoro / pocket-tts).
  const language = GLOBAL_VOICE_KINDS.has(kind)
    ? ''
    : String(personaFor(persona)?.language || '').trim();
```

becomes just:

```ts
  const primaryText = requested === primary ? speakText : rescueText;
```

(The `language` variable computed at the TOP of the function is still in
scope here and everywhere else it was used below — this is a pure
relocation, not a removal of functionality. `personaFor(persona)` is called
multiple times elsewhere in this function already — e.g. for
`speakingPersona`, `soul`, and the call-record `persona` field — so calling
it twice for `language`'s original vs. new position is consistent with the
function's existing style, not a new inefficiency.)

- [ ] **Step 4: Typecheck + full test suite**

Run: `cd controller && npm run lint && npm test`
Expected: lint clean; same pre-existing 5 unrelated failures, nothing new.

- [ ] **Step 5: Commit**

```bash
git add controller/src/audio/tts.ts
git commit -m "feat(controller): filter operator corrections by persona language at speak time"
```

---

### Task 4: Surface the language list on `GET /settings`

**Files:**
- Modify: `controller/src/routes/settings/core.ts`

**Interfaces:**
- Consumes: `PREVIEW_LANGUAGES` from Task 1 (`../../audio/preview-text.js`).
- Produces: `GET /settings` response gains `tts.speechLanguages: string[]`
  (top-level `tts` catalog block, NOT `values.tts`) — used by Task 6
  (`MoodsPanel.tsx`).

- [ ] **Step 1: Add the import**

In `controller/src/routes/settings/core.ts`, add to the import block
(after the existing `import * as piper from '../../audio/piper.js';` line,
currently line 20):
```ts
import { PREVIEW_LANGUAGES } from '../../audio/preview-text.js';
```

- [ ] **Step 2: Add the field to the response**

In the same file, the `tts:` catalog block (currently starting around line
151) reads:
```ts
      tts: {
        engines: tts.ENGINES,
        available: tts.availableEngines(),
        kokoroVoices: settings.KOKORO_VOICES,
        kokoroVoiceLanguages: settings.KOKORO_VOICE_LANGUAGES,
        kokoroLangs: settings.KOKORO_LANGS,
        voiceDir,
        piperVoices,
        chatterboxVoices: customVoices,
        // `chatterboxVoiceDir` kept as an alias of `voiceDir` so older UI
        // builds that haven't picked up the new field don't break.
        chatterboxVoiceDir: voiceDir,
        pocketTtsVoices: settings.POCKET_TTS_VOICES,
        pocketTtsCustomVoices: customVoices,
        cloudProviders: settings.TTS_CLOUD_PROVIDERS,
        frequencies: settings.FREQUENCIES,
        // The live mood NAMES, for the show/festival mood dropdowns. Now driven
        // by the operator-editable vocabulary rather than the static default.
        moods: settings.moodVocab(),
      },
```

Add one field, after `cloudProviders`:
```ts
        cloudProviders: settings.TTS_CLOUD_PROVIDERS,
        // English display names for the admin correction-row / "Test
        // corrections" language dropdowns (Moods → Speech tab). See
        // audio/preview-text.ts for the canonical matching table.
        speechLanguages: PREVIEW_LANGUAGES,
        frequencies: settings.FREQUENCIES,
```

- [ ] **Step 3: Typecheck**

Run: `cd controller && npm run lint`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add controller/src/routes/settings/core.ts
git commit -m "feat(controller): surface tts.speechLanguages on GET /settings"
```

---

### Task 5: Shared `LanguageSelect` web component

**Files:**
- Create: `web/components/admin/LanguageSelect.tsx`

**Interfaces:**
- Consumes: the Radix `Select` primitives already used throughout
  `MoodsPanel.tsx` (`../ui/select`), `Input` (`../ui/input`).
- Produces: `export function LanguageSelect({ value, onChange, languages,
  className }: LanguageSelectProps)` — a controlled dropdown + custom-text
  fallback. Used by Task 6 (`MoodsPanel.tsx`), twice (correction row +
  Test-corrections block).

- [ ] **Step 1: Write the component**

Create `web/components/admin/LanguageSelect.tsx`:

```tsx
'use client';
// A language picker for anything that matches against persona.language's
// free-text convention (Moods → Speech tab: per-correction language scoping,
// and the "Test corrections" preview). Dropdown of known languages + an
// "All languages" default + a "Custom…" option that reveals free text for
// anything not in the known list — same shape as the cloud-voice picker's
// preset+custom pattern elsewhere in admin, kept lightweight (no search
// dialog, no audio preview) since this list has no audition affordance and
// is short enough for a plain <Select>.
import type { ChangeEvent } from 'react';
import { Input } from '../ui/input';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '../ui/select';

// Radix Select forbids empty-string item values, so "All languages" and
// "Custom…" ride sentinels that map to/from the real value ('' and
// whatever free text the operator typed, respectively).
const ALL = '__all__';
const CUSTOM = '__custom__';
const CUSTOM_LANGUAGE_MAX = 80;

export interface LanguageSelectProps {
  // '' = all languages (the default); a known name from `languages`; or any
  // other free text (rendered as "Custom…" with the text box populated).
  value: string;
  onChange: (v: string) => void;
  // Known language display names (GET /settings tts.speechLanguages).
  languages: string[];
  className?: string;
  ariaLabel?: string;
}

export function LanguageSelect({
  value, onChange, languages, className, ariaLabel = 'Language',
}: LanguageSelectProps) {
  const isKnown = value !== '' && languages.includes(value);
  const isCustom = value !== '' && !isKnown;
  const selectValue = value === '' ? ALL : isKnown ? value : CUSTOM;

  return (
    <div className={className}>
      <Select
        value={selectValue}
        onValueChange={v => {
          if (v === ALL) onChange('');
          else if (v === CUSTOM) onChange(isCustom ? value : '');
          else onChange(v);
        }}
      >
        <SelectTrigger aria-label={ariaLabel}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All languages</SelectItem>
          {languages.map(l => (
            <SelectItem key={l} value={l}>{l}</SelectItem>
          ))}
          <SelectItem value={CUSTOM}>Custom…</SelectItem>
        </SelectContent>
      </Select>
      {selectValue === CUSTOM && (
        <Input
          aria-label="Custom language"
          value={value}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
          placeholder="Language name (e.g. Swahili)"
          maxLength={CUSTOM_LANGUAGE_MAX}
          className="mt-1.5"
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd web && npm run lint`
Expected: PASS, no new `tsc`/`eslint` errors. (Nothing imports this
component yet, so no behavior to verify beyond compilation.)

- [ ] **Step 3: Commit**

```bash
git add web/components/admin/LanguageSelect.tsx
git commit -m "feat(web): add LanguageSelect dropdown+custom component"
```

---

### Task 6: Wire language into `MoodsPanel.tsx`'s Speech tab

**Files:**
- Modify: `web/components/admin/MoodsPanel.tsx`

**Interfaces:**
- Consumes: `LanguageSelect` from Task 5 (`./LanguageSelect`); `GET
  /settings`'s `tts.speechLanguages` from Task 4; `VoicePreviewButton`'s
  pre-existing `language?: string` prop (unchanged by this plan — it
  already exists and already threads through to `synthesizeSample`, per
  Task 3's filtering).
- Produces: nothing consumed elsewhere — this is the leaf UI.

- [ ] **Step 1: Update the `Correction` interface**

Change (currently lines 24-27):
```ts
interface Correction {
  from: string;
  to: string;
}
```
to:
```ts
interface Correction {
  from: string;
  to: string;
  language: string;
}
```

- [ ] **Step 2: Import `LanguageSelect`**

Add near the other component imports (after the `VoicePreviewButton`
import, currently line 18):
```ts
import { LanguageSelect } from './LanguageSelect';
```

- [ ] **Step 3: Add `speechLanguages` state**

Add alongside the other `useState` declarations (after `const [testText,
setTestText] = useState('');`, currently line 91):
```ts
  const [speechLanguages, setSpeechLanguages] = useState<string[]>([]);
```

- [ ] **Step 4: Widen the `/settings` response type and read `tts.speechLanguages`**

The current response type (lines 97-112) only types the `values` field.
`tts.speechLanguages` lives in the TOP-LEVEL `tts` catalog block (a
sibling of `values`, not inside it — confirmed by reading
`routes/settings/core.ts`: `values.tts` is `s.tts` (the saved settings),
while the top-level `tts` key is the separate catalog of engines/voices/etc.
that this field was added alongside in Task 4). Add a new top-level field to
the type:

Change:
```ts
      const j = (await r.json()) as {
        values?: {
          moods?: unknown;
          moodSchedule?: unknown;
          weatherMoods?: unknown;
          tts?: {
            corrections?: unknown;
            defaultEngine?: string;
            kokoro?: { voice?: string };
            chatterbox?: { referenceVoice?: string };
            pocketTts?: { voice?: string };
            cloud?: { provider?: string; model?: string; voice?: string };
            speed?: Record<string, number>;
          };
        };
      } | null;
```
to:
```ts
      const j = (await r.json()) as {
        values?: {
          moods?: unknown;
          moodSchedule?: unknown;
          weatherMoods?: unknown;
          tts?: {
            corrections?: unknown;
            defaultEngine?: string;
            kokoro?: { voice?: string };
            chatterbox?: { referenceVoice?: string };
            pocketTts?: { voice?: string };
            cloud?: { provider?: string; model?: string; voice?: string };
            speed?: Record<string, number>;
          };
        };
        tts?: {
          speechLanguages?: string[];
        };
      } | null;
```

Then, in the same `load()` callback, the corrections line (currently line
119-120):
```ts
      const loadedCorr = Array.isArray(v.tts?.corrections)
        ? (v.tts!.corrections as Correction[]) : [];
```
needs no change — the server now always includes `language` in every row
(Task 2), so the cast is already accurate. But add the languages list read,
right after `const rawTts = v.tts || {};` (currently line 121) — insert a
new line reading from `j.tts` (the top-level field, NOT `v`/`values`):
```ts
      const rawTts = v.tts || {};
      const loadedSpeechLanguages = Array.isArray(j?.tts?.speechLanguages)
        ? (j!.tts!.speechLanguages as string[]) : [];
```

And add the corresponding `setSpeechLanguages` call alongside the other
`set*` calls in `load()` (right after `setSavedCorrections(loadedCorr);`,
currently line 136):
```ts
      setSpeechLanguages(loadedSpeechLanguages);
```

- [ ] **Step 5: Update `effectiveCorr` and the dirty check to carry `language`**

Currently (lines 197-201):
```ts
  const effectiveCorr = corrections
    .map(c => ({ from: c.from.trim(), to: c.to.trim() }))
    .filter(c => c.from);
  const correctionsDirty =
    JSON.stringify(effectiveCorr) !== JSON.stringify(savedCorrections.map(c => ({ from: c.from ?? '', to: c.to ?? '' })));
```
Change to:
```ts
  const effectiveCorr = corrections
    .map(c => ({ from: c.from.trim(), to: c.to.trim(), language: (c.language ?? '').trim() }))
    .filter(c => c.from);
  const correctionsDirty =
    JSON.stringify(effectiveCorr) !== JSON.stringify(savedCorrections.map(
      c => ({ from: c.from ?? '', to: c.to ?? '', language: c.language ?? '' }),
    ));
```

`saveCorrections` (currently lines 216-219) needs NO change — it already
sends `{ tts: { corrections: effectiveCorr } }`, and `effectiveCorr` now
carries `language` automatically.

- [ ] **Step 6: Add the language control to each correction row**

The row JSX (currently lines 402-439, inside the `tab === 'speech'` block's
first `<Card>`) is:
```tsx
                {corrections.map((c, idx) => (
                  /* Mobile: "on air" + bin on row one, "reads as" + spoken form on
                     row two — 220/260px inputs plus a label never fit the 320px a
                     card body leaves at 390px. `sm:justify-start` keeps the auto
                     tracks at content width. */
                  <div
                    key={idx}
                    className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[220px_auto_260px_auto] sm:justify-start"
                  >
                    <Input
                      aria-label="Text on air"
                      value={c.from}
                      onChange={e => setCorrections(list =>
                        list.map((row, i) => i === idx ? { ...row, from: e.target.value } : row))}
                      placeholder="text on air (e.g. GHz)"
                      maxLength={80}
                      className="col-span-2 col-start-1 row-start-1 min-w-0 sm:col-span-1"
                    />
                    <span className="col-start-1 row-start-2 shrink-0 text-[11px] text-muted sm:col-start-2 sm:row-start-1">reads as</span>
                    <Input
                      aria-label="Spoken form"
                      value={c.to}
                      onChange={e => setCorrections(list =>
                        list.map((row, i) => i === idx ? { ...row, to: e.target.value } : row))}
                      placeholder="spoken form (e.g. gigahertz)"
                      maxLength={160}
                      className="col-start-2 row-start-2 min-w-0 sm:col-start-3 sm:row-start-1"
                    />
                    <Btn
                      sm
                      title="Remove correction"
                      className="col-start-3 row-start-1 size-9 shrink-0 sm:col-start-4 sm:size-auto"
                      onClick={() => setCorrections(list => list.filter((_, i) => i !== idx))}
                    >
                      <Trash2 size={12} />
                    </Btn>
                  </div>
                ))}
```

Replace the whole `corrections.map(...)` block with a version that wraps
the existing row in a `<div>` and adds the language control as a second
line below it (keeping the existing grid untouched, so nothing about the
from/to/delete layout regresses):

```tsx
                {corrections.map((c, idx) => (
                  <div key={idx} className="flex flex-col gap-1.5 border-b border-ink/10 pb-2.5 last:border-b-0 last:pb-0">
                    {/* Mobile: "on air" + bin on row one, "reads as" + spoken form on
                        row two — 220/260px inputs plus a label never fit the 320px a
                        card body leaves at 390px. `sm:justify-start` keeps the auto
                        tracks at content width. */}
                    <div
                      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[220px_auto_260px_auto] sm:justify-start"
                    >
                      <Input
                        aria-label="Text on air"
                        value={c.from}
                        onChange={e => setCorrections(list =>
                          list.map((row, i) => i === idx ? { ...row, from: e.target.value } : row))}
                        placeholder="text on air (e.g. GHz)"
                        maxLength={80}
                        className="col-span-2 col-start-1 row-start-1 min-w-0 sm:col-span-1"
                      />
                      <span className="col-start-1 row-start-2 shrink-0 text-[11px] text-muted sm:col-start-2 sm:row-start-1">reads as</span>
                      <Input
                        aria-label="Spoken form"
                        value={c.to}
                        onChange={e => setCorrections(list =>
                          list.map((row, i) => i === idx ? { ...row, to: e.target.value } : row))}
                        placeholder="spoken form (e.g. gigahertz)"
                        maxLength={160}
                        className="col-start-2 row-start-2 min-w-0 sm:col-start-3 sm:row-start-1"
                      />
                      <Btn
                        sm
                        title="Remove correction"
                        className="col-start-3 row-start-1 size-9 shrink-0 sm:col-start-4 sm:size-auto"
                        onClick={() => setCorrections(list => list.filter((_, i) => i !== idx))}
                      >
                        <Trash2 size={12} />
                      </Btn>
                    </div>
                    <LanguageSelect
                      value={c.language ?? ''}
                      onChange={v => setCorrections(list =>
                        list.map((row, i) => i === idx ? { ...row, language: v } : row))}
                      languages={speechLanguages}
                      className="max-w-[260px]"
                      ariaLabel="Language this correction applies to"
                    />
                  </div>
                ))}
```

- [ ] **Step 7: Default new rows to `language: ''`**

Currently (line 446):
```tsx
                  onClick={() => setCorrections(list => [...list, { from: '', to: '' }])}
```
Change to:
```tsx
                  onClick={() => setCorrections(list => [...list, { from: '', to: '', language: '' }])}
```

- [ ] **Step 8: Add the language selector + updated hint to the Test-corrections block**

Add state alongside `testText` (currently line 91):
```ts
  const [testLanguage, setTestLanguage] = useState('');
```

The Test-corrections `<Card>` (currently lines 462-489):
```tsx
          <Card title="Test corrections" sub="hear a rule before saving, with the station's default voice">
            <div className="field">
              <div className="field-hint">
                Uses the corrections list above exactly as it stands right now, unsaved
                changes included, spoken by the station&apos;s default voice
                ({previewVoice.engine}).
              </div>
              <Input
                aria-label="Test sentence"
                value={testText}
                onChange={e => setTestText(e.target.value)}
                placeholder="Type a line using a word you corrected…"
                maxLength={200}
              />
              <VoicePreviewButton
                className="mt-3"
                engine={previewVoice.engine}
                voice={previewVoice.voice}
                cloudProvider={previewVoice.cloudProvider}
                cloudModel={previewVoice.cloudModel}
                speed={previewVoice.speed}
                text={testText}
                corrections={effectiveCorr}
                disabled={!testText.trim()}
                adminFetch={adminFetch}
              />
            </div>
          </Card>
```

Change to:
```tsx
          <Card title="Test corrections" sub="hear a rule before saving, with the station's default voice">
            <div className="field">
              <div className="field-hint">
                Uses the corrections list above exactly as it stands right now, unsaved
                changes included, spoken by the station&apos;s default voice
                ({previewVoice.engine}), filtered to rules matching{' '}
                {testLanguage ? <strong>{testLanguage}</strong> : 'all languages'}.
              </div>
              <Input
                aria-label="Test sentence"
                value={testText}
                onChange={e => setTestText(e.target.value)}
                placeholder="Type a line using a word you corrected…"
                maxLength={200}
              />
              <LanguageSelect
                value={testLanguage}
                onChange={setTestLanguage}
                languages={speechLanguages}
                className="mt-2 max-w-[260px]"
                ariaLabel="Language to test against"
              />
              <VoicePreviewButton
                className="mt-3"
                engine={previewVoice.engine}
                voice={previewVoice.voice}
                cloudProvider={previewVoice.cloudProvider}
                cloudModel={previewVoice.cloudModel}
                speed={previewVoice.speed}
                text={testText}
                language={testLanguage}
                corrections={effectiveCorr}
                disabled={!testText.trim()}
                adminFetch={adminFetch}
              />
            </div>
          </Card>
```

(`VoicePreviewButton` already accepts a `language?: string` prop — it
predates this plan and already threads through to `POST
/settings/tts/preview`'s `language` field, which Task 3 made do double
duty. No change to `VoicePreviewButton.tsx`/`previewApi.ts` is needed.)

- [ ] **Step 9: Typecheck**

Run: `cd web && npm run lint`
Expected: PASS, no new `tsc`/`eslint` errors.

- [ ] **Step 10: Commit**

```bash
git add web/components/admin/MoodsPanel.tsx
git commit -m "feat(web): wire language scoping into the Speech tab's corrections UI"
```

---

### Task 7: Manual end-to-end verification

**Files:** none (verification only)

**Interfaces:**
- Consumes: the full feature from Tasks 1-6.
- Produces: nothing — confirms the feature works before pushing.

- [ ] **Step 1: Start the dev stack**

The worktree's dev env is likely already prepped from the prior branch's
Task 6 (root `.env`, `state/settings.json`, `state/setup-config.json`
copied from the real install; `state/secrets.env` intentionally NOT
present — cloud TTS is unavailable in this worktree, `tts.defaultEngine`
was patched to `piper` for that reason). Confirm the dev stack isn't
already running from a prior session; if not:

```bash
docker compose -f docker-compose.dev.yml up -d
```

(No `--build` needed unless the controller container isn't already running
with `tsx watch` — bind-mounted `controller/src` picks up these edits live.)

```bash
cd web && npm run dev
```

(Skip if already running from a prior verification pass in this session.)

- [ ] **Step 2: Confirm on-air**

```bash
curl -sf http://localhost:7701/health
curl -sf -o /dev/null -w '%{http_code}\n' http://localhost:7700
```
Expected: `{"status":"on-air"}`, `200`.

- [ ] **Step 3: Golden path — row round-trip**

Open `http://localhost:7700/admin/moods?tab=speech`. Add a correction:
`from = "Ke$ha"`, `to = "Kesha"`, language = pick "German" from the
dropdown. Save. Reload the page. Confirm the row's language selector still
shows "German" (not reverted to "All languages" or "Custom…").

- [ ] **Step 4: Golden path — filtering actually filters**

Via `curl` against the running controller (same pattern as the prior
branch's Task 6 verification — see that task's report for the exact
admin-auth header construction), call `POST /settings/tts/preview` twice
with `engine: "piper"`, the same `text`, and `corrections: [{from: "Ke$ha",
to: "Kesha", language: "German"}]`, varying only `language`:
- `language: "German"` → expect the corrected ("Kesha") audio.
- `language: "French"` (or omitted) → expect the UNCORRECTED ("Ke$ha" as
  literally spoken) audio — confirm the two response WAVs differ from each
  other in the way the German-matching one differs from a no-corrections
  baseline (byte size difference is sufficient evidence, as established in
  the prior branch's verification).

- [ ] **Step 5: Edge cases**

- A row with no language set (or explicitly "All languages") still applies
  regardless of the `language` param sent — confirm against both a German
  and a French preview call.
- "Custom…" entry: type a language not in the dropdown (e.g. "Klingon"),
  save, reload, confirm it round-trips showing "Custom…" selected with
  "Klingon" in the text box.
- The Test-corrections block's own language dropdown: set it to a language
  with no matching correction rows, confirm the preview still plays (using
  only global rows, or the raw uncorrected text if there are none).

- [ ] **Step 6: Tear down (if this is the end of the session's testing)**

```bash
docker compose -f docker-compose.dev.yml down
```
And restore the operator's production station per the prior branch's
established procedure (`docker compose -f
~/subwave/docker-compose.yml up -d`, or wherever the real install lives —
confirm with the user before assuming, since this session already
established it's at `~/subwave`).

(No commit — this task is verification only.)

---

### Task 8: Push and update the pull request

**Files:** none

**Interfaces:** none

- [ ] **Step 1: Push**

This branch already has an open PR (#1350, `drachenhort:test-corrections-button`
→ `perminder-klair:develop`) from the prior "Test corrections button" work.
This feature is a follow-up on the SAME branch, so push updates it rather
than opening a new PR:

```bash
git push fork HEAD:test-corrections-button
```

- [ ] **Step 2: Update the PR description**

```bash
gh pr edit 1350 --repo perminder-klair/subwave --body "$(cat <<'EOF'
## Summary
- Adds a "Test corrections" control to admin → Moods → Speech: type a sentence, hear it synthesized through the station's default voice with the tab's current (including unsaved) correction rules applied.
- Each correction row can now be scoped to a language: a dropdown of known languages + "Custom…" free text, matched against the speaking persona's `language` field the same fuzzy way the existing voice-preview sample-sentence lookup already works. Untagged rows ("All languages") keep today's behavior exactly.
- `POST /settings/tts/preview` gains an optional `corrections` override (sanitized via the existing `normalizeTtsCorrections`) and its pre-existing `language` param now does double duty: picks the localized sample sentence AND scopes which corrections apply, in both the preview and the real on-air `speak()` path.

## Test plan
- [x] `cd controller && npm test` (full suite; only the 5 pre-existing unrelated failures, nothing new)
- [x] `cd controller && npm run lint`
- [x] `cd web && npm run lint`
- [x] Manual: server-side round trip proved the language filter actually filters (a German-tagged correction fires only when previewed with `language: "German"`)
- [x] Manual: row editor round-trip, including the "Custom…" language case
- [x] Whole-branch code review before merge

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Report the PR URL to the user**

---

## Self-Review Notes

- **Spec coverage:** data model + THREE-edit rule (Task 2), matching
  predicate (Task 1), real on-air filtering + reorder (Task 3), preview
  path double-duty `language` param (Task 3), catalog list surfaced to web
  (Task 4), shared dropdown component (Task 5), row + preview UI wiring
  (Task 6), manual verification (Task 7), PR update (Task 8) — every spec
  section has a task.
- **Placeholder scan:** none — every step carries literal code, exact
  file/line anchors, and exact commands.
- **Type consistency:** `{from, to, language}` shape is consistent from
  `settings/vocab.ts`'s two normalizers (Task 2) → `tts.ts`'s corrections
  filtering, which reads `.language` off whatever `normalizeTtsCorrections`
  or `settings.get().tts?.corrections` returns (Task 3) → web's
  `Correction` interface (Task 6) → `effectiveCorr`'s shape sent back to
  `POST /settings` (Task 6) and to `VoicePreviewButton`'s `corrections` prop
  (pre-existing prop, unchanged shape expectation — the prior branch typed
  it as `{from: string; to: string}[]`; confirm in Task 6 that TypeScript
  structural typing accepts the extra `language` field being passed there,
  which it will since `VoicePreviewButtonProps.corrections` doesn't need
  updating — an object with MORE fields than a variable-typed parameter
  expects is structurally assignable, only object LITERALS trigger excess
  property checks).
- **One deviation from the spec worth flagging to the reviewer**: the spec
  sketched the `speak()` reorder as introducing a NEW `speakingLanguage`
  variable; this plan instead relocates the EXISTING `language` const
  (which the current code already computes later in the function for the
  cloud pronunciation-hint use) to the top of the function and reuses it,
  deleting the later duplicate. Same behavior, less duplication — flagged
  here so it isn't mistaken for a missed requirement during review.
