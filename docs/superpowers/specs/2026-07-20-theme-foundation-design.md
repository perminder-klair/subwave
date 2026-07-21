# Theme foundation — expand the token system for contrast, depth, colour & type

**Date:** 2026-07-20
**Status:** Design — awaiting review
**Branch:** `feat/theme-foundation`

## Problem

SUB/WAVE themes look flat and low-contrast. A theme can only recolour a
restrained newsprint shell because the token system is too small to express
depth, hierarchy, a second colour, or type. Concretely, the system today has
**7 tokens** — `--bg --ink --muted --accent --overlay --soft-border --field` —
and:

- **one** muted rung → weak text hierarchy (primary vs everything-else);
- **no elevated surface** — `globals.css` maps `--card: var(--bg)`, so cards and
  panels sit at page level and never lift off;
- **one** accent and only soft, low-alpha borders → nothing reads as crisp;
- **no control over type or texture** — fonts are hardcoded global
  (`Fraunces` / `Plus Jakarta Sans` / `JetBrains Mono`), not themeable.

The recently-added **Volt player skin** (commit `82d7ce9`) demonstrates the
missing vocabulary — a graded ink ladder (`--ink-70/55/40`), hairline `--line`
rules, a display face (Doto dot-matrix), film grain, one electric accent — but
it gets there by **hardcoding** everything the tokens can't carry. That energy
should live in the theme system so every skin, the admin console, and the
landing page can use it, and so the theme builder gains real options.

Secondary problem: the token list is **duplicated in three places**
(`controller/src/themes.ts`, `web/lib/theme.ts` bootstrap, `ThemeSection.tsx`
builder form) plus a `SWATCH_KEYS` copy in three components. Any token change
today means editing 4–6 files by hand with no guardrail.

## Goals

1. Expand the themeable token set so themes can express **depth** (elevated
   surfaces), **hierarchy** (an ink ladder), **crisp structure** (hairlines), a
   **second accent**, a **display font**, and **grain** — without breaking any
   existing theme.
2. Make the new capability **derive-on-omit**: a theme that sets only
   `bg/ink/accent` still gets a full, coherent, higher-contrast system for free;
   a power theme overrides any role it wants.
3. Establish a **single source of truth** for the token registry that the
   controller validator, the no-flash bootstrap, and the builder all read.
4. Ship a **visible payoff** in this spec: remap shadcn `--card`/`--popover` to
   the new surface (instant app-wide depth), mount a theme-driven grain layer
   (off by default), and add one demonstration theme that actually sets the new
   tokens.

## Non-goals (later specs)

- **Spec 2** — hand-tune the five existing built-ins for contrast and add new
  bold themes. This spec only gives them the automatic uplift from derived
  fallbacks + the `--card → --surface` remap.
- **Spec 3** — richer theme-builder UX: live preview, WCAG contrast readout,
  grouped-with-imagery editor. This spec only exposes the new fields.
- **Spec 4** — deliberate per-surface touchups across player skins / admin /
  landing that *consume* the ink ladder, lines, surfaces and second accent.

## Approach — additive typed tokens + derive-on-omit

Every token gains a **typed descriptor**:

```ts
type TokenType = 'color' | 'font' | 'grain' | 'length';
interface TokenDescriptor {
  key: string;        // "--surface"
  label: string;      // "surface" (builder label)
  group: 'surface' | 'text' | 'accent' | 'structure' | 'type' | 'texture';
  type: TokenType;
  fallback: string;   // CSS value used in :root when a theme omits the key
}
```

New tokens **derive from the base palette** in `globals.css :root` (and the dark
override) via `color-mix`, so omission is a first-class case, not a bug. All
derivations are **mode-agnostic** (they mix a base toward `--bg`/`--ink`, both of
which already flip in dark mode).

### Token set

Existing (unchanged, still authoritative when a theme sets them):
`--bg --ink --muted --accent --overlay --soft-border --field`.

New tokens (8), with their `:root` fallback/derivation:

