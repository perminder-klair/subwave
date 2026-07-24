# Admin roster list view — Design

## Problem

Three admin pages render their roster as a stack of full-width "broadcast
slate" cards, all built from the same recipe: a status-keyed colour spine, a
face (avatar or kind glyph), a kicker + bold name, a facet-chip row, a brief,
and a right rail carrying a metric and the `Edit →` affordance. The whole card
is the edit target.

- `/admin/skills` — `SkillsPanel.tsx`
- `/admin/shows` — `ShowDefRow` in `ShowsPanel.tsx`
- `/admin/personas` — `PersonaRoster.tsx`

Each card is ~140–180px tall. That reads beautifully at 4 items and badly at
20. The operator feedback that prompted this:

> Would be easier to sort through and configure them if they were more of a
> table view format. Appreciate the recent enhancements however might be more
> navigatable in a tabled format, or as an option, instead of just the current
> card styles especially as the numbers of them grow.

Skills feels it first — the seven built-ins plus community installs plus custom
skills is already a long scroll, and comparing *cooldown* or *who runs this*
across skills means holding six cards in your head. Shows and DJs are heading
the same way.

The cards are not the problem — they're the right default for a small roster
and they carry information density a table can't (the brief, the facet row).
The gap is that there is no second gear.

## Solution overview

