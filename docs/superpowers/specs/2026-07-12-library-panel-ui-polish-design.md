# Library Panel UI Polish — Design

Date: 2026-07-12
Status: Draft, pending review
Scope: two visual/UX refinements to `/admin/library`, no backend changes.

## Problem

1. **Tab strip** (`Tabs` in `web/components/admin/LibraryPanel.tsx`, `.lib-tab*` in `globals.css`): six equal-width two-line cells whose badges mean four different things (Recent's "50" is just the page size, Browse's is the tagged total, Untagged's is a real to-do count, Playlists/Blocked are list sizes). The hint line ("navidrome", "tagged index") costs a second line in every cell, forces the tall strip and a wrapped "Recently added", and `flex-wrap` degrades to a ragged two-row grid on narrow widths. Nothing signals attention — 300 untagged tracks looks as calm as 1 playlist.
2. **Analysis rows** (`LibraryTaggingPanel.tsx` ~line 621): the acoustic-analysis block — three coverage meters (bpm/key, sounds-like, vocal), two Backfill/Pause control rows, and two explainer paragraphs — is permanently expanded, dominating the top panel even though most visits never touch it.

## Design

### 1. Refined masthead tab strip

Keep the boxed broadsheet identity (ink border, uppercase names, solid-ink active cell, accent badge on active). Change:

- **One-line tabs sized to content**: drop `flex: 1` / `min-width: 130px`; cells take natural width (`padding: 10px 16px`). The strip container becomes `overflow-x: auto` + `flex-wrap: nowrap` so narrow screens scroll instead of wrapping.
- **Hint line removed** (`lib-tab-hint` and the hint markup go away). The active panel's Card subtitle already explains each view.
- **Label change**: "Recently added" → "Recent" (the Card title below still reads "Recently added").
- **Badges only where the count is actionable**:
  - *Untagged*: warm to-do badge (accent-tinted, not just `currentColor`), shown only when count > 0.
  - *Blocked*: neutral badge, shown only when count > 0.
  - *Playlists*: neutral badge, always (when loaded).
  - *Recent, Browse, Search*: no badge, ever.
- `Tabs` keeps its current props shape (`counts`), it just renders fewer badges; the `counts.browse`/`counts.recent` fields drop out of the component.

### 2. Collapsed analysis section

In `LibraryTaggingPanel.tsx`, wrap the existing three-row analysis block (bpm/key row, sounds-like row + blurb, vocal row + blurb — the single `div` starting at the "acoustic & audio coverage" comment) in a disclosure:

- **Collapsed by default.** The collapsed state renders one summary line in the same caption style as the "View log" toggle:
  `▸ Acoustic analysis — bpm/key 12% · sounds-like 1% · vocal off`
  - Each fragment mirrors the row's current status text logic, compressed: a percentage when the pass has coverage numbers, `off` when disabled, `engine off` when no analysis backend.
  - Clicking toggles to the full block with a `▾` state; an inline "Hide" affordance is not needed — the same toggle line stays visible above the expanded block.
- **Auto-expand while analysis work is in flight**: when the tagger's last/current run is an analyze/backfill (`lastRun?.mode === 'analyze'` and running), the section forces open so the progress meters and Pause stay visible. Manual collapse wins once the run finishes.
- **Not persisted** — fresh page load starts collapsed, matching the log drawer's behaviour (`logOpen` component state).
- The "Embeddings missing" re-embed warning stays OUTSIDE the collapse — it is an alert, not status, and must never be hidden.
- State lives in `LibraryTaggingPanel` (`useState`), not lifted to `LibraryPanel` — nothing else reads it.

## Out of scope

- Grouping tabs by purpose or moving them into the sidebar (considered, rejected in favour of least-churn refinement).
- Persisting the analysis-section expansion in localStorage.
- Any change to what the analysis rows do when expanded (Backfill/Pause/Enable logic untouched).

## Testing

- `npm run lint` in `web/` (eslint + tsc) — the merge gate.
- Visual verification in the running worktree dev stack (hot-reload) via Claude in Chrome: tab strip at full and narrow widths, badge visibility rules (untagged > 0 warm, blocked 0 hidden), analysis section collapsed default / expand toggle / auto-expand during a backfill run.