| Token | Group | Type | Fallback / derivation | Purpose |
|---|---|---|---|---|
| `--ink-faint` | text | color | `color-mix(in oklab, var(--ink) 45%, var(--bg))` | tertiary text / captions (3rd ink rung; `--muted` stays the 2nd) |
| `--surface` | surface | color | `color-mix(in oklab, var(--bg) 93%, var(--ink))` | elevated card/panel bg that lifts off `--bg` |
| `--surface-border` | surface | color | `var(--soft-border)` | border around surfaces |
| `--line` | structure | color | `color-mix(in oklab, var(--ink) 70%, var(--bg))` | crisp hairline rule (distinct from the soft border) |
| `--accent-2` | accent | color | `var(--accent)` | secondary accent for two-colour themes |
| `--accent-soft` | accent | color | `color-mix(in oklab, var(--accent) 14%, var(--bg))` | accent-tinted background (hovers, pills, chips) |
| `--display-font` | type | font | `fraunces` | display/headline face id (see Fonts) |
| `--grain` | texture | grain | `0` | film-grain intensity `0–1` (0 = off) |

That is **15 themeable tokens** total. `--muted` is retained as the second ink
rung; the ladder reads `--ink` → `--muted` → `--ink-faint`.

### Immediate wiring in `globals.css`

- Add the eight fallbacks in `:root` (light) — the dark block needs no per-token
  override because every derivation is mode-agnostic.
- Remap shadcn roles: `--card: var(--surface)`, `--popover: var(--surface)`,
  `--card-foreground`/`--popover-foreground` stay `var(--ink)`. This is the
  app-wide depth win — every existing card/panel/dropdown lifts with **zero**
  component edits.
- Leave `--field`, `--overlay`, `--soft-border` as-is.

Existing themes and every `state/themes/*.json` user theme keep working
untouched and pick up the derived depth automatically.

## Fonts

`next/font` loads at build time, so a themeable font must be a **pick from a
curated, preloaded set**, never a free string.

- **Preload** a small display-font set in `web/app/layout.tsx` (latin subset,
  `display: swap`), each exposing a CSS var: `--font-fraunces` (default, already
  present as `--font-display`), `--font-doto` (the Volt dot-matrix face),
  `--font-space-grotesk`, `--font-instrument-serif`. Four to bound bundle
  weight; the set is a registry constant and easy to extend later.
- The theme JSON stores an **id**: `"--display-font": "doto"`, validated against
  the font allowlist.
- The apply layer (`web/lib/theme.ts` bootstrap **and** `ThemeBootstrap`)
  resolves id → family stack and writes the real CSS value, e.g.
  `--display-font: var(--font-doto), var(--font-mono), serif`.
- Components read `font-family: var(--display-font, var(--font-display))`.
- Body (`Plus Jakarta`) and mono (`JetBrains`) stay global and fixed — mono is
  data integrity; a `--body-font` token is a candidate for a later spec, called
  out but out of scope here.

## Grain

- `--grain` is a `0–1` intensity. A single shared `<Grain>` component (fixed,
  `pointer-events:none`, SVG `feTurbulence` tile, `mix-blend-mode: multiply` in
  light / `screen` in dark, `opacity: var(--grain)`) mounts once in each shell
  (player, admin, landing).
- `--grain: 0` (the default) → invisible, no cost beyond one empty element.
- Forced off under `html.lite` and `prefers-reduced-motion` — the tile is static
  so reduced-motion only needs the low-power gate, matching Volt's behaviour.

## Registry: single source of truth

The canonical registry lives in the controller
(`controller/src/theme-tokens.ts`, imported by `themes.ts`): the descriptor
array above plus the font allowlist. It drives:

- **Validation** — `themes.ts` builds its Zod schema and its value checks from
  the registry, per `type`:
  - `color` → existing `TOKEN_VAL_RE` (`^[^;{}<>]{1,100}$`);
  - `font` → must be an id in the font allowlist;
  - `grain` → number parseable in `[0,1]`;
  - `length` → bounded unit regex (reserved; no length tokens ship yet).
  Unknown keys are still silently dropped. This is **stricter** than today.
- **Defaults / README** — the `USER_THEMES_README` allowed-keys line and the
  seeded `state/themes/README.md` are generated from the registry.

