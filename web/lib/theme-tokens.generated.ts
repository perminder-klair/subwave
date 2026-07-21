// GENERATED FILE — do not edit by hand.
// Mirror of controller/src/theme-tokens.ts. Regenerate with:
//   cd controller && npm run gen:themes
// CI fails if this drifts from the controller registry.

export type TokenType = 'color' | 'font' | 'grain';
export type TokenGroup = 'surface' | 'text' | 'accent' | 'structure' | 'type' | 'texture';
export type FontSet = 'display' | 'mono';

export interface TokenDescriptor {
  key: string;
  label: string;
  group: TokenGroup;
  type: TokenType;
  fontSet?: FontSet;
}

export const THEME_TOKENS: readonly TokenDescriptor[] = [
  {
    "key": "--bg",
    "label": "background",
    "group": "surface",
    "type": "color"
  },
  {
    "key": "--surface",
    "label": "surface",
    "group": "surface",
    "type": "color"
  },
  {
    "key": "--surface-border",
    "label": "surface border",
    "group": "surface",
    "type": "color"
  },
  {
    "key": "--field",
    "label": "field",
    "group": "surface",
    "type": "color"
  },
  {
    "key": "--ink",
    "label": "text",
    "group": "text",
    "type": "color"
  },
  {
    "key": "--muted",
    "label": "muted text",
    "group": "text",
    "type": "color"
  },
  {
    "key": "--ink-faint",
    "label": "faint text",
    "group": "text",
    "type": "color"
  },
  {
    "key": "--accent",
    "label": "accent",
    "group": "accent",
    "type": "color"
  },
  {
    "key": "--accent-2",
    "label": "accent 2",
    "group": "accent",
    "type": "color"
  },
  {
    "key": "--accent-soft",
    "label": "accent tint",
    "group": "accent",
    "type": "color"
  },
  {
    "key": "--line",
    "label": "hairline",
    "group": "structure",
    "type": "color"
  },
  {
    "key": "--soft-border",
    "label": "soft border",
    "group": "structure",
    "type": "color"
  },
  {
    "key": "--overlay",
    "label": "overlay",
    "group": "structure",
    "type": "color"
  },
  {
    "key": "--display-font",
    "label": "display font",
    "group": "type",
    "type": "font",
    "fontSet": "display"
  },
  {
    "key": "--mono-font",
    "label": "mono font",
    "group": "type",
    "type": "font",
    "fontSet": "mono"
  },
  {
    "key": "--grain",
    "label": "grain",
    "group": "texture",
    "type": "grain"
  }
];

export const THEME_TOKEN_KEYS: readonly string[] = ["--bg","--surface","--surface-border","--field","--ink","--muted","--ink-faint","--accent","--accent-2","--accent-soft","--line","--soft-border","--overlay","--display-font","--mono-font","--grain"];

export const SWATCH_KEYS = ["--bg","--ink","--accent","--overlay"] as const;

export const DISPLAY_FONT_IDS = ["fraunces","doto","space-grotesk","instrument-serif","anton","chakra-petch","saira-stencil-one"] as const;
export type DisplayFontId = (typeof DISPLAY_FONT_IDS)[number];

export const MONO_FONT_IDS = ["jetbrains","ibm-plex-mono","space-mono","fira-code","courier-prime","overpass-mono"] as const;
export type MonoFontId = (typeof MONO_FONT_IDS)[number];
