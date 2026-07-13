# Slate cards for /admin/skills and /admin/personas

**Date:** 2026-07-13
**Status:** approved (pending spec review)
**Scope:** `web/components/admin/SkillsPanel.tsx`, `web/components/admin/personas/PersonaRoster.tsx`, plus a small shared-chip extraction into `web/components/admin/ui.tsx`.

## Why

PR #1025 (`feat(admin): redesign show cards`) promoted each show on `/admin/shows`
from a plain `Card` (colour dot + grey summary line + right-rail Edit button)
into a "broadcast slate": a full-card click target with a left colour spine, a
prominent face, mode kickers, a bold name, a right-rail metric + "Edit →"
affordance, a scannable facet-chip row, and an italic brief.

Skills and personas were the *template* shows were built from — their own source
comments still say so:

- `SkillsPanel.tsx` show rows were described as "matching the skills list".
- `PersonaRoster.tsx`: "a list of cards … matching the skills list: avatar +
  tagline + meta pills on the left, status pills + Edit on the right."

So the two panels are now the last holdouts of the pre-#1025 pattern. This spec
ports the slate treatment to both, keeping each panel's own semantics.

## The slate anatomy (from #1025)

The reusable shape, as `ShowDefRow` implements it:

1. `<article role="button" tabIndex={0}>` — the whole card is the edit target,
   keyboard-accessible (`Enter`/`Space`), `focus-visible` ring, `aria-label`,
   `hover:bg-[var(--ink-softer)]`.
2. A left **colour spine** — `absolute inset-y-0 left-0 w-1`, widening to
   `w-1.5` on `group-hover`.
3. A **face** column (`size-12`, initials-behind-`<img>` fallback).
4. **Kicker pills** above the name (mode/identity flags).
5. A bold **name** (`text-[17px] font-extrabold`).
6. A **right rail**: status pill(s), a `mono-num` **metric**, and an
   uppercase "Edit →" affordance that turns vermilion on hover.
7. A **facet-chip row** (`MetaChip`) — the read-only "what this is" summary.
8. An italic **brief** (`line-clamp-2 text-muted italic`).

## Shared extraction: `MetaChip` → `ui.tsx`

`MetaChip` is currently a file-local helper in `ShowsPanel.tsx`:

```tsx
// hairline by default; accent when it flags a hard lock
function MetaChip({ children, accent }: { children: ReactNode; accent?: boolean }) { … }
```

All three panels will use it, so move it to `web/components/admin/ui.tsx` and
export it. Update `ShowsPanel.tsx` to import it instead of declaring it locally
(behaviour unchanged — same markup). This is the only cross-file refactor; it is
in service of the current goal (one chip across all three slates), not
speculative.

Everything else stays panel-local:
- Personas keep `initialsFor` (`personas/helpers.ts`) for the avatar.
- Skills get a small **kind → icon** map, local to `SkillsPanel.tsx`.
- The spine needs **no** `useDynamicStyle` here — unlike shows' arbitrary
  `SHOW_COLORS` hexes, both spines key off theme CSS vars, so they are plain
  conditional Tailwind `bg-` classes.

## Decision 1 — spine keys to status (both panels)

Shows key the spine to a per-show palette (`SHOW_COLORS`) that is *also* painted
in the weekly grid, so the colour is a shared identity. Personas and skills have
no such palette, so a hashed hue would be decorative-only. Instead the spine
encodes **status**, so the colour means something at a glance:

**Personas** (priority order):

| condition            | spine                             |
| -------------------- | --------------------------------- |
| on air               | `bg-[var(--accent)]` (vermilion)  |
| default (not on air) | `bg-ink`                          |
| incomplete           | `bg-[var(--danger)]`              |
| otherwise            | `bg-separator-strong` (hairline)  |

