# Shows grid: long-press-to-paint on touch — design

**Date:** 2026-07-02
**Scope:** `web/components/admin/ShowsPanel.tsx` only (grid interaction layer). No API, state-shape, or desktop-behaviour changes.

## Problem

The weekly schedule paint grid at `/admin/shows` is unreliable on touch screens:

1. **Paint fires on finger-down.** `GridCell` wires `onTouchStart={() => beginStroke(...)}`, so the cell under the finger toggles the instant a touch lands — before the browser knows whether the gesture is a scroll or a paint. Every horizontal scroll that starts on a cell flips that cell (the reported "accidental unchecks/checks while scrolling").
2. **`preventDefault()` in `onGridTouchMove` is a no-op.** React 17+ attaches `touchmove` at the root as a *passive* listener, so the call is ignored. While drag-painting, the `overflow-x-auto` container still pans (`touch-pan-x`), cells slide under the stationary finger, and `elementFromPoint` paints stray cells.
3. **No `touchcancel` handling.** The window listeners end a stroke on `mouseup`/`touchend` only; an OS-interrupted gesture (notification shade, browser takes over the scroll) can leave `strokeRef.active = true`.

Desktop (mouse) behaviour is considered correct and must not change.

## Decision

Fix in place — no redesign. Adopt **long-press-to-paint** as the touch gesture:

- **Swipe** (finger moves before the hold delay) → scrolls, paints nothing.
- **Hold ~300 ms on a cell** (movement under a small slop) → arms a paint stroke: haptic tick, scroll suppressed for the rest of the gesture, origin cell painted, drag extends the stroke.
- **Quick tap** (release before the hold delay, under slop) → toggles that single cell, committed **on release** — so a scroll that merely starts on a cell never toggles anything.
- **Mouse path unchanged** (`mousedown` paints immediately, `mouseenter` extends, as today).

## Mechanics

### Pending-press state

A new `pressRef` alongside the existing `strokeRef`:

```
pressRef: { day, hour, x, y, timer } | null
```

- `touchstart` on a cell (single touch only; ignore if `e.touches.length > 1`): record origin cell + coords, start a `HOLD_MS = 300` timer. **Do not paint.**
- `touchmove` while pending: if the touch drifts beyond `SLOP_PX = 8` from origin, cancel the timer and clear `pressRef` — it's a scroll. The browser pans as normal.
- Timer fires (finger still down, within slop): arm the stroke — `strokeRef = { active: true, value: strokeValueFor(origin) }`, paint the origin cell, `navigator.vibrate?.(10)` where supported, set a `painting` state flag.
- `touchend` while still pending (i.e. quick tap, under slop): commit a single-cell toggle (`beginStroke`-equivalent for that one cell, immediately ended). Clear `pressRef`.
- `touchcancel` (new): clear `pressRef`, end any active stroke.

### Scroll suppression while painting

`touch-action` can't change the behaviour of an already-started gesture, so the fix is a **non-passive** `touchmove` listener attached imperatively to the scroll-container element via `ref` + `addEventListener('touchmove', handler, { passive: false })` in a `useEffect`. The handler:

- while a press is *pending*: applies the slop check above (no `preventDefault` — scrolling must stay native);
- while a stroke is *active*: calls `e.preventDefault()` (now effective) and extends the stroke via the existing `elementFromPoint` → `[data-cell]` lookup.

The current React `onTouchMove={onGridTouchMove}` prop is removed (it's the broken passive path).

### Long-press side effects to suppress

- `contextmenu` on the grid container: `preventDefault` while a press/stroke is live (Android long-press menu).
- Add `[-webkit-touch-callout:none]` on cells alongside the existing `select-none` (iOS callout).

### What doesn't change

- Desktop mouse handlers, brush model, `strokeValueFor` toggle semantics, day/hour fill buttons (plain `onClick` — already touch-safe), save flow, grid markup and styling (aside from the callout utility), `touch-pan-x` (still correct for the not-painting case).

## Error handling / edge cases

- Multi-touch (pinch) during a pending press → cancel the press.
- Timer must be cleared on unmount and on `touchend`/`touchcancel` (no stray paints after release).
- `navigator.vibrate` is feature-detected; absence (iOS Safari) is fine — the visual paint of the origin cell is the arming cue there.
- Stroke lifecycle stays on the existing window `touchend` listener; `touchcancel` is added beside it.

## Testing

- `npm run lint` in `web/` (the merge gate; no test runner in this repo).
- Manual verification via Chrome DevTools touch emulation against the dev server: (a) horizontal + vertical swipes starting on painted and empty cells change nothing; (b) hold-then-drag paints a run of cells without the container panning; (c) quick tap toggles exactly one cell; (d) mouse click + drag behave exactly as before.
