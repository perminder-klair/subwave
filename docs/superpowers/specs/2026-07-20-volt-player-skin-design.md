# Volt player skin — VOLT/LAB aesthetic

**Date:** 2026-07-20
**Status:** Design — awaiting review
**Scope:** One new, self-contained player skin. No changes to landing, admin,
onboarding, the native app, or the operator theme registry.

## What we're building

A new player face, **`volt`**, added to the skin registry alongside classic /
spool / drift / subamp / tty / platter. It renders the SUB/WAVE player in the
**VOLT/LAB** aesthetic — "digital display meets newsprint": flat off-white
paper, hairline black rules, one electric-orange accent, dot-matrix (Doto)
headlines, film grain.

It is a listener/operator-selectable skin (skin picker + `s`-cycle + operator
`settings.ui.skin` default), so it is **fully reversible**: shipping it changes
nothing about any existing face. This is the "see how it goes" delivery.

The reference PNGs the operator supplied (`img2-op-b`, `img3-skip`,
`img4-lies1`, `img5-lies2`) are the visual target for the hero now-playing card:
cover art top-left, a large uppercase headline, a mono meta row
(`123 BPM · 3A ↳ ENERGETIC · REFLECTIVE · HIGH ENERGY`) with accent mood tags,
and a DJ-reasoning line prefixed by a small robot glyph and closed by a blinking
block cursor. In those PNGs the headline is a serif; **per the operator's
decision the Volt headline is Doto (dot-matrix), faithful to the written
guide** — the PNGs otherwise define the layout and content.

### Non-goals (explicitly out of scope)

- Landing / marketing pages, `/setup`, `/onboarding`, `/admin`.
- The native Expo app.
- New entries in the operator **theme** registry (Volt is a *skin*, not a
  theme).
- The two heavy VOLT/LAB signature accents — **glass node-network** and
  **liquid chrome panel**. They are marketing-page devices; in a compact,
  always-on player they cost perf, complicate lite-mode, and fight the calm
  newsprint vibe. Not built.
- Any edit to `web/app/globals.css`. Skin styles are co-located per the skin
  contract (`components/skins/types.ts`).

## How a skin plugs in (existing contract, unchanged)

- `PlayerShell` (`components/player/PlayerShell.tsx`) owns the `<audio>`
  element, the feed/audio/actions contexts, skin resolution, the `s`/`t` cycle
  shortcuts, and the toaster. It renders the resolved skin inside a root
  `<div className="... bg-bg text-ink">`.
- A skin is one component (`SkinComponent`) reading the core contexts
  (`usePlayerFeed` / `usePlayerAudio` / `usePlayerActions`), `useTuneInGate`,
  `useStationClient`, and the shared derivations in `skins/shared.ts` /
  `skins/sharedHooks.ts`. `VoltSkin` mirrors `ClassicSkin`'s structure.
- The operator theme system sets `data-theme="light|dark"` on `<html>` plus the
  token vars (`--bg --ink --muted --accent --overlay --soft-border --field`).
  Volt reads **`--accent`** (for the swap) and **`data-theme`** (for
  light/dark); it deliberately supplies its own paper palette rather than the
  operator's `--bg`/`--ink`, because VOLT/LAB paper is the whole point.

The shared derivations already emit exactly what the card needs, so no new data
plumbing is required:

- `trackMeta(nowPlaying)` → `{ facts: [GENRE, "123 BPM", "3A"], moods:
  ["ENERGETIC", "REFLECTIVE", "high energy"] }`.
- `lastVoiceLine(session.messages)` / `boothLines(...)` → the DJ line + booth
  feed.
- `stationIdentity(dj, activeShow, context)` → masthead facts.
- `contextLine(context)` → "drive home · 16° cloudy".
- `progressRatio(elapsed, duration)` → hairline progress fill.
- `listenerCountOf(listeners)` → signal readout.

## File layout

New directory `web/components/skins/volt/`:

