// Theme token registry — the single source of truth for the themeable CSS
// custom properties SUB/WAVE exposes. The controller validates theme JSON
// against this; the web bundle reads a generated mirror
// (web/lib/theme-tokens.generated.ts, produced by `npm run gen:themes`), so the
// no-flash bootstrap, the builder form and the swatch previews all follow one
// list instead of the three hand-maintained copies this replaces.
//
// Adding a token: add a descriptor here AND a :root fallback in
// web/app/globals.css (so themes that omit it inherit a derived value), then
// regenerate the mirror. Colour tokens can also earn a Tailwind bridge in the
// globals.css @theme block if components need a `bg-*/text-*/border-*` utility.

export type TokenType = 'color' | 'font' | 'grain';
export type TokenGroup =
  | 'surface'
  | 'text'
  | 'accent'
  | 'structure'
  | 'type'
  | 'texture';

export interface TokenDescriptor {
  /** CSS custom property, e.g. "--surface". */
  key: string;
  /** Human label for the builder form. */
  label: string;
  /** Grouping for the builder form. */
  group: TokenGroup;
  /** Governs how a theme-supplied value is validated + edited. */
  type: TokenType;
  /** For `type: 'font'` — which curated font set the value is drawn from. */
  fontSet?: FontSet;
}

export type FontSet = 'display' | 'mono';

// Curated display faces a theme may pick. `id` is what a theme stores in
// --display-font; the web layer resolves it to a font-family stack (the stacks
// reference next/font variables set in app/layout.tsx, so they live web-side).
export const DISPLAY_FONT_IDS = [
  'fraunces',
  'doto',
  'space-grotesk',
  'instrument-serif',
  'anton',
  'chakra-petch',
  'saira-stencil-one',
] as const;
export type DisplayFontId = (typeof DISPLAY_FONT_IDS)[number];

// Curated monospace faces for --mono-font — reaches the mono-forward skins
// (Subamp's LCD deck, the TTY terminal) and everything using the `font-mono`
// utility. JetBrains is the default data face.
export const MONO_FONT_IDS = [
  'jetbrains',
  'ibm-plex-mono',
  'space-mono',
  'fira-code',
  'courier-prime',
  'overpass-mono',
] as const;
export type MonoFontId = (typeof MONO_FONT_IDS)[number];

export function fontIdsFor(set: FontSet): readonly string[] {
  return set === 'mono' ? MONO_FONT_IDS : DISPLAY_FONT_IDS;
}

export const THEME_TOKENS: readonly TokenDescriptor[] = [
  // Surfaces / depth
  { key: '--bg', label: 'background', group: 'surface', type: 'color' },
  { key: '--surface', label: 'surface', group: 'surface', type: 'color' },
  { key: '--surface-border', label: 'surface border', group: 'surface', type: 'color' },
  { key: '--field', label: 'field', group: 'surface', type: 'color' },
  // Text / ink ladder (--ink > --muted > --ink-faint)
  { key: '--ink', label: 'text', group: 'text', type: 'color' },
  { key: '--muted', label: 'muted text', group: 'text', type: 'color' },
  { key: '--ink-faint', label: 'faint text', group: 'text', type: 'color' },
  // Accent
  { key: '--accent', label: 'accent', group: 'accent', type: 'color' },
  { key: '--accent-2', label: 'accent 2', group: 'accent', type: 'color' },
  { key: '--accent-soft', label: 'accent tint', group: 'accent', type: 'color' },
  // Structure
  { key: '--line', label: 'hairline', group: 'structure', type: 'color' },
  { key: '--soft-border', label: 'soft border', group: 'structure', type: 'color' },
  { key: '--overlay', label: 'overlay', group: 'structure', type: 'color' },
  // Type
  { key: '--display-font', label: 'display font', group: 'type', type: 'font', fontSet: 'display' },
  { key: '--mono-font', label: 'mono font', group: 'type', type: 'font', fontSet: 'mono' },
  // Texture
  { key: '--grain', label: 'grain', group: 'texture', type: 'grain' },
] as const;

export const THEME_TOKEN_KEYS: readonly string[] = THEME_TOKENS.map((t) => t.key);

// The four-swatch mini-preview shown on theme cards (paper / ink / accent /
// overlay) — mirrors the copies ThemeSwitcher + ShowPickers used to hardcode.
export const SWATCH_KEYS = ['--bg', '--ink', '--accent', '--overlay'] as const;

const TOKEN_BY_KEY = new Map(THEME_TOKENS.map((t) => [t.key, t]));

export function tokenType(key: string): TokenType | undefined {
  return TOKEN_BY_KEY.get(key)?.type;
}

// Reject anything that could break out of the inline CSS variable assignment
// once the browser writes it onto document.documentElement.style. A stray ";"
// would close the property and let the rest declare arbitrary styles; "{}"/"<>"
// guard against tag-shaped payloads. 100-char cap covers every realistic colour
// value (the longest is a color-mix() call).
export const COLOR_VAL_RE = /^[^;{}<>]{1,100}$/;

// Type-aware value validation. Colour → the safety regex. Font → one of the
// curated ids (never a free font string, so no unloaded-face FOUT and nothing
// exotic reaches the DOM). Grain → a number in [0,1]. Unknown key → false.
export function isValidTokenValue(key: string, value: string): boolean {
  const desc = TOKEN_BY_KEY.get(key);
  switch (desc?.type) {
    case 'color':
      return COLOR_VAL_RE.test(value);
    case 'font':
      return fontIdsFor(desc.fontSet ?? 'display').includes(value);
    case 'grain': {
      const v = value.trim();
      // Require a plain decimal — Number('') and Number('  ') are 0, and
      // Number('0x1') is 1, so a bare Number() check would wave those through.
      if (!/^\d*\.?\d+$/.test(v)) return false;
      const n = Number(v);
      return n >= 0 && n <= 1;
    }
    default:
      return false;
  }
}
