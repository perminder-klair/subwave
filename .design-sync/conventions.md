# SUB/WAVE UI — build conventions

**Look**: "newsprint broadsheet meets hi-fi gear" — cream paper (`--bg: #f3efe6`), near-black ink, one hot-vermilion accent, **sharp corners everywhere** (radius is pinned to 0 — never use `rounded-*` classes), 1px ink borders instead of shadows, uppercase letter-spaced mono labels.

## Setup

Wrap the app once in `MotionProvider` (exported from the bundle): `Sheet` and `EditorDialog` animate via motion's `m.*` components and only animate inside it. Everything else needs no provider — theming is pure CSS variables. Dark mode: set `data-theme="dark"` on a root element; every token flips automatically.

## Styling idiom

Tailwind utility classes, but the stylesheet is **compiled** — only classes already present in it resolve; there is no JIT at render time. When in doubt, check `styles.css` → `_ds_bundle.css`, use the inline `style` prop, or use the CSS variables directly (always safe). Common layout utilities (`flex`, `grid`, `gap-*`, `p-*`/`px-*`, `items-center`, `justify-between`, `w-full`, `max-w-md`, `grid-cols-2`, `text-sm`/`text-xs`) are present.

Semantic classes (all verified in `_ds_bundle.css`):

| Family | Classes |
|---|---|
| Surfaces | `bg-bg` (paper), `bg-field` (input fill), `bg-overlay` (hover wash) |
| Text | `text-ink`, `text-muted`, `text-vermilion`, `text-foreground` |
| Borders | `border-ink` (strong 1px), `border-separator-soft`, `border-separator-strong` |
| Accent | `bg-primary` (vermilion fill), `text-vermilion` |
| Type | `font-mono` (JetBrains Mono — data/labels), `uppercase`, `font-bold`, `tracking-eyebrow` (0.2em) |
| Effects | `shadow-drawer` (the one sanctioned shadow — drawers/dialogs only) |

CSS variables (defined in `:root`, dark-mode aware): `--bg`, `--ink`, `--ink-soft` (hover wash), `--muted`, `--accent` (vermilion), `--field`, `--separator-soft`, `--separator-strong`, `--destructive`, `--drawer-shadow`, `--font-display` (Fraunces serif — headlines), `--font-sans` (Plus Jakarta Sans — body), `--font-mono`.

Signature motifs:
- **Eyebrow label** (section headers, form labels): `text-[10px] font-bold uppercase tracking-[0.2em] font-mono text-ink` — or just use the `Label` component.
- **Display headline**: `style={{ fontFamily: 'var(--font-display)' }}` — there is no `font-display` utility class; Fraunces is applied via the variable.
- Buttons/badges are self-styled — pick tone via `variant` (`default`/`solid`/`accent`/`destructive`/`ghost`/`link`), never restyle with color classes.

## Where the truth lives

Read `styles.css` (imports `_ds_bundle.css` — full compiled utilities + tokens + `@font-face`) before styling anything. Per-component API: `components/general/<Name>/<Name>.d.ts`; usage: `<Name>.prompt.md`. Compound pieces (SelectItem, FieldLabel, CommandInput, InputGroupAddon…) are documented in their parent's prompt.

## Idiomatic snippet

```jsx
import { Button, Field, FieldContent, FieldLabel, Input, V3Alert } from 'sub-wave-web';

<div className="bg-bg text-ink p-4" style={{ maxWidth: 420, display: 'grid', gap: 16 }}>
  <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 28 }}>Station settings</h2>
  <V3Alert title="heads up">The stream restarts ~3s after saving.</V3Alert>
  <Field>
    <FieldLabel>Station name</FieldLabel>
    <FieldContent><Input defaultValue="SUB/WAVE" /></FieldContent>
  </Field>
  <div style={{ display: 'flex', gap: 12 }}>
    <Button variant="accent">Save</Button>
    <Button variant="ghost">Cancel</Button>
  </div>
</div>
```
