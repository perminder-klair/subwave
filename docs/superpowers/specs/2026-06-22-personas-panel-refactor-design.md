# Personas panel — component split + roster/full-width redesign

**Date:** 2026-06-22
**Scope:** `web/components/admin/PersonasPanel.tsx` (admin `/admin/personas`)

## Problem

`PersonasPanel.tsx` has grown to ~1700 lines doing everything: data fetch, state,
validation, avatar mutations, and the full hero/roster/editor UI. It is hard to
read and edit. The layout also wastes space: the roster sits in a fixed `280px`
left column and the editor is squeezed into the remaining `1fr`, so on wide
screens cards (notably **Voice**) have a large empty right half while their
content stays in a narrow left strip.

## Goals

1. Split the file into focused, presentational sub-components under a new
   `web/components/admin/personas/` directory.
2. Move the roster from the left column to a **full-width selectable card strip**
   below the hero.
3. Make the editor (forms) **full width**.
4. Lay full-width cards out in responsive columns so the horizontal space is
   used — removing the empty-space problem, including in the Voice card.

## Non-goals

- **No behaviour/data change.** Same `Persona` shape, same `/settings` save
  payload, same validation rules, same avatar endpoints, same skills logic, same
  hero copy and system-prompt behaviour.
- No change to the admin route or its import (`PersonasPanel` default export at
  the current path stays the public entry point).
- Keep all accessibility already built (ToneKnob/VoiceMeter `role="slider"` +
  keyboard, roster items as `<button>`s).
- No unrelated refactoring beyond what serves this split.

## New layout (top to bottom, full width)

1. **Hero** — eyebrow · "The voices on your station." · `[System prompt]`
   `[+ Add persona]`; plus the live/active strip. *(unchanged content)*
2. **System prompt card** — toggled from the hero. *(unchanged)*
3. **Roster** — full-width band: `roster · N / 12` heading, then a responsive
   grid of persona cards that wraps as personas are added
   (`grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5`). Each card:
   avatar/initials, name, tagline, badges (frequency, `extended`, engine, voice,
   skill count, `incomplete`). The card being edited gets the vermilion
   border+outline; the on-air persona shows the dot + `on air` pill. A dashed
   `+ new persona` card is the last cell. Click selects → editor updates and
   scrolls into view.
4. **Editor** — full-width, for the focused persona. Header `Editing · <name>`
   with `Set on air` / `Remove`. Composed of the cards below + the save bar.

## Full-width card layouts (fill width, stay readable)

The editor is genuinely full width (no hard max-width). Cards use responsive
2-column splits so content fills the space; individual controls keep sensible
caps so ultra-wide monitors still look intentional.

- **Identity card** — `lg:grid-cols-2`: left = avatar + name + tagline +
  language; right = soul textarea (taller). AiFill spans the top.
- **Behaviour card** — `lg:grid-cols-2`: left = talk frequency + script length +
  DJ mode; right = tone dials (3 knobs). Knobs already responsive (80px phone /
  96px `md`+, stacked label on phone).
- **Voice card** — `lg:grid-cols-2`: left = engine `Seg` + the engine-specific
  voice selector (+ availability warnings); right = the voice-level meter. This
  is the empty-space fix, generalised. The `Seg` `w-fit` fix (tabs hug content,
  no dead bordered cell) stays.
- **Skills card** — full-width list rows (already fills the width).
- Long hint/description paragraphs get `max-w-[70ch]`; selects `max-w-[360px]`;
  the dB meter `max-w-[460px]` within its column.

## Component structure

New directory `web/components/admin/personas/`:

| File | Responsibility |
|---|---|
| `types.ts` | `Persona`, `PersonaTts`, `FormState`, `SettingsResponse`, `SkillCatalogEntry`, `VoiceOption` |
| `constants.ts` | `FREQUENCIES`, `SCRIPT_LENGTHS`, `TONE_DIALS`, `DIAL_NEUTRAL`, `toneBandIndex`, `ENGINES`, `KNOB_ROTATIONS`, `VOICE_CELLS`, regexes, `CB_DEFAULT_VOICE`, `*_MAX`, `PERSONA_MAX`, `AVATAR_TARGET_PX`, `DICEBEAR_STYLES`, `API_BASE` |
| `helpers.ts` | `clientMintId`, `initialsFor`, `fetchDicebearAvatar`, `fileToAvatarDataUrl`, `personaValid`, `voiceForSave`, `cloudIssue` |
| `ToneKnob.tsx` | rotary knob (moved as-is) |
| `VoiceMeter.tsx` | LED meter (moved as-is) |
| `RadioOption.tsx` | shared radio option (moved as-is) |
| `PersonaAvatarPicker.tsx` | avatar picker (moved as-is) |
| `PersonaHero.tsx` | hero + active strip |
| `SystemPromptCard.tsx` | system-prompt editor card |
| `PersonaRoster.tsx` | full-width selectable card strip (incl. the card) |
| `PersonaIdentityCard.tsx` | AiFill + avatar + name + tagline + soul + language |
| `PersonaBehaviorCard.tsx` | frequency + script length + DJ mode + tone dials |
| `PersonaVoiceCard.tsx` | engine + voice selector + voice level |
| `PersonaSkillsCard.tsx` | skills toggles |
| `PersonaEditor.tsx` | composes the four editor cards + save bar |
| `PersonasPanel.tsx` *(existing path)* | **container**: state, `/settings` fetch, validation, save, avatar mutations; renders hero + roster + editor |

## State ownership

`PersonasPanel` remains the single stateful container. It owns `form`,
`focusIdx`, `busy`, `avatarTick`, `uploadingId`, `showPrompt`, all mutators
(`setPersona`, `setPersonaTts`, `setPersonaSkills`, add/remove), avatar handlers,
and validation (`canSave`, `personaValid`). Every sub-component is presentational
— props in, callbacks out — so each can be read and reasoned about on its own.

## Verification

- `npm run lint` (eslint + `tsc --noEmit`) green — the merge gate.
- Visual check on the running dev stack: roster wraps and selects; editor is
  full-width; Voice card has no empty right half; knobs 80px on phone / 96px
  desktop; no horizontal overflow at 390px.

## Risks

- Largest risk is regressions while moving ~1700 lines. Mitigation: move logic
  verbatim, keep the data/validation/save paths byte-for-byte, lint + visual
  check after each card is extracted.
