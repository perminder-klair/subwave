# Optional tune-in overlay + relocate Booth Buddy toggle

**Date:** 2026-07-14
**Status:** approved-pending-review

## Goal

Two operator-facing changes, both landing in the admin **Skin & Themes** tab
(`settings` section id `theme`):

1. Make the full-bleed **"Tap to tune in"** overlay optional across every player
   skin, controlled by a new station-wide setting.
2. Move the existing **Booth Buddy** toggle out of the **Station** tab into the
   **Skin & Themes** tab, next to the new overlay toggle.

## Load-bearing constraint

The tune-in overlay's tap is the **browser's audio-unblock gesture** — browsers
refuse to start `<audio>` until a user gesture. So "overlay off" **cannot** mean
autoplay. It means: skip the full-bleed takeover; the listener starts playback
with the skin's normal transport play button. The `subamp` skin already works
exactly this way (its gate is inline, no overlay — `SubampSkin.tsx:6`), which is
the proof this behavior is fine.

Decisions (confirmed with operator):
- **Scope:** operator-only, station-wide (mirrors Booth Buddy). No per-listener
  override.
- **Off behavior:** rely on each skin's existing paused play button. No new
  inline hint UI.

## Design

### The gate split (`web/components/player/useTuneInGate.ts`)

Today `showTuneIn` conflates two ideas: "the gate is up (not tuned in yet)" and
"render the overlay." Skins use `showTuneIn` for *both* — the overlay render
**and** other gate-up behavior (time display shows `--:--`, keyboard shortcuts
disabled, drift hides tuned-in-only elements, etc.).

We split only the overlay out, leaving gate-up semantics untouched:

- The hook consumes `usePlayerFeed()` and reads
  `overlayEnabled = state.ui?.tuneInOverlay !== false` (defaults **on** — any
  value other than an explicit `false`, including `undefined` before `/state`
  resolves, keeps today's behavior).
- The hook returns a new field `showOverlay = showTuneIn && overlayEnabled`.
- `showTuneIn`, `tuneInFromOverlay`, `handleTune` keep their current meaning and
  return shape (additive change — no existing field changes semantics).

`TuneInGate` interface gains:
```ts
/** Render the full-bleed overlay: gate is up AND the operator hasn't
 *  disabled the overlay (settings.ui.tuneInOverlay). */
showOverlay: boolean;
```

### Skins — swap the overlay render gate only

Each skin that renders a full-bleed overlay changes **only** the overlay's
render condition from `showTuneIn` to `showOverlay`. Every other `showTuneIn`
usage (time display, keyboard focus, tuned-in-only content) stays as-is, so a
listener who hasn't tapped play yet still sees the correct paused state.

| Skin | File | Change |
|---|---|---|
| classic | `ClassicSkin.tsx:263` | `{showTuneIn && ...` → `{showOverlay && ...}` (the `<TuneInOverlay>`) |
| spool | `SpoolSkin.tsx:393` | same |
| tty | `TtySkin.tsx:359` | same |
| drift | `DriftSkin.tsx:294` | same (leave the `!showTuneIn` gates at 177/224 untouched) |
| subamp | — | **no change** — already overlay-less; its inline play button is the gate |

The transport/play buttons already tune in via `handleTune` /
`tuneInFromOverlay`, so with the overlay hidden the first tap on the play button
still unblocks audio and drops the gate. No skin needs a new control.

### Controller settings (`controller/src/settings.ts`)

Add `tuneInOverlay` to the `ui` block, following `boothBuddy` exactly:
- **Default** (`DEFAULTS.ui`, ~line 1097): `tuneInOverlay: true`.
- **Load/migrate** (~line 1905): `typeof stored.ui?.tuneInOverlay === 'boolean' ? … : DEFAULTS.ui.tuneInOverlay`.
- **Patch** (`update()`, ~line 3542): `if (ui.tuneInOverlay !== undefined) next.ui.tuneInOverlay = !!ui.tuneInOverlay;`.
- Update the `ui:` comment block to mention the new flag.

### `/state` exposure (`controller/src/routes/public.ts:408`)

```ts
ui: {
  boothBuddy: s?.ui?.boothBuddy ?? false,
  skin: s?.ui?.skin || 'classic',
  tuneInOverlay: s?.ui?.tuneInOverlay ?? true,
},
```

### Web types (`web/lib/types.ts:185`)

```ts
ui?: { boothBuddy?: boolean; skin?: string; tuneInOverlay?: boolean };
```

### Admin UI (`web/components/admin/settings/`)

**ThemeSection.tsx** (the "Skin & Themes" tab) gains two cards after the "Player
skin" card, both saving immediately on toggle via the existing `saveSettings`
(no `form`/`SaveBar` needed — these are instant-apply toggles like the skin
gallery):

- **"Tune-in overlay"** card — `Seg` on/off bound to
  `data.values?.ui?.tuneInOverlay !== false`, saving
  `saveSettings({ ui: { tuneInOverlay: id === 'on' } })`. Hint explains that OFF
  drops the full-bleed gate and listeners tap the skin's play button to start
  (no autoplay possible; applies live, no restart).
- **"Booth Buddy"** card — moved verbatim from `StationSection.tsx:244-264`
  (same `Seg`, same `saveSettings({ ui: { boothBuddy } })`, same hint).

`ThemeSection` already imports `Seg` from `../ui` and receives `data`, `busy`,
`saveSettings` — no new props/imports needed.

**StationSection.tsx** — delete the Booth Buddy card (`:244-264`). Verify `Seg`
is still used elsewhere in the file; if not, drop it from the import to keep lint
green.

## Non-goals / YAGNI

- No per-listener overlay override (localStorage). Operator-only.
- No new "tap to listen" hint UI when the overlay is off.
- No change to subamp (already overlay-less).
- No change to the audio/tune mechanics — only whether the overlay paints.

## Testing / verification

No test runner in this repo; the gate is `npm run lint` (eslint + `tsc`) in
`controller/` and `web/`. Manual dev-stack check:
1. Admin → Skin & Themes: both toggles present; Station tab no longer shows
   Booth Buddy.
2. Overlay ON (default): fresh `/listen` load shows the full-bleed gate on
   classic/spool/tty/drift.
3. Overlay OFF: fresh load shows the paused player with no takeover; tapping the
   skin's play button starts the stream (audio unblocks). Booth Buddy toggle
   still works from its new home.
4. Both flags flip live on the next `/state` poll — no mixer restart.

## Files touched

- `controller/src/settings.ts` (3 spots + comment)
- `controller/src/routes/public.ts` (1 line)
- `web/lib/types.ts` (1 line)
- `web/components/player/useTuneInGate.ts` (feed read + `showOverlay`)
- `web/components/skins/{classic/ClassicSkin,spool/SpoolSkin,tty/TtySkin,drift/DriftSkin}.tsx` (1 line each)
- `web/components/admin/settings/ThemeSection.tsx` (+2 cards)
- `web/components/admin/settings/StationSection.tsx` (−1 card)