| File | Purpose |
| --- | --- |
| `VoltSkin.tsx` | Orchestrator. Mirrors `ClassicSkin`: reads contexts, holds drawer/request state, wires keyboard shortcuts + tune-in gate, composes the pieces below. Applies the Doto font `.variable` and the `styles.volt` scope class to a root `<div className="absolute inset-0">` that paints the paper background over the shell. |
| `Volt.module.css` | Co-located CSS Module: VOLT/LAB palette vars, grid hairlines, film grain (`::after`), ticker marquee, blink keyframes, all component styling. **The only stylesheet this skin adds — globals.css untouched.** |
| `fonts.ts` | `next/font/google` Doto (variable, wght 900, ROND 0) → `--font-volt-display`. JetBrains Mono is already global (`--font-mono`); reused, not reloaded. |
| `Masthead.tsx` | Top strip: ticker marquee, station name, context strapline, `NOW PLAYING — m:ss · ⊙ plays` eyebrow, on-air status square, index code, schedule affordance. |
| `NowPlayingCard.tsx` | The hero card (the PNGs). Cover (1px ink border, accent edge), corner caption tag, Doto title, mono `artist · album · year`, meta facts row, accent mood tags, DJ line (robot glyph + mono text + blinking `▮`). |
| `Bento.tsx` | Hairline-gap modular grid of cells: `UP NEXT` arrow-tile, stat blocks (Doto 52px numbers: plays / listeners / tokens), booth preview, context cell. |
| `Transport.tsx` | Pill transport: primary accent pill (TUNE IN / play-pause), ghost mute pill, volume field, signal readout (latency / quality / listeners). |
| `Progress.tsx` | 1px hairline progress bar, accent fill, driven by the audio element + `progressRatio`. |
| `TuneInGate.tsx` | Full-bleed paper tap-to-tune overlay via `useTuneInGate` (the tap is the audio-unblock gesture — mandatory). Doto "TUNE IN", accent pill, grain, blinking cursor. |
| `drawers/` | `Timeline`, `Booth`, `Request`, `Schedule` panel bodies, rendered inside the shell's shared `Sheet` (same as classic), styled VOLT/LAB (hairline rows, mono, corner tags, a **sharp** 1px search/request field, arrow-tile schedule rows). |

Registry: one entry appended to `SKINS` in `components/skins/index.ts`:

```ts
{
  id: 'volt',
  name: 'Volt',
  description: 'Digital display meets newsprint — dot-matrix headlines on flat paper, one electric accent.',
  skinApiVersion: SKIN_API_VERSION,
  load: () => import('./volt/VoltSkin'),
}
```

No other registry/plumbing change: `SKIN_COMPONENTS`, `s`-cycle, operator
default, showcase embeds, and pre-paint hide all pick it up automatically.

## Palette & tokens (scoped, in `Volt.module.css`)

```css
.volt {
  --acc:    var(--accent, #ff5a00);  /* orange default; operator accent swaps in */
  --pg-bg:  #f1f1f1;
  --pg-ink: #111111;
  --line:   #111111;
}
:global([data-theme='dark']) .volt {
  --pg-bg:  #141414;
  --pg-ink: #f1f1f1;
  --line:   #4a4a4a;
}
.volt ::selection { background: var(--acc); color: #fff; }
```

- **Accent behaviour** (per approval): orange `#ff5a00` is the signature default;
  because `--acc` falls back through `var(--accent, …)`, an operator running a
  themed accent gets *that* colour swapped in — the guide's "alt accents swap,
  never combine". Only one accent is ever on screen.
- **No grey surfaces.** Muted tones are derived only:
  `color-mix(in oklab, var(--pg-ink), transparent 30–55%)`.
