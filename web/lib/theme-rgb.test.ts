// watchTheme fires on any write to <html>'s theme attributes, changed or
// not, and a reader decides with sameThemeRgb whether there is work to redo
// — the TTY's painter rebuilds a whole glyph atlas when there is.
//
// Run: `npm test -- lib/theme-rgb`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { THEME_RGB_FALLBACK, sameThemeRgb, type ThemeRgb } from './theme-rgb';

test('two readings of the same colours are the same theme', () => {
  const copy: ThemeRgb = JSON.parse(JSON.stringify(THEME_RGB_FALLBACK));
  assert.ok(sameThemeRgb(THEME_RGB_FALLBACK, copy));
});

test('one channel of one token is a different theme', () => {
  for (const key of ['bg', 'ink', 'muted', 'accent', 'accent2'] as const) {
    const [r, g, b] = THEME_RGB_FALLBACK[key];
    const next = { ...THEME_RGB_FALLBACK, [key]: [r, g, b + 1] };
    assert.equal(sameThemeRgb(THEME_RGB_FALLBACK, next), false, key);
  }
});