Add a **Cards ⇄ List** view toggle to each of the three rosters, defaulting to
Cards (so nothing changes for anyone who doesn't touch it) and remembering the
choice per surface in `localStorage`.

List view renders the same roster as a dense table: one row per item, the same
click-row-to-edit contract as the card, the same colour spine, and the same
inline controls (the Skills enable toggle and Run now stay operable in place).
Rows are ~40px instead of ~160px, so a 20-skill roster fits one screen and
columns line up for comparison.

Three surfaces, one shared table primitive, no API or data-shape change.

## Components

### `lib/adminView.ts` — the persisted preference

```ts
export type RosterSurface = 'skills' | 'shows' | 'personas';
export type RosterView = 'cards' | 'list';

export function useRosterView(surface: RosterSurface): [RosterView, (v: RosterView) => void];
```

Key: `subwave-admin-view:<surface>` (dashed style, matching
`subwave-skin-override` / `subwave-theme-override`).

Per-surface, not global — an operator may well want Skills as a list and Shows
as cards, since Shows carries a weekly grid above it that already does the
scanning job.

SSR safety: `useState('cards')` plus a mount effect that reads storage. A
list-view operator sees one frame of cards on a cold load. That's acceptable
here and deliberately *not* worth the pre-paint inline-script treatment
`lib/skin.ts` uses — admin pages render a skeleton while the roster fetch is in
flight, so in practice the view resolves before there is anything to lay out.
Storage access is wrapped in `try/catch` (private-mode browsers throw).

### `components/admin/RosterTable.tsx` — the shared primitive

Generic, column-driven, no new dependency. Hand-rolled in the house table
style already used by `StatsPanel` and `DashPanel` (`caption` header
typography, `border-separator-soft` row rules, `mono-num` figures) rather than
pulling in shadcn's `table` — per the Tailwind v4 / shadcn-CLI mismatch the
project has already been bitten by.

```ts
export interface RosterColumn<R> {
  key: string;
  label: ReactNode;                 // '' for the spine and face columns
  align?: 'left' | 'right' | 'center';
  className?: string;               // per-cell classes; responsive hiding lives here
  headClassName?: string;
  sortMode?: string;                // present => header is a sort button
  sortAria?: 'ascending' | 'other'; // aria-sort when active (default 'other')
  render: (row: R) => ReactNode;
}

export interface RosterTableProps<R> {
  cols: RosterColumn<R>[];
  rows: R[];
  rowKey: (row: R) => string;
  rowLabel: (row: R) => string;     // aria-label for the row's button role
  rowSpine?: (row: R) => string;    // CSS colour for the left spine
  onRowClick: (row: R) => void;
  sort?: string;
  onSort?: (mode: string) => void;
  caption: string;                  // visually-hidden <caption>
}
```

Behaviour:

- **Row is the edit target.** `role="button"`, `tabIndex={0}`, `aria-label`,
  and an Enter/Space handler carrying the same
  `if (e.target !== e.currentTarget) return;` guard the Skills card uses — so a
  keyboard press on an inner control (the enable switch, Run now) acts in place
  instead of bubbling up and also opening the editor. Inner controls
  `stopPropagation` on click, exactly as they do in the cards today.
- **Spine.** `border-left: 4px` on the first `<td>`, coloured through
  `useDynamicStyle` (the `style` prop is lint-forbidden — issue #50). A border
  on a cell spans the full row height natively, which is why this beats trying
  to stretch an absolutely-positioned span inside a table. Each row is its own
  `RosterRow` component so it can own the ref and the hook call.
- **Sticky header.** `sticky top-0` with a `--card-bg` backdrop, so the header
  survives a long roster scrolling under it.
- **Sortable headers.** A column declaring `sortMode` renders its label as a
  button that calls `onSort(mode)`; the active header gets `aria-sort` and a
  vermilion tint. Sort *modes* here are named presets (`az`, `enabled`,
  `cooldown`), not asc/desc toggles — hence `aria-sort="other"` as the default
  for anything that isn't a genuine alphabetical sort.
- **Responsive.** Low-priority columns carry `hidden md:table-cell` /
  `hidden lg:table-cell` / `hidden xl:table-cell`. The wrapper is
  `overflow-x-auto` as the floor, so nothing is ever unreachable, but at the
  documented breakpoints no horizontal scroll should be needed.

### Per-surface tables

Three thin files, each just a column definition over `RosterTable`. Keeping
them separate from the panels matters most for Shows — `ShowsPanel.tsx` is
already 2,400 lines.

**`components/admin/skills/SkillsTable.tsx`**

| col | content | breakpoint | sort |
|---|---|---|---|
| spine | enabled → `var(--accent)`, else `var(--separator-strong)` | always | — |
| glyph | the `KIND_ICONS` face, muted when disabled | always | — |
| Skill | label, `custom` pill, a `needs key` flag when `ready === false` | always | `az` |
| Brief | `s.description`, one line, truncated | `lg` | — |
| Cooldown | `cooldownLabel(s.cooldownMs)` | `md` | `cooldown` |
| DJs | the existing `assignmentLabel(s)` — "All DJs" / "3 of 8 DJs" | `md` | — |
| Tags | first two `#tag` chips, then `+n` | `xl` | — |
| Run | the slim `seg-pad` Run now control | always | — |
| Enabled | the `Toggle` | always | `enabled` |

The three sort modes map 1:1 onto the `SortMode` union the panel's existing
Sort select already drives, so clicking a header just sets that same state and
both views stay in agreement. The `needs key` case degrades from the card's
full `V3Alert` to a compact flag — the alert body is guidance the operator
reads once, and it's still there in cards and in the edit sheet.

**`components/admin/ShowsTable.tsx`**

| col | content | breakpoint |
|---|---|---|
| spine | `SHOW_COLORS[i % n]` — the same colour the weekly grid paints | always |
| faces | host avatar, guests overlapping | always |
| Show | name, `Programme` / `Banter` pills | always |
| Host | host name, `no persona set` in danger when absent | `md` |
| Plays | first three facet chips, then `+n` | `lg` |
| h/wk | weekly airtime, or `unscheduled` | always |
| status | `incomplete` pill | always |

**`components/admin/personas/PersonaTable.tsx`**

| col | content | breakpoint |
|---|---|---|
| spine | on air → accent, default → ink, invalid → danger, else hairline | always |
| avatar | avatar image over initials fallback | always |
| DJ | name, `on air` / `default` pills | always |
| Tagline | `p.tagline`, one line, truncated | `lg` |
| Frequency | `p.frequency` | `md` |
| Voice | `p.tts.engine`, plus the voice name for non-Piper engines | `md` |
| Skills | count | always |
| status | `incomplete` pill | always |

Shows and DJs get **no sortable headers in this change**. Both panels key off
the roster's array index — `SHOW_COLORS[i]` and the weekly grid for shows,
`onSelect(i)` for personas — so reordering rows means threading an original
index through first. That's real work with real breakage risk, and it isn't
what the request is about. Sorting on those two is called out as a follow-up.

### Toggle placement

- **Skills** — right end of the ORGANISE bar, after the Sort select, before
  Clear. It belongs with the other view controls.
- **Shows** — the `show definitions · N/M shows` header row, left of Community.
- **DJs** — the `roster · N/M` header row, left of Community.

## What does not change

- Cards stay the default view on every surface.
- No controller route, settings key, or response shape moves.
- The edit sheets (`SkillEditModal`), the inline `ShowEditor`, and the persona
  editor are untouched — both views open the same editor with the same
  argument.
- The Skills search / DJ-and-show filter / status filter / sort bar applies to
  both views: it filters the array, and the view only decides how that array
  draws.
- Card markup is left alone. This is additive.

## Error handling

There is nothing new to fail — no fetch, no mutation, no server state. The two
failure modes are both local and both degrade to the current behaviour:

- `localStorage` unavailable or holding junk → `try/catch`, fall back to
  `'cards'`. An unrecognised stored value is treated as absent (own-key check,
  the same defensive read `lib/skin.ts` does for skin ids).
- An empty roster → the panels' existing `EmptyState` renders instead of the
  table, unchanged; the view toggle stays visible so the operator isn't stuck
  in a view they can't see out of.

Row actions (toggle, Run now) reuse the panel's existing handlers verbatim,
including their `notify.err` paths and their `busy` guard.

## Testing

The repo has no test runner; `npm run lint` (`eslint . && tsc --noEmit`) is the
merge gate. Verification for this change:

1. `npm run lint` in `web/`.
2. Playwright against a worktree dev stack, per the established admin-UI
   verification pattern (pre-seed `subwave_admin_auth` in `localStorage`; the
   sign-in form's delayed push otherwise wrecks dev-mode runs):
   - each of `/admin/skills`, `/admin/shows`, `/admin/personas` renders in both
     views;
   - the view choice survives a reload, and is independent per surface;
   - a row click opens the same editor the card opens;
   - keyboard: Tab to a row, Enter opens the editor; Tab to the enable switch,
     Space toggles it and does *not* open the editor;
   - Skills header sort clicks agree with the Sort select;
   - light and dark both read correctly.
3. Screenshots of all three list views attached to the PR.

## Out of scope — follow-ups

- **Search / filter for Shows and DJs.** Only Skills has them today. The list
  view makes their absence more obvious, not less, but adding two filter bars
  is its own change with its own design questions (what do you filter shows
  by — day, host, mood?).
- **Sortable headers on Shows and DJs**, which needs the index decoupling
  described above.
- **Bulk actions** (multi-select enable/disable across skills). A table is the
  natural home for them, and this change deliberately doesn't open that door
  yet.
- **Server-side / per-operator persistence** of the view choice. Browser-local
  is right for a preference this cheap.
- **A list view for the other admin rosters** (playlists, moods, webhooks).
  Worth doing once this pattern has settled in use.