- Paper bg + ink are **fixed** (not the operator's `--bg`/`--ink`) so the
  aesthetic holds under every theme; only the light/dark toggle and the accent
  follow the operator.

## Typography

- **Display — Doto** (`--font-volt-display`), weight 900, uppercase,
  `line-height: 0.94–1`, `letter-spacing: 0.01em`.
  - Track title (hero of the card): `clamp(40px, 6vw, 72px)`, wraps to max 2
    lines, then ellipsis — Doto 900 uppercase can get very wide, so the title
    is clamped smaller than the guide's 104px page-hero and never truncates the
    artist row below it.
  - Section headers: `clamp(28px, 4vw, 44px)`. Stat numbers: 52px. Card
    titles: 28–30px.
- **Mono — JetBrains Mono** (`--font-mono`, already global) for everything else:
  body 12–13px `line-height: 1.7` at ink-75%; labels/eyebrows 9–11px uppercase
  `letter-spacing: 0.16–0.24em`.
- Accent word inside a headline gets `color: var(--acc)`; the DJ line ends in a
  blinking block cursor `▮` (`steps(1)` blink).

## Surface-by-surface design

**1 · Masthead.** Full-width ticker (accent bg, white uppercase mono, ~22s
linear marquee, content duplicated + `translateX(-50%)`) carrying the station
strapline / show name. Below/around it: station name, `contextLine`, and the
`NOW PLAYING — m:ss · ⊙ 76,856` eyebrow (mono, muted, accent play-count glyph).
An 8px **square** status dot (blinking `steps(1)`) marks on-air. Index code
`VL-●●●` pinned top-right at 9px, ink-45%. A schedule affordance opens the
Schedule drawer.

**2 · Now-playing card** (the PNG target). A 1px-ink bordered card, radius 0,
top-padding 44px to clear a corner caption tag (`background: var(--pg-ink);
color: var(--pg-bg)`, 9px uppercase, flush top-left). Cover art left (1px ink
border + a thin accent edge, matching `img2`), metadata right:
- Doto uppercase title.
- Mono `artist · album · year` at ink-75%.
- Meta facts row from `trackMeta().facts`: `123 BPM · 3A` etc., separated by
  `·`, mono uppercase.
- Mood tags from `trackMeta().moods` in accent, small uppercase bold, led by a
  `↳` marker (as in the PNGs).
- DJ line: robot glyph (small inline SVG/mark, as in the PNGs) + the
  `lastVoiceLine` text in mono at ink-85%, closed by a blinking `▮`. Empty
  states (fresh install, no now-playing, no voice line yet) render nothing
  rather than placeholder noise — matching `shared.ts` conventions.

**3 · Progress.** A 1px hairline bar under the card, accent fill scaled by
`progressRatio(elapsed, duration)`; when duration is unknown (annotate metadata
carries none) the bar is a thin idle rule, no fake fill. Elapsed/`m:ss` mirrors
the masthead eyebrow.

**4 · Bento grid.** A modular grid wrapped in a `background: var(--line)`
container with `gap: 1px`; each cell `background: var(--pg-bg)` (crisper than
per-cell borders). Cells:
- `UP NEXT` — arrow-link tile (label left, `→` right; hover inverts to ink)
  from `state.upcoming[0]`, opens Timeline.
- Stat blocks — eyebrow label (9px, ink-60%) over Doto 52px number: **plays**,
  **listeners** (`listenerCountOf`), **tokens** (`llmTokens`). One stat uses
  accent.
- Booth preview — last few `boothLines`, opens the Booth drawer.
- Context cell — `contextLine` weather/time.
Cells span 1–3 columns for rhythm; min-height ~150–190px.

**5 · Transport.** Pill buttons only get radius (999px); everything else is
sharp. Primary = solid accent pill (`TUNE IN`, then play/pause), white uppercase
mono 11–12px `letter-spacing: 0.16em`, hover `filter: brightness(1.08)`. Ghost
mute pill (1px ink border, hover inverts). Volume as a sharp segmented field or
1px-box slider (not a pill). Signal readout (latency ms / quality / listeners)
in mono. Offline state disables tune and shows a mono notice.

**6 · Drawers** (reuse the shell `Sheet`, container = `portalNode` when
contained). Bodies restyled VOLT/LAB:
- Timeline — upcoming/history as hairline rows, mono, clock via `turnClock`.
- Booth — full `boothLines` feed, mono, kind-tinted.
- Request — a **sharp** 1px-ink search field (`⌕` prefix, uppercase 10px
  placeholder, transparent input — the guide's search component, deliberately
  not a pill), name field, accent pill submit, poll for the match outcome via
  `pollRequest` (same flow as classic).
- Schedule — arrow-tile rows for shows.

**7 · Tune-in gate.** Full-bleed paper overlay through `useTuneInGate`; Doto
`TUNE IN`, accent pill, film grain, blinking cursor. The tap is the browser's
audio-unblock gesture, so this is mandatory, not decoration.

## Signature accents

Included (co-located, cheap): **film grain** (`.volt::after` fixed overlay, SVG
`feTurbulence` fractalNoise baseFrequency .85 data-URI, `opacity: .4`,
`mix-blend-mode: multiply`, `pointer-events: none`), **ticker marquee**, **blink
cursor + square status dot**, **grid hairlines** (line-bg + 1px gap), **pill
buttons / ghost inverts / arrow-tiles / filter-tab chips / sharp search field**
from the component spec.

Excluded (see non-goals): glass node-network, liquid chrome panel.

## Motion, lite mode, reduced motion

- Blink `steps(1)` 1–1.4s; marquee linear ~22s; hovers are instant inversions;
  no easing flourishes elsewhere.
- **`html.lite`** (listener low-power toggle) and **`prefers-reduced-motion`**:
  the global CSS kill stops co-located keyframes, but per the contract anything
  that only becomes *visible* through animation needs an explicit fallback:
  - Ticker: freezes static, text still fully readable.
  - Cursor / status dot: render **solid** (visible, not mid-blink-hidden).
  - Grain: dropped under lite (it's an animated-feel texture and a paint cost).
  No JS rAF/canvas loops are introduced, so there's nothing to idle beyond CSS.

## Accessibility

- Doto is a decorative dot-matrix face. The track title carries an accessible
  name (visible text is the real title; no icon-only headline). Ink-on-paper
  body/labels clear WCAG AA comfortably.
- **Accent contrast caveat:** electric orange on paper is ~3.3:1 — fine for
  large/bold text (mood tags are ≥11px bold uppercase, and the accent-coloured
  stat number is 52px), below AA for small body. Volt therefore never puts
  small body copy in accent; accent is reserved for large numbers, bold tags,
  markers, fills, and pill backgrounds (white text on accent). If an operator's
  swapped `--accent` is lower-contrast, the same rule protects legibility since
  accent is never load-bearing for small text.
- Respect `prefers-reduced-motion` as above. Focus states: pill/ghost buttons
  keep a visible focus ring (1px ink or accent outline).

## Testing / verification

- **Merge gate:** `cd web && npm run lint` (`eslint . && tsc --noEmit`) must
  pass — same as every PR.
- **Manual (via the `verify` skill or a worktree dev stack):**
  - Skin appears in the picker; `s`-cycle reaches it; operator
    `settings.ui.skin = 'volt'` boots into it with no flash.
  - Light **and** dark (`data-theme`) both render correctly.
  - Lite mode (`?lite=1`) — grain gone, ticker/cursor static + legible.
  - Contained showcase (landing embed) — layout holds inside the frame,
    drawers portal into `portalNode`.
  - Long track title wraps to 2 lines then ellipsis; empty state (fresh
    install, no now-playing / no voice line) renders clean, no placeholders.
  - All four drawers open, request round-trips (submit → poll → outcome).
  - Accent swap: set a themed operator accent, confirm it replaces orange and
    nothing else changes.

## Risks / watch-items

- **Doto width.** Weight-900 uppercase is wide; the clamped title + 2-line cap
  is the mitigation. Verify with the longest real titles.
- **Accent contrast** as above — enforced by the "no small accent body" rule.
- **Bundle.** Doto adds one variable font chunk, loaded only when the Volt skin
  is active (dynamic import); no cost to other skins.
