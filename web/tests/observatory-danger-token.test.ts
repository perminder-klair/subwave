// The Observatory's "LAST RUN FAILED" line (#2314) reads var(--danger), which
// the admin defines only under .admin-root. /observatory renders outside that
// shell, so without its own definition the line shows in plain ink. Pins that
// .observatory-root defines the token for light and for both dark paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('../app/globals.css', import.meta.url)), 'utf8');

function definesDanger(selector: RegExp): boolean {
  const re = new RegExp(`${selector.source}\\s*\\{[^}]*--danger\\s*:`, 'm');
  return re.test(css);
}

test('the error line uses --danger', () => {
  assert.match(css, /\.observatory-root \.rail-proj-error\s*\{[^}]*var\(--danger\)/);
});

test('.observatory-root defines --danger in light and both dark paths', () => {
  assert.ok(definesDanger(/(^|\n)\.observatory-root/), 'light');
  assert.ok(definesDanger(/:root\[data-theme="dark"\] \.observatory-root/), 'dark by data-theme');
  assert.ok(
    /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\) \.observatory-root\s*\{[^}]*--danger\s*:/.test(css),
    'dark by system preference',
  );
});
