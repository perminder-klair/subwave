// The single source of truth for SUB/WAVE's themeable CSS custom properties.
// The controller validates theme JSON against this; the web bundle reads a
// generated mirror (web/lib/theme-tokens.generated.ts, `npm run gen:themes`).
//
// Adding a token: a descriptor here AND a :root fallback in web/app/globals.css,
// then regenerate the mirror.

export type TokenType = 'color' | 'font' | 'grain' | 'keyword';
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
  /** For `type: 'keyword'` — which closed keyword set the value is drawn from. */
  keywordSet?: KeywordSet;
}

export type FontSet = 'display' | 'mono';
export type KeywordSet = 'texture' | 'finish';

// Curated display faces. The id is what a theme stores in --display-font; the
// web layer resolves it to a font-family stack (next/font variables live there).
export const DISPLAY_FONT_IDS = [
  'fraunces',
  'doto',
  'space-grotesk',
  'instrument-serif',
  'anton',
  'chakra-petch',
  'saira-stencil-one',
  'vt323',
  'bricolage-grotesque',
] as const;
export type DisplayFontId = (typeof DISPLAY_FONT_IDS)[number];

// Curated monospace faces for --mono-font. JetBrains is the default data face.
export const MONO_FONT_IDS = [
  'jetbrains',
  'ibm-plex-mono',
  'space-mono',
  'fira-code',
  'courier-prime',
  'overpass-mono',
  'dm-mono',
] as const;
export type MonoFontId = (typeof MONO_FONT_IDS)[number];

export function fontIdsFor(set: FontSet): readonly string[] {
  return set === 'mono' ? MONO_FONT_IDS : DISPLAY_FONT_IDS;
}

// A pattern laid over the player (--texture) and a filter pass over the whole
// player (--finish). Closed sets, because the web layer renders each value as a
// stylesheet rule keyed off a data attribute on <html> — CSS cannot branch on a
// custom property's value. Omitted = off, so there is no 'none'.
export const TEXTURE_IDS = ['scanline', 'halftone'] as const;
export type TextureId = (typeof TEXTURE_IDS)[number];

export const FINISH_IDS = ['bloom', 'misregister'] as const;
export type FinishId = (typeof FINISH_IDS)[number];

export function keywordIdsFor(set: KeywordSet): readonly string[] {
  return set === 'finish' ? FINISH_IDS : TEXTURE_IDS;
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
  { key: '--texture', label: 'texture', group: 'texture', type: 'keyword', keywordSet: 'texture' },
  { key: '--finish', label: 'finish', group: 'texture', type: 'keyword', keywordSet: 'finish' },
] as const;

export const THEME_TOKEN_KEYS: readonly string[] = THEME_TOKENS.map((t) => t.key);

// The four-swatch mini-preview shown on theme cards.
export const SWATCH_KEYS = ['--bg', '--ink', '--accent', '--overlay'] as const;

const TOKEN_BY_KEY = new Map(THEME_TOKENS.map((t) => [t.key, t]));

export function tokenType(key: string): TokenType | undefined {
  return TOKEN_BY_KEY.get(key)?.type;
}

// Rejects anything that could break out of the inline CSS variable assignment on
// document.documentElement.style: a ";" would close the property and let the rest
// declare arbitrary styles, "{}"/"<>" guard tag-shaped payloads. The 100-char cap
// covers every realistic colour value.
export const COLOR_VAL_RE = /^[^;{}<>]{1,100}$/;

// Colour → the safety regex. Font → a curated id, never a free font string.
// Grain → a number in [0,1]. Keyword → a member of its closed set. Unknown key →
// false.
export function isValidTokenValue(key: string, value: string): boolean {
  const desc = TOKEN_BY_KEY.get(key);
  switch (desc?.type) {
    case 'color':
      return COLOR_VAL_RE.test(value);
    case 'font':
      return fontIdsFor(desc.fontSet ?? 'display').includes(value);
    case 'keyword':
      return keywordIdsFor(desc.keywordSet ?? 'texture').includes(value);
    case 'grain': {
      const v = value.trim();
      // Plain decimal only: Number('') is 0 and Number('0x1') is 1, so a bare
      // Number() check waves both through.
      if (!/^\d*\.?\d+$/.test(v)) return false;
      const n = Number(v);
      return n >= 0 && n <= 1;
    }
    default:
      return false;
  }
}