The web side can't import a controller-package module, so it reads a
**generated mirror**: `web/lib/theme-tokens.generated.ts`, produced by
`npm run gen:theme-tokens` (a small script that serialises the registry), with a
CI check that regenerates and `git diff --exit-code`s — the same
generate-and-verify pattern the repo already uses for CLI compose assets. The
mirror replaces the duplicated `THEME_TOKEN_KEYS` in `web/lib/theme.ts`, the
`THEME_TOKENS` label list in `ThemeSection.tsx`, and the three `SWATCH_KEYS`
copies (`SWATCH_KEYS` becomes a registry-derived constant).

## Theme builder plumbing

`ThemeSection.tsx` renders fields by mapping the registry (grouped by `group`):

- `color` tokens → the existing swatch + text input;
- `font` token → a `<select>` of the font allowlist (label + the face rendered
  in its own font);
- `grain` token → a `0–1` slider.

New tokens therefore appear in the builder as soon as they exist — the "more
options" ask is satisfied by the registry, not bespoke UI. The four-swatch
mini-preview (`SWATCH_KEYS`) stays `bg / ink / accent / overlay`. Richer builder
UX (live preview, contrast meter) is Spec 3.

## Value delivered in this spec

1. 8 new tokens + derived fallbacks → every theme gains depth/hierarchy/lines.
2. `--card`/`--popover` → `--surface`: app-wide card lift, no component edits.
3. Theme-driven grain layer mounted in all shells (off by default).
4. One **demonstration built-in theme** that sets the new tokens end to end
   (surface, line, accent-2, `display-font: doto`, a touch of grain) so the
   system is provably working and there's an immediate "before/after".
5. Registry consolidation removes the 3× token duplication.

## Testing & verification

- **Pure unit tests** (`controller/scripts/theme-tokens.test.ts`, run via the
  existing `npm run test:*` pattern): per-type validation (color regex, font
  allowlist, grain range), font id → stack resolution, and that every registry
  token has a fallback.
- **Mirror-sync CI**: `gen:theme-tokens` + `git diff --exit-code` so
  `web/lib/theme-tokens.generated.ts` can't drift from the controller registry.
- **Lint gate**: `web` and `controller` `npm run lint` (eslint + tsc), the merge
  gate.
- **Manual**: apply the demo theme; screenshot player + admin; confirm surfaces
  lift, ink ladder reads, display font swaps, grain toggles; confirm an existing
  theme (Classic Light) is unchanged except for the automatic card lift.

## Risks & open questions

- **Font bundle weight** — four display faces add KB. Mitigated by latin-only
  subsets and `display: swap`; the set is a registry constant, trivially
  trimmed. Doto is variable (one file).
- **Derived surface in extreme palettes** — `--surface` mixing `--bg` toward
  `--ink` could be too subtle on very low-contrast themes; power themes override
  it, and Spec 2 hand-tunes the built-ins.
- **`mix-blend-mode` grain cost** — negligible at `opacity 0`; a full-viewport
  blended layer on weak GPUs is the reason it's gated by `lite`.
- **Open:** exact curated font list (proposed: Fraunces, Doto, Space Grotesk,
  Instrument Serif) and the demo theme's identity (new theme vs. dressing up an
  existing one) — both easy to adjust in review.

## Files touched

- `controller/src/theme-tokens.ts` (new) — registry + font allowlist.
- `controller/src/themes.ts` — registry-driven schema/validation, README gen.
- `web/lib/theme-tokens.generated.ts` (new, generated) + `scripts/gen-theme-tokens.*` + CI step.
- `web/lib/theme.ts` — read mirror; font id → stack resolution in the bootstrap.
- `web/app/globals.css` — fallbacks, `--card`/`--popover` → `--surface`.
- `web/app/layout.tsx` — preload curated display fonts.
- `web/components/admin/settings/ThemeSection.tsx` — registry-driven grouped fields, font select, grain slider.
- `web/components/ThemeSwitcher.tsx`, `web/components/admin/ShowPickers.tsx` — use registry `SWATCH_KEYS`.
- `web/components/Grain.tsx` (new) + mount in player/admin/landing shells.
- `controller/src/themes/builtin/<demo>.json` (new or updated) — demonstration theme.
- `controller/scripts/theme-tokens.test.ts` (new) — unit tests.