`on air` and `default` are mutually exclusive with the current pill logic
(`isOnAir` / `isDefault && !isOnAir`). `incomplete` (`!personaValid(p)`) takes
precedence over the plain hairline but ranks below on-air/default (an on-air
persona that's technically incomplete still reads as "on air").

**Skills:**

| condition | spine                            |
| --------- | -------------------------------- |
| enabled   | `bg-[var(--accent)]`             |
| disabled  | `bg-separator-strong` (hairline) |

## Decision 2 — skill cards: whole card opens the editor

Skills carry inline controls shows don't: the enable **Toggle** and the **Run
now** seg-pad. Per the approved decision, the whole card still opens the edit
sheet (`setModal({ mode: 'edit', skill: s })`), matching shows, and the inline
controls `e.stopPropagation()` in their handlers so they act in place without
also opening the editor.

Accepted trade-off: `<article role="button">` will contain `<button>` (Toggle,
Run now) and an `<a>` (the API-key link inside `SkillDescription`). This is
nested interactive content. Mitigations:
- Every inner control calls `e.stopPropagation()` in its `onClick` (the key link
  too), so a mouse click on a control never also opens the editor.
- The card's `onKeyDown` guards with `if (e.target !== e.currentTarget) return;`
  before handling `Enter`/`Space`. Without this, a keydown on the focused Toggle
  or Run now button would *bubble* to the article and open the editor on top of
  the control's own action. The guard makes the card respond to the keyboard only
  when the card itself is focused; the inner controls remain independent focus
  stops with their own `aria-label` / accessible text.

## Skills card layout

Follows the approved preview exactly:

```
┌─▌────────────────────────────────────────┐   spine: enabled=accent, else hairline
│▌ [kind]  Weather  ‹custom?›     [⏻ Toggle]│   header: icon+name+custom pill | toggle + state
│▌                                enabled    │
│▌ ‹needs-key alert, only when ready===false›│
│▌ Reads the local forecast before a track…  │   brief: SkillDescription, line-clamp-2, italic
│▌ 30 min cooldown · All DJs · #ambient       │   facet chips: cooldown, assignment, #tags, pinned
│▌ [ Run now ]                       Edit →   │   actions: seg-pad (stopProp) | Edit affordance
└────────────────────────────────────────────┘
```

Field mapping:

- **Face** — a `size-12` square tile (border + `bg-[var(--ink-softer)]`) holding
  a lucide icon from a local `KIND_ICONS` map; icon colour is `text-ink` when
  enabled, `text-muted` when disabled. Map:
  - `weather` → `CloudSun`, `news` → `Newspaper`, `traffic` → `TrafficCone`,
    `curiosity` → `Lightbulb`, `album-anniversary` → `Cake`,
    `library-deep-cut` → `Disc3`, `web-search` → `Globe`.
  - fallback (custom or any unknown kind) → `Sparkles`. The map only needs the
    seven built-ins; anything else — including all custom skills — falls back, so
    it is not a maintenance trap.
- **Kicker / name** — bold name (`s.label || s.name`); a small `custom` pill sits
  beside it when `s.custom`.
- **Right rail** — the `Toggle` (top, `stopPropagation`), a compact
  `enabled`/`disabled` caption beneath it, and the "Edit →" affordance.
- **needs-key alert** — the existing `V3Alert` (with its "Get a key here" link)
  stays, rendered between header and brief, only when `s.ready === false`. The
  redundant standalone state pill is dropped (spine + toggle + caption already
  carry enabled/disabled).
- **Brief** — `SkillDescription` (keeps the inline API-key link), styled as the
  muted italic brief, `line-clamp-2`. The key `<a>` gets `stopPropagation`.
- **Facet chips** (`MetaChip`) — cooldown (`cooldownLabel`), the assignment label
  (`All DJs` / `N of M DJs`, hidden when no roster), the `pinned feature` chip
  (accent, when filtered by a show whose `segmentSkill === s.name`), and `#tag`
  chips. Same data the old meta pills showed, restyled.
- **Actions** — the existing `Run now` seg-pad (`seg-pad seg-pad--slim`,
  `stopPropagation`) bottom-left; "Edit →" affordance bottom-right (redundant
  with whole-card click, but a clear signpost, matching shows).

The list-level plumbing (`visible.map`, filters, sort, community modal, edit
modal, hero, organise bar) is untouched — only the per-row markup changes.

## Personas card layout

```
┌─▌──────────────────────────────────────────┐   spine: on-air=accent / default=ink /
│▌ [avatar] ‹on air›                           │           incomplete=danger / else hairline
│▌          Kai Mercer          ‹incomplete›   │   kicker: on air / default | right: status
│▌                                    7        │   metric: skills count (mono-num)
│▌                                 skills      │
│▌                                  Edit →     │
│▌ moderate · long · kokoro · ember-voice      │   facet chips: freq, scriptLength, engine, voice
│▌ Late-night warmth for the small hours.       │   brief: tagline, italic, line-clamp-2
└──────────────────────────────────────────────┘
```

Field mapping:

- **Face** — the existing initials-behind-`<img>` avatar, bumped `size-11` →
  `size-12` to match the show/skill face. `?v=${avatarTick}` cache-bust kept.
- **Kicker** — `on air` (accent, `dot`) or `default` (plain), above the name.
  These move out of the old right-rail `right={…}` slot into the kicker row,
  mirroring shows' Programme/Banter placement.
- **Name** — bold `text-[17px]`.
- **Right rail** — `incomplete` pill (danger border) when `!personaValid(p)`; a
  `mono-num` **metric** of the skill count (`{n}` big + `skills` caption — `all`
  when `p.skills === null`, if that sentinel reaches this list); the "Edit →"
  affordance.
- **Facet chips** (`MetaChip`) — `frequency`, `scriptLength` (when not
  `concise`), `tts.engine`, and `tts.voice` (when engine ≠ `piper` and a voice is
  set). Same fields as the old meta pills.
- **Brief** — `tagline` (or "no tagline"), italic, `line-clamp-2`.

The whole card opens the editor via the existing `onSelect(i)`; the explicit
`Edit` button is removed. `PersonaRoster`'s props and the parent `PersonasPanel`
are otherwise unchanged.

## Non-goals

- No changes to controller routes, data shapes, or `/settings`.
- No change to the community modals, the skill edit sheet, the persona editor,
  filters/sort, or the heroes.
- No new colour palette; no `useDynamicStyle` in these two panels.
- Shows (`ShowsPanel.tsx`) change only by importing the extracted `MetaChip`.

## Testing / verification

No unit-test runner for `web/`. Verification is:

1. `npm run lint` in `web/` (`eslint . && tsc --noEmit`) — the merge gate.
2. Visual check of `/admin/skills` and `/admin/personas` against `/admin/shows`
   in the running dev stack (or via the `verify` skill's isolated controller +
   Playwright), confirming: spine colours track status; whole-card click opens
   the right editor; Toggle and Run now still act without opening the editor; the
   API-key link still navigates; facet chips render; layout holds at narrow
   widths.

## Files touched

- `web/components/admin/ui.tsx` — export `MetaChip` (moved in).
- `web/components/admin/ShowsPanel.tsx` — drop local `MetaChip`, import it.
- `web/components/admin/SkillsPanel.tsx` — slate row + `KIND_ICONS` map.
- `web/components/admin/personas/PersonaRoster.tsx` — slate row.
