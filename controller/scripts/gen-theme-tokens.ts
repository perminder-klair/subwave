// Generates web/lib/theme-tokens.generated.ts from the controller theme-token
// registry, so the web builder form, the no-flash bootstrap and the swatch
// previews all read one list instead of hand-maintained copies. The web package
// can't import controller/src at build time (separate package + build context),
// hence a checked-in mirror kept honest by CI.
//
//   cd controller && npm run gen:themes
//
// The lint workflow re-runs this and `git diff --exit-code`s the output, so a
// registry change without a regenerate fails CI.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  THEME_TOKENS,
  THEME_TOKEN_KEYS,
  SWATCH_KEYS,
  DISPLAY_FONT_IDS,
  MONO_FONT_IDS,
} from '../src/theme-tokens.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'web', 'lib', 'theme-tokens.generated.ts');

const groups = [...new Set(THEME_TOKENS.map((t) => t.group))].map((g) => `'${g}'`).join(' | ');

const body = `// GENERATED FILE — do not edit by hand.
// Mirror of controller/src/theme-tokens.ts. Regenerate with:
//   cd controller && npm run gen:themes
// CI fails if this drifts from the controller registry.

export type TokenType = 'color' | 'font' | 'grain';
export type TokenGroup = ${groups};
export type FontSet = 'display' | 'mono';

export interface TokenDescriptor {
  key: string;
  label: string;
  group: TokenGroup;
  type: TokenType;
  fontSet?: FontSet;
}

export const THEME_TOKENS: readonly TokenDescriptor[] = ${JSON.stringify(THEME_TOKENS, null, 2)};

export const THEME_TOKEN_KEYS: readonly string[] = ${JSON.stringify(THEME_TOKEN_KEYS)};

export const SWATCH_KEYS = ${JSON.stringify([...SWATCH_KEYS])} as const;

export const DISPLAY_FONT_IDS = ${JSON.stringify([...DISPLAY_FONT_IDS])} as const;
export type DisplayFontId = (typeof DISPLAY_FONT_IDS)[number];

export const MONO_FONT_IDS = ${JSON.stringify([...MONO_FONT_IDS])} as const;
export type MonoFontId = (typeof MONO_FONT_IDS)[number];
`;

writeFileSync(OUT, body);
console.log(`wrote ${OUT}`);
