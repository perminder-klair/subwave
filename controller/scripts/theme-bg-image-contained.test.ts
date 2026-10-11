// The background image must not leak into a contained showcase (#1745 review).
//
// A showcase player stands in for ANOTHER station, but theme tokens live on
// <html> and belong to this one. Platter (.stage) and Subamp (.shell) paint
// var(--bg-image) on their own roots, so without a reset they showed this
// station's background in the other station's frame. The fix is one reset of
// the token on the contained shell root; it holds for a skin only while that
// skin reads the image through the token and never sets it itself. Pinned:
//
//  - shellClass() resets --bg-image when contained, and leaves the full-page
//    shell alone (the theme's own value must apply there);
//  - PlayerShell puts that class on the root every skin renders inside;
//  - Platter and Subamp paint the image only via var(--bg-image) with no
//    `background` shorthand on that rule, and no skin stylesheet sets the token.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const { shellClass, CONTAINED_SHELL_CLASS } = await import('../../web/components/player/shellClass.js');

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');
const read = (rel: string) => readFileSync(path.join(webDir, rel), 'utf8');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

test('a contained shell resets --bg-image; a full-page shell does not', () => {
  // Tailwind arbitrary property: compiles to `--bg-image: none` on the root.
  assert.equal(CONTAINED_SHELL_CLASS, '[--bg-image:none]');
  assert.equal(shellClass(true), CONTAINED_SHELL_CLASS);
  assert.equal(shellClass(false), '');
});

test('PlayerShell applies the style on the root the skin renders inside', () => {
  const src = read('components/player/PlayerShell.tsx');
  const root = src.indexOf('ref={rootRef}');
  const skin = src.indexOf('<Skin contained={contained}');
  const cls = src.indexOf('shellClass(contained)');
  assert.ok(root > 0 && skin > root, 'shell root and skin found');
  // Inside the root's className cn(...), i.e. before that tag closes.
  assert.ok(cls > root && cls < src.indexOf('\n      >', root) && cls < skin, 'class is on the shell root, above the skin');
});

// Declarations inside one CSS rule body, for the named selector.
function ruleBody(css: string, selector: string): string {
  const m = new RegExp(`(^|\\n)\\s*\\${selector}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `${selector} rule found`);
  return m[2];
}

for (const [skin, file, selector] of [
  ['Platter', 'components/skins/platter/Platter.module.css', '.stage'],
  ['Subamp', 'components/skins/subamp/Subamp.module.css', '.shell'],
] as const) {
  test(`${skin} paints its root image only through var(--bg-image)`, () => {
    const body = ruleBody(stripComments(read(file)), selector);
    assert.match(body, /background-image:\s*var\(--bg-image\b/);
    assert.doesNotMatch(body, /(^|[;\s])background\s*:/, 'no shorthand that would reset the image');
  });
}

test('no skin stylesheet sets --bg-image itself', () => {
  const skinsDir = path.join(webDir, 'components/skins');
  const files: string[] = [];
  for (const d of readdirSync(skinsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of readdirSync(path.join(skinsDir, d.name))) {
      if (f.endsWith('.css')) files.push(path.join(skinsDir, d.name, f));
    }
  }
  assert.ok(files.length >= 2, 'skin stylesheets found');
  for (const f of files) {
    const css = stripComments(readFileSync(f, 'utf8'));
    assert.doesNotMatch(css, /--bg-image\s*:/, `${path.basename(f)} sets --bg-image`);
  }
});
